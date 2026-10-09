import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import scheduleData from "../data/schedule.json";
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from "../src/push";
import { planReminders, relativeDay } from "../src/reminders";
import { dayNotes, occurrences, semesterWeek, type Schedule } from "../src/schedule";
import { utcToZoned, weekday, zonedToUtc } from "../src/time";

const s = scheduleData as Schedule;
const TZ = "Europe/Warsaw";

describe("time", () => {
  it("converts Warsaw wall time across the October DST switch", () => {
    expect(new Date(zonedToUtc("2026-10-20", "18:00", TZ)).toISOString()).toBe("2026-10-20T16:00:00.000Z");
    expect(new Date(zonedToUtc("2026-10-26", "18:00", TZ)).toISOString()).toBe("2026-10-26T17:00:00.000Z");
    expect(utcToZoned(Date.parse("2026-10-25T23:30:00Z"), TZ)).toEqual({ date: "2026-10-26", time: "00:30" });
  });
  it("knows weekdays", () => {
    expect(weekday("2026-10-05")).toBe(1);
    expect(weekday("2026-10-11")).toBe(7);
  });
});

describe("schedule", () => {
  it("puts the biweekly lecture on 5 Oct, 19 Oct, but not 12 Oct", () => {
    const pw = occurrences(s, "2026-10-05", "2026-10-25").filter((o) => o.sessionId === "pw-w").map((o) => o.date);
    expect(pw).toEqual(["2026-10-05", "2026-10-19"]);
  });
  it("skips days off and the Christmas break", () => {
    expect(occurrences(s, "2026-11-02", "2026-11-02")).toEqual([]);
    expect(occurrences(s, "2026-11-11", "2026-11-11")).toEqual([]);
    expect(occurrences(s, "2026-12-24", "2027-01-06")).toEqual([]);
    expect(occurrences(s, "2027-01-07", "2027-01-07").length).toBe(3);
    expect(dayNotes(s, "2026-11-09", "2026-11-13")).toEqual([{ date: "2026-11-11", label: "Independence Day" }]);
  });
  it("has 12 classes in a full week with the biweekly lecture", () => {
    expect(occurrences(s, "2026-10-19", "2026-10-25").length).toBe(12);
    expect(occurrences(s, "2026-10-12", "2026-10-18").length).toBe(11);
  });
  it("runs Monday classes on Thu 28 Jan and Wednesday classes on Fri 29 Jan", () => {
    expect(occurrences(s, "2027-01-28", "2027-01-28").map((o) => o.sessionId)).toEqual(["pw-w", "wo-w"]);
    expect(occurrences(s, "2027-01-29", "2027-01-29").map((o) => o.sessionId)).toEqual(["apoc-l", "apoc-w", "apsi-l"]);
  });
  it("counts semester weeks", () => {
    expect(semesterWeek(s, "2026-10-01")).toBe(1);
    expect(semesterWeek(s, "2026-10-09")).toBe(2);
    expect(semesterWeek(s, "2027-02-03")).toBeNull();
  });
});

describe("reminders", () => {
  const now = Date.parse("2026-10-20T10:00:00Z");
  it("fires N days before at the reminder time, in local time", () => {
    const r = planReminders("2026-10-28T23:59", [2, 1], "18:00", TZ, now);
    expect(r.map((x) => new Date(x.fireAt).toISOString())).toEqual([
      "2026-10-26T17:00:00.000Z",
      "2026-10-27T17:00:00.000Z",
    ]);
  });
  it("drops reminders in the past or not before the deadline", () => {
    expect(planReminders("2026-10-21T08:00", [5, 1, 0], "18:00", TZ, now).map((x) => x.offsetDays)).toEqual([1]);
  });
  it("describes relative days", () => {
    expect(relativeDay("2026-10-21", now, TZ)).toBe("tomorrow");
    expect(relativeDay("2026-10-25", now, TZ)).toBe("in 5 days");
  });
});

describe("web push", () => {
  it("produces a payload a browser can decrypt (RFC 8291)", async () => {
    const require = createRequire(import.meta.url);
    const ece = require("http_ece");
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
    const uaJwk = await crypto.subtle.exportKey("jwk", ua.privateKey);
    const authSecret = crypto.getRandomValues(new Uint8Array(16));

    const body = await encryptPayload(
      { endpoint: "https://web.push.apple.com/x", p256dh: b64urlEncode(uaPub), auth: b64urlEncode(authSecret) },
      new TextEncoder().encode('{"title":"Cześć"}'),
    );

    const { createECDH } = await import("node:crypto");
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(b64urlDecode(uaJwk.d!)));
    const plain = ece.decrypt(Buffer.from(body), {
      version: "aes128gcm",
      privateKey: ecdh,
      authSecret: Buffer.from(authSecret),
    });
    expect(plain.toString()).toBe('{"title":"Cześć"}');
  });

  it("signs a valid VAPID JWT", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const header = await vapidAuthorization("https://web.push.apple.com/abc", {
      publicKey: b64urlEncode(pub),
      privateKey: d!,
      subject: "mailto:a@b.c",
    });
    const [, t] = header.match(/t=([^,]+)/)!;
    const [h, c, sig] = t.split(".");
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      b64urlDecode(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c))).aud).toBe("https://web.push.apple.com");
  });
});
