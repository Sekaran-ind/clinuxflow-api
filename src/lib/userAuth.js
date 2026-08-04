import { verifySessionToken } from './session.js';
import { AccountsDb } from './accounts-db.js';

// Verifies the Bearer JWT issued by POST /api/auth/register|login and sets c.set('user', {...})
// for downstream handlers. This runs IN ADDITION TO serviceKeyAuth() (X-Service-Key proves "this
// is clinux-frontend"; requireUser proves "and this specific logged-in account") — it does not
// replace it. Fails closed exactly like serviceKeyAuth: missing/malformed/invalid token, or
// JWT_SECRET unset, => 401.
export function requireUser() {
    return async function requireUserMiddleware(c, next) {
        if (!c.env.JWT_SECRET) return c.json({ success: false, error: 'Unauthorized' }, 401);

        const authHeader = c.req.header('Authorization') || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return c.json({ success: false, error: 'Unauthorized' }, 401);

        try {
            const payload = await verifySessionToken(token, c.env.JWT_SECRET);
            c.set('user', { accountId: payload.sub, clinicId: payload.clinicId, email: payload.email });
        } catch {
            return c.json({ success: false, error: 'Unauthorized' }, 401);
        }
        return next();
    };
}

// Must run after requireUser() in the middleware chain (reads c.get('user') set there). Looks up
// the caller's clinic tier fresh from D1 on every request — not from the JWT — so a tier change
// takes effect immediately without forcing re-login. Binary gate: free tier = zero access, paid
// = full access.
export function requirePaidTier() {
    return async function requirePaidTierMiddleware(c, next) {
        const user = c.get('user');
        if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

        const clinic = await AccountsDb.getClinicById(c.env.DB, user.clinicId);
        if (!clinic || clinic.tier !== 'paid') {
            return c.json({ success: false, error: 'This feature requires a paid subscription.' }, 403);
        }
        return next();
    };
}
