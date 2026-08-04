import { sign, verify } from 'hono/jwt';

// Time-bound session per the "renewal" requirement — no refresh-token endpoint in this first
// pass; on expiry the frontend just re-prompts login.
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// payload: { sub: accountId, clinicId, email } — tier is deliberately NOT included; see
// requirePaidTier() in userAuth.js, which looks it up fresh from D1 on every gated call instead,
// so an upgrade/downgrade takes effect immediately without forcing re-login.
export async function issueSessionToken(payload, secret, ttlSeconds = SESSION_TTL_SECONDS) {
    const now = Math.floor(Date.now() / 1000);
    return sign({ ...payload, iat: now, exp: now + ttlSeconds }, secret, 'HS256');
}

// Throws (JwtTokenExpired / JwtTokenSignatureMismatched / JwtTokenInvalid, all from hono/jwt) on
// any failure — callers must catch, not just check falsiness.
export async function verifySessionToken(token, secret) {
    return verify(token, secret, 'HS256');
}
