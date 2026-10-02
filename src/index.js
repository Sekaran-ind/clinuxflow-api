import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { serviceKeyAuth } from './lib/shared/serviceAuth.js';

// SPEC-24-adjacent (NIST ZTA discussion, session 2026-09-09) — this file used to be one ~1660-line
// list of every route. Routes are now split by layer into src/routes/*.js (auth/control/runtime/
// platform — see each file's own header for what belongs in it and why), and src/lib/ is split the
// same way (control/runtime/shared). This mirrors the SAME `app.route(prefix, subApp)` composition
// pattern clinuxflow-abdm-gateway's own src/index.js already uses for hpr/hfr/abha — proven,
// not invented here. Every sub-app is mounted at '/' (not a new prefix) so every route keeps its
// EXACT existing full path (e.g. '/api/auth/register' stays '/api/auth/register') — this is a
// pure internal reorganization, not a behavior or URL change; verified by the full test suite
// staying at the exact same pass count (278/278) before and after, plus a live curl smoke check of
// one route per module. The control/runtime split is the conceptual boundary the NIST Zero Trust
// Architecture discussion landed on: draw it as module structure now, at zero deploy/ops cost;
// defer any PHYSICAL service split to a real forcing function (ABDM production certification, a
// persisted FHIR store) that doesn't exist yet — see the clinux-nist-zta-three-layer-proposal
// memory note for the full reasoning.
import { authRoutes } from './routes/auth.js';
import { controlRoutes } from './routes/control.js';
import { runtimeRoutes } from './routes/runtime.js';
import { platformRoutes } from './routes/platform.js';
import { operationsRoutes } from './routes/operations.js';
import { provenanceRoutes } from './routes/provenance.js';
import { handleCuboTaskQueue } from './lib/control/cubo-task-queue-consumer.js';

export { ChatSignalingRoom } from './durable-objects/ChatSignalingRoom.js';

const app = new Hono();

// Locked down to clinux-frontend's real origins rather than wildcarded — this API fronts a
// paid Workers AI call (test-scribe) and a write endpoint (save-to-library), so an open CORS
// policy would let any webpage's JS call them on a visitor's behalf.
const ALLOWED_ORIGINS = [
    'https://clinux.yaxb.ai',
    'http://localhost:5173',
    // Capacitor's two platforms default to two DIFFERENT origins when no `server.androidScheme`
    // override is set in capacitor.config.json (confirmed against the actual config -- there is
    // none): iOS uses capacitor://localhost, Android uses https://localhost. Both are needed --
    // this isn't one scheme with two names, it's a real platform difference. http://localhost
    // (no port) is kept too for whatever local testing originally added it.
    'capacitor://localhost',
    'https://localhost',
    'http://localhost',
    // The Tauri desktop app's own shared LAN server (src-tauri/src/shared_server.rs) — pages it
    // serves call back into this API from that origin, not from clinux-frontend's normal dev/
    // prod origins above. Local dev port only; a production deployment would need whatever real
    // port the shared server binds to added here too.
    `http://localhost:47856`,
];
app.use('/api/*', cors({ origin: ALLOWED_ORIGINS }));

// See src/lib/shared/serviceAuth.js for what/why — unit tested there.
// /api/chat/signal is exempt: it's a WebSocket upgrade, and browsers' native WebSocket
// constructor cannot set custom headers (no way to send X-Service-Key), unlike every other
// route here which clinux-frontend reaches via apiFetch(). That route isn't left unauthenticated
// though — the session JWT in its own ?token= query param (verified inside the handler, same
// verifySessionToken() requireUser() uses) plus the staff/affiliate trust-boundary check take
// over as its access control instead. It also isn't the kind of cost/abuse surface SERVICE_KEY
// exists for in the first place (see this middleware's own comment) — no paid AI call, no
// unauthenticated write to a shared resource, just a relay between two already-authenticated,
// already-linked accounts.
app.use('/api/*', serviceKeyAuth({ exemptPaths: ['/api/chat/signal'] }));

// Registration order matters for Hono: both middlewares above must be registered BEFORE these
// route() calls so they apply to every mounted sub-app's routes too (confirmed against
// clinuxflow-abdm-gateway's own identical pattern, already running this way in production).
app.route('/', authRoutes);
app.route('/', controlRoutes);
app.route('/', runtimeRoutes);
app.route('/', platformRoutes);
app.route('/', operationsRoutes);
app.route('/', provenanceRoutes);

// A plain Hono app instance only ever implements `fetch` — a Queue consumer needs the Worker's
// default export to also carry a `queue(batch, env, ctx)` handler (docs/SPEC-26-FACILITY-JOIN-
// TOKEN-LINKING.md §6/§8's CUBO_TASK_QUEUE binding, wrangler.toml's own [[queues.consumers]] —
// named generically since it's meant to carry every future P2P-chat-triggered action, not just
// join-requests), which Hono itself doesn't provide. Attached directly to `app` (not a wrapper object) so
// `export default app` stays completely unchanged — every test in index.test.js calls Hono's own
// `app.request(...)` testing helper, which only exists on a real Hono instance, not a plain
// {fetch, queue} object.
app.queue = handleCuboTaskQueue;

export default app;
