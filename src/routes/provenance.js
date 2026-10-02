// Provenance published from clinux-frontend — paid plan only (requirePaidTier): provenance is
// built and kept on the device (clinux-frontend src/provenance/), and a paid clinic's devices
// publish it here. A free clinic never calls this, so provenance costs the server nothing for it.
//
//   POST /api/provenance        { resources: Provenance[] (max 100) } -> { stored }
//   GET  /api/provenance?target= the clinic's published provenance, newest first (?limit=)
// Idempotent: a resource already stored (same id) is ignored, so a device can safely re-send.
import { Hono } from 'hono';
import { requireUser, requirePaidTier } from '../lib/shared/userAuth.js';

export const provenanceRoutes = new Hono();
const app = provenanceRoutes;

const MAX_BATCH = 100;
const MAX_RESOURCE_BYTES = 8 * 1024;

const targetKey = (t) => t?.reference || (t?.identifier ? `${t.identifier.system}|${t.identifier.value}` : null);

/** The minimal shape every published Provenance must have (ClinuxFlowProvenance's required parts). */
export function provenanceProblems(r) {
    const problems = [];
    if (r?.resourceType !== 'Provenance') problems.push('resourceType must be Provenance');
    if (!r?.id || typeof r.id !== 'string' || r.id.length > 64) problems.push('id is required');
    if (!Array.isArray(r?.target) || !r.target.length || !targetKey(r.target[0])) problems.push('at least one target is required');
    if (!r?.recorded) problems.push('recorded is required');
    if (!Array.isArray(r?.agent) || !r.agent[0]?.who || !r.agent[0]?.onBehalfOf) problems.push('agent with who and onBehalfOf is required');
    if (JSON.stringify(r || {}).length > MAX_RESOURCE_BYTES) problems.push('resource is too large');
    return problems;
}

app.post('/api/provenance', requireUser(), requirePaidTier(), async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ success: false, error: 'Body must be JSON.' }, 400); }
    const resources = Array.isArray(body?.resources) ? body.resources : [];
    if (!resources.length || resources.length > MAX_BATCH) return c.json({ success: false, error: `Send 1 to ${MAX_BATCH} Provenance resources.` }, 400);
    const invalid = resources.map((r, i) => [i, provenanceProblems(r)]).filter(([, p]) => p.length);
    if (invalid.length) return c.json({ success: false, error: 'Invalid Provenance.', details: invalid.map(([i, p]) => ({ index: i, problems: p })) }, 400);
    const { clinicId, accountId } = c.get('user');
    const statements = resources.map((r) => c.env.DB
        .prepare('INSERT OR IGNORE INTO provenance_records (id, clinic_id, account_id, target, activity, recorded, resource_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(r.id, clinicId, accountId, targetKey(r.target[0]), r.activity?.coding?.[0]?.code ?? null, r.recorded, JSON.stringify(r)));
    await c.env.DB.batch(statements);
    return c.json({ success: true, stored: resources.length }, 201);
});

app.get('/api/provenance', requireUser(), requirePaidTier(), async (c) => {
    const { clinicId } = c.get('user');
    const { target, limit } = c.req.query();
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const stmt = target
        ? c.env.DB.prepare('SELECT resource_json FROM provenance_records WHERE clinic_id = ? AND target = ? ORDER BY recorded DESC LIMIT ?').bind(clinicId, target, n)
        : c.env.DB.prepare('SELECT resource_json FROM provenance_records WHERE clinic_id = ? ORDER BY recorded DESC LIMIT ?').bind(clinicId, n);
    const { results } = await stmt.all();
    return c.json({ success: true, resources: (results || []).map((r) => JSON.parse(r.resource_json)) });
});
