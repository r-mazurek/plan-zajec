import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access puts a signed JWT on every request it lets through.
// Verifying it here means the API stays closed even if someone reaches the
// Worker another way (e.g. the *.workers.dev URL, which Access doesn't cover).
// When ACCESS_TEAM_DOMAIN / ACCESS_AUD are not set (local dev), the check is skipped.

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksDomain = "";

export async function verifyAccess(
  req: Request,
  teamDomain: string | undefined,
  aud: string | undefined,
): Promise<boolean> {
  if (!teamDomain || !aud) return true;
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  const issuer = `https://${teamDomain.replace(/^https?:\/\//, "")}`;
  if (!jwks || jwksDomain !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksDomain = issuer;
  }
  try {
    await jwtVerify(token, jwks, { issuer, audience: aud });
    return true;
  } catch {
    return false;
  }
}
