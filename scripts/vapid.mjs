// Generates a VAPID key pair for Web Push.
//   npm run vapid
// Put the public key in wrangler.jsonc (VAPID_PUBLIC_KEY) and the private key in
// .dev.vars locally / `npx wrangler secret put VAPID_PRIVATE_KEY` in production.
const { subtle } = globalThis.crypto;
const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
const jwk = await subtle.exportKey("jwk", kp.privateKey);
const b64url = (u8) => Buffer.from(u8).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${b64url(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
