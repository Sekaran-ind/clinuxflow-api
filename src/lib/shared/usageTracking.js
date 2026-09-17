// Per-clinic cloud-cost metering -- see docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md. Tracks the
// same units Cloudflare actually bills on (D1 rows written, D1 read-call counts, Workers AI
// calls) rather than an invented abstraction, so the numbers map onto real invoice line items.
// Aggregated into one row per (clinic, day, component) via the same ON CONFLICT ... DO UPDATE
// upsert idiom already used across this schema (see encounter-coordination-db.js), rather than
// one row per event -- logging every individual query would make the tracking writes themselves
// a meaningful chunk of the D1 cost being measured.
export const UsageTracking = {
    // component: 'd1_write' | 'd1_read' | 'workers_ai_call' today, extend freely -- see
    // migrations/0007. No-ops on a missing clinicId (health checks, anonymous calls) or a zero
    // quantity, since there's nothing to attribute in either case. Swallows its own errors --
    // metering is best-effort observability, not a hard dependency, and a tracking hiccup must
    // never fail the real clinical request that triggered it.
    async record(db, clinicId, component, quantity = 1) {
        if (!clinicId || !quantity) return;
        const today = new Date().toISOString().slice(0, 10);
        try {
            await db.prepare(
                `INSERT INTO clinic_usage_daily (clinic_id, date, component, quantity)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(clinic_id, date, component) DO UPDATE SET quantity = quantity + excluded.quantity`
            ).bind(clinicId, today, component, quantity).run();
        } catch (err) {
            console.error('[usageTracking] record failed:', err.message);
        }
    },

    // Records a write's REAL rows_written from D1's own result meta -- exact, not estimated,
    // since rows written is literally what Cloudflare bills on. Pass the object a .run() call
    // already returned (most of encounter-coordination-db.js's write functions return it
    // directly) rather than re-running the statement. Falls back to 1 if meta is missing (e.g. a
    // test double that doesn't shape its mock that far) so a write is never silently uncounted.
    async recordWrite(db, clinicId, runResult, component = 'd1_write') {
        await UsageTracking.record(db, clinicId, component, runResult?.meta?.rows_written ?? 1);
    },

    // D1 doesn't expose per-row read counts on .first()/.all() the way it does rows_written on
    // .run(), so this is a coarse per-call proxy (quantity 1) rather than an exact row count --
    // still a useful relative signal across clinics, just not invoice-exact the way recordWrite
    // is. Revisit if D1 ever surfaces read row counts on those calls.
    async recordRead(db, clinicId, component = 'd1_read') {
        await UsageTracking.record(db, clinicId, component, 1);
    },

    // Daily summary for one clinic over the last N days -- internal/admin use for now (see
    // GET /api/admin/usage-summary in index.js), the seed for pricing-model analysis rather than
    // a user-facing dashboard yet.
    async summaryForClinic(db, clinicId, days = 30) {
        const { results } = await db.prepare(
            `SELECT date, component, quantity FROM clinic_usage_daily
             WHERE clinic_id = ? AND date >= date('now', ?)
             ORDER BY date DESC, component`
        ).bind(clinicId, `-${days} days`).all();
        return results;
    },
};
