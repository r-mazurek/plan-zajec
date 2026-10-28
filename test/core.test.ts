import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import scheduleData from "../data/schedule.json";
import { verifyAccess } from "../src/auth";
import { parseLinkUrl } from "../src/index";
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from "../src/push";
import { classesStartingSoon, planReminders, relativeDay, summaryMessage } from "../src/reminders";
import { applyChange, applyChanges, dayNotes, occurrences, semesterWeek, withRooms, type Schedule } from "../src/schedule";
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
  it("puts a biweekly class on 5 Oct, 19 Oct, but not 12 Oct", () => {
    const biweekly: Schedule = {
      ...s,
      sessions: s.sessions.map((x) => (x.id === "pw-w" ? { ...x, every: 2, anchor: "2026-10-05" } : x)),
    };
    const pw = occurrences(biweekly, "2026-10-05", "2026-10-25").filter((o) => o.sessionId === "pw-w").map((o) => o.date);
    expect(pw).toEqual(["2026-10-05", "2026-10-19"]);
  });
  it("skips days off and the Christmas break", () => {
    expect(occurrences(s, "2026-11-02", "2026-11-02")).toEqual([]);
    expect(occurrences(s, "2026-11-11", "2026-11-11")).toEqual([]);
    expect(occurrences(s, "2026-12-24", "2027-01-06")).toEqual([]);
    expect(occurrences(s, "2027-01-07", "2027-01-07").length).toBe(2);
    expect(dayNotes(s, "2026-11-09", "2026-11-13")).toEqual([{ date: "2026-11-11", label: "Independence Day" }]);
  });
  it("has 11 classes in a full week", () => {
    expect(occurrences(s, "2026-10-19", "2026-10-25").length).toBe(11);
    expect(occurrences(s, "2026-10-12", "2026-10-18").length).toBe(11);
  });
  it("runs Monday classes on Thu 28 Jan and Wednesday classes on Fri 29 Jan", () => {
    expect(occurrences(s, "2027-01-28", "2027-01-28").map((o) => o.sessionId)).toEqual(["pw-w", "wo-w"]);
    expect(occurrences(s, "2027-01-29", "2027-01-29").map((o) => o.sessionId)).toEqual(["apoc-l", "apoc-w", "apsi-l"]);
  });
  it("uses rooms changed for every week, keeping the rest of the timetable", () => {
    const moved = withRooms(s, new Map([["pw-w", "9.99"]]));
    const week = occurrences(moved, "2026-10-19", "2026-10-25");
    expect(week.filter((o) => o.sessionId === "pw-w").map((o) => o.room)).toEqual(["9.99"]);
    const other = (x: typeof week) => x.filter((o) => o.sessionId !== "pw-w").map((o) => o.room);
    expect(other(week)).toEqual(other(occurrences(s, "2026-10-19", "2026-10-25")));
    expect(withRooms(s, new Map())).toBe(s);
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

describe("auth", () => {
  const req = new Request("https://plan.example/api/tasks");
  it("refuses requests when Cloudflare Access isn't configured", async () => {
    expect(await verifyAccess(req, undefined, undefined)).toBe(false);
  });
  it("lets requests through only when auth is explicitly disabled for local dev", async () => {
    expect(await verifyAccess(req, undefined, undefined, "1")).toBe(true);
  });
  it("refuses requests without an Access token once configured", async () => {
    expect(await verifyAccess(req, "team.cloudflareaccess.com", "aud")).toBe(false);
  });
});

describe("links", () => {
  it("adds https:// to bare addresses", () => {
    expect(parseLinkUrl("github.com/pw/labs")).toBe("https://github.com/pw/labs");
    expect(parseLinkUrl("  http://example.edu.pl ")).toBe("http://example.edu.pl/");
  });
  it("rejects anything that isn't a web address", () => {
    expect(() => parseLinkUrl("")).toThrow();
    expect(() => parseLinkUrl("javascript:alert(1)")).toThrow();
    expect(() => parseLinkUrl("notes")).toThrow();
  });
});

describe("class alerts", () => {
  const sched = scheduleData as Schedule;
  const all = occurrences(sched, sched.semester.classesFrom, sched.semester.classesTo);
  const pick = (mandatory: boolean) => all.find((o) => o.mandatory === mandatory && !all.some((x) => x !== o && x.date === o.date && x.start === o.start))!;
  const at = (o: { date: string; start: string }, minsBefore: number) =>
    zonedToUtc(o.date, o.start, "Europe/Warsaw") - minsBefore * 60_000;

  it("picks classes starting in exactly 15 minutes, once per quarter-hour run", () => {
    const o = pick(true);
    expect(classesStartingSoon(all, "all", at(o, 15), "Europe/Warsaw").map((x) => x.id)).toContain(o.id);
    expect(classesStartingSoon(all, "all", at(o, 30), "Europe/Warsaw").map((x) => x.id)).not.toContain(o.id);
    expect(classesStartingSoon(all, "all", at(o, 0), "Europe/Warsaw").map((x) => x.id)).not.toContain(o.id);
  });
  it("skips non-mandatory classes in mandatory-only mode and everything when off", () => {
    const opt = pick(false);
    expect(classesStartingSoon(all, "all", at(opt, 15), "Europe/Warsaw").map((x) => x.id)).toContain(opt.id);
    expect(classesStartingSoon(all, "mandatory", at(opt, 15), "Europe/Warsaw").map((x) => x.id)).not.toContain(opt.id);
    expect(classesStartingSoon(all, "off", at(pick(true), 15), "Europe/Warsaw")).toEqual([]);
  });
  it("skips cancelled classes", () => {
    const o = pick(true);
    const list = applyChanges(all, new Map([[o.id, { occurrenceId: o.id, cancelled: true, room: null, start: null, end: null, note: null }]]));
    expect(classesStartingSoon(list, "all", at(o, 15), "Europe/Warsaw").map((x) => x.id)).not.toContain(o.id);
  });
});

describe("class changes", () => {
  const sched = scheduleData as Schedule;
  const o = occurrences(sched, sched.semester.classesFrom, sched.semester.classesTo).find((x) => x.room)!;
  const none = { occurrenceId: o.id, cancelled: false, room: null, start: null, end: null, note: null };

  it("replaces the room and time and remembers the timetable's values", () => {
    const c = applyChange(o, { ...none, room: "2.14", start: "15:00", end: "17:00" });
    expect([c.room, c.start, c.end]).toEqual(["2.14", "15:00", "17:00"]);
    expect(c.was).toEqual({ room: o.room, start: o.start, end: o.end });
  });
  it("leaves fields that weren't changed alone", () => {
    const c = applyChange(o, { ...none, cancelled: true, note: "Teacher is ill" });
    expect(c).toMatchObject({ cancelled: true, changeNote: "Teacher is ill", room: o.room, start: o.start });
    expect(c.was).toBeUndefined();
  });
});

describe("morning summary", () => {
  const sched = scheduleData as Schedule;
  const all = occurrences(sched, sched.semester.classesFrom, sched.semester.classesTo);
  const day = all.find((o) => all.filter((x) => x.date === o.date).length >= 2)!.date;
  const classes = all.filter((o) => o.date === day);
  const name = (id: string) => id.toUpperCase();

  it("lists the day's span, the first class and what's due", () => {
    const msg = summaryMessage(classes, [{ title: "Lab report 3", kind: "assignment", dueAt: `${day}T23:59` }], name)!;
    expect(msg.title).toBe(`Today: ${classes.length} classes, ${classes[0].start}–${classes.at(-1)!.end}`);
    expect(msg.body).toContain(`First: ${name(classes[0].subject)}`);
    expect(msg.body).toContain("Due today: Lab report 3");
  });
  it("mentions cancelled classes and leaves them out of the count", () => {
    const [first, ...rest] = classes;
    const msg = summaryMessage([{ ...first, cancelled: true }, ...rest], [], name)!;
    expect(msg.title).toContain(`${rest.length} class`);
    expect(msg.body).toContain(`Cancelled: ${name(first.subject)}`);
  });
  it("stays quiet on an empty day", () => {
    expect(summaryMessage([], [], name)).toBeNull();
  });
});
