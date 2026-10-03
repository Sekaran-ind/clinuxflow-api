// Activity log (migrations/0016): privacy-significant state changes, metadata only.
//
// recordAudit() never throws and never blocks the action it records: a failed audit write is
// logged and dropped, the same "best effort, never roll back the real work" rule the usage
// metering already follows. sanitizeMetadata() keeps only short identifier/status values, so a
// caller can't accidentally (or a client deliberately, via POST /api/operations/audit) put a
// payload — an Aadhaar number, an OTP, demographics — into the log.

// Every action the log knows, with the label the Activity log shows and the object it is about.
// `client: true` marks the ones the browser may record through POST /api/operations/audit (things
// it does directly against ABDM via clinuxflow-abdm-gateway, which this Worker never sees).
export const AUDIT_ACTIONS = {
    'account.registered': { label: 'Account registered', object: 'account' },
    'account.signed_in': { label: 'Signed in', object: 'account' },
    'account.password_changed': { label: 'Password changed', object: 'account' },
    'account.password_reset': { label: 'Password reset with security question', object: 'account' },
    'account.security_question_set': { label: 'Security question set', object: 'account' },
    'clinic.renamed': { label: 'Clinic renamed', object: 'clinic' },
    'join_token.issued': { label: 'Join link issued', object: 'join_token' },
    'join_token.decided': { label: 'Join request decided', object: 'join_token' },
    'affiliate.revoked': { label: 'Affiliate removed', object: 'account' },
    'roster.practitioner_added': { label: 'Practitioner added to the doctor roster', object: 'practitioner' },
    'roster.practitioner_left': { label: 'Practitioner marked as left the facility', object: 'practitioner' },
    'roster.practitioner_rejoined': { label: 'Practitioner back on the doctor roster', object: 'practitioner' },
    'hpr.linked': { label: 'HPR ID linked', object: 'practitioner', client: true },
    'hpr.registered': { label: 'HPR ID registered', object: 'practitioner', client: true },
    'hfr.draft_saved': { label: 'Facility draft saved in HFR', object: 'facility', client: true },
    'hfr.submitted': { label: 'Facility submitted to HFR', object: 'facility', client: true },
    'abha.recorded': { label: 'ABHA recorded on a patient', object: 'patient', client: true },
    'abha.patient_created': { label: 'Patient created from ABHA', object: 'patient', client: true },
};

export const CLIENT_ACTIONS = Object.keys(AUDIT_ACTIONS).filter((a) => AUDIT_ACTIONS[a].client);

// Identifier/status keys a metadata object may carry, and how long a value may be. Anything
// else is dropped. ABHA numbers are kept masked to the last 4 digits.
const METADATA_KEYS = ['hprId', 'trackingId', 'facilityId', 'status', 'decision', 'role', 'abhaNumber', 'abhaAddress', 'recordId', 'kind', 'via', 'mode', 'tokenNumber'];
const MAX_VALUE = 80;

export function maskAbhaNumber(v) {
    const digits = String(v).replace(/\D/g, '');
    return digits.length >= 4 ? `xx-xxxx-xxxx-${digits.slice(-4)}` : undefined;
}

export function sanitizeMetadata(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const out = {};
    for (const key of METADATA_KEYS) {
        let v = meta[key];
        if (v === undefined || v === null || typeof v === 'object') continue;
        v = String(v).slice(0, MAX_VALUE);
        if (key === 'abhaNumber') v = maskAbhaNumber(v);
        if (v) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * @param {D1Database} db
 * @param {{ clinicId: string, actorAccountId?: string|null, actorLabel?: string, action: string,
 *           objectType?: string, objectId?: string, metadata?: object }} event
 */
export async function recordAudit(db, event) {
    try {
        if (!db || !event?.clinicId || !AUDIT_ACTIONS[event.action]) return;
        const metadata = sanitizeMetadata(event.metadata);
        await db
            .prepare(
                `INSERT INTO audit_events (id, clinic_id, actor_account_id, actor_label, action, object_type, object_id, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                crypto.randomUUID(), event.clinicId, event.actorAccountId ?? null, event.actorLabel || 'system', event.action,
                event.objectType ?? AUDIT_ACTIONS[event.action].object ?? null, event.objectId ? String(event.objectId).slice(0, MAX_VALUE) : null,
                metadata ? JSON.stringify(metadata) : null,
            )
            .run();
    } catch (err) {
        console.error('[audit] could not record', event?.action, err.message);
    }
}

const clampLimit = (n) => Math.min(Math.max(Number(n) || 50, 1), 200);

/** Newest first. `actorAccountId` limits to one person's own events. `before` is an ISO/D1 timestamp cursor. */
export async function listAuditEvents(db, { clinicId, actorAccountId, limit, before } = {}) {
    const where = ['clinic_id = ?'];
    const args = [clinicId];
    if (actorAccountId) { where.push('actor_account_id = ?'); args.push(actorAccountId); }
    if (before) { where.push('created_at < ?'); args.push(before); }
    const { results } = await db
        .prepare(`SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .bind(...args, clampLimit(limit))
        .all();
    return (results || []).map((r) => ({
        id: r.id,
        action: r.action,
        label: AUDIT_ACTIONS[r.action]?.label || r.action,
        objectType: r.object_type,
        objectId: r.object_id,
        actor: r.actor_label,
        actorAccountId: r.actor_account_id,
        metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
        at: r.created_at,
    }));
}

export async function listAbdmTransactions(db, { clinicId, accountId, limit, before } = {}) {
    const where = ['t.clinic_id = ?'];
    const args = [clinicId];
    if (accountId) { where.push('t.account_id = ?'); args.push(accountId); }
    if (before) { where.push('t.created_at < ?'); args.push(before); }
    const { results } = await db
        .prepare(
            `SELECT t.*, a.email AS actor_email FROM abdm_transactions t LEFT JOIN accounts a ON a.id = t.account_id
             WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT ?`,
        )
        .bind(...args, clampLimit(limit))
        .all();
    return (results || []).map((r) => ({
        id: r.id,
        service: r.service,
        operation: r.operation,
        httpStatus: r.http_status,
        ok: !!r.ok,
        abdmStatus: r.abdm_status,
        abdmRequestId: r.abdm_request_id,
        error: r.error,
        durationMs: r.duration_ms,
        accountId: r.account_id,
        actor: r.actor_email || null,
        at: r.created_at,
    }));
}
