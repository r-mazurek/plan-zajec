// Web Push for Cloudflare Workers using only WebCrypto.
// VAPID: RFC 8292. Payload encryption: RFC 8291 (aes128gcm, RFC 8188).

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateKey: string; // base64url, 32-byte scalar
  subject: string; // mailto: or https: contact
}

const enc = new TextEncoder();

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function vapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(keys.publicKey);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65)),
      d: keys.privateKey,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })),
  );
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await vapidPrivateKey(keys),
    enc.encode(unsigned),
  );
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

/** Encrypt `payload` for one subscription as a single aes128gcm record. */
export async function encryptPayload(sub: PushSubscriptionRecord, payload: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);

  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 section 3.4
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);

  // RFC 8188 section 2.2 / 2.3
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const record = concat(payload, new Uint8Array([2])); // 0x02 = last record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/** Sends one notification. Returns the push service's HTTP status (201 = accepted, 404/410 = subscription gone). */
export async function sendPush(
  sub: PushSubscriptionRecord,
  message: PushMessage,
  keys: VapidKeys,
  ttlSeconds = 24 * 3600,
): Promise<number> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, keys),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
    },
    body,
  });
  return res.status;
}
