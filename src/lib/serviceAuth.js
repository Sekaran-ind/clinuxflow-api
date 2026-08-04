// Shared-secret gate: clinux-frontend is the only intended caller of the routes this guards.
// CORS alone only stops browser-originated cross-origin requests — it does nothing against a
// script or curl hitting this Worker's URL directly, which is the actual risk for test-scribe
// (real Workers AI cost per call) and save-to-library (unauthenticated write to the shared forms
// library). Fails closed if SERVICE_KEY isn't configured — an empty/missing secret must never be
// treated as "auth disabled".
//
// @param {{ exemptPaths?: string[] }} [options] - paths that skip the gate entirely.
// @returns {import('hono').MiddlewareHandler}
export function serviceKeyAuth({ exemptPaths = [] } = {}) {
    return async function serviceKeyAuthMiddleware(c, next) {
        if (exemptPaths.includes(c.req.path)) return next();
        const key = c.req.header('X-Service-Key');
        if (!c.env.SERVICE_KEY || key !== c.env.SERVICE_KEY) {
            return c.json({ success: false, error: 'Unauthorized' }, 401);
        }
        return next();
    };
}
