// The doctor roster (clinux-frontend /registries/roster, modelled on the Swastik ABDM Connector's
// Doctor roster): which HPR-registered practitioners work at which of the clinic's HFR facilities.
// Not a paid-tier feature — like Operations, it is the facility's own registry data.
//
//   GET   /api/roster                    the clinic's roster (?facilityId=&includeLeft=1)
//   GET   /api/roster/facilities         facilities that have a roster (id + name)
//   POST  /api/roster                    add a practitioner: { facilityId, facilityName, attestation, role, designation?, department? }
//   PATCH /api/roster/:id                { status: 'left' | 'active', role?, designation?, department? }
//
// "HPR verified" is never taken from the browser: a practitioner is added only with an
// attestation clinuxflow-abdm-gateway signed after finding them in HPR (gateway
// src/lib/hprAttestation.js; same JWT_SECRET), for this clinic, still in date. Name and HPR ids
// come from the attestation, not the request.
import { Hono } from 'hono';
import { verify } from 'hono/jwt';
import { requireUser } from '../lib/shared/userAuth.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { can } from '../lib/shared/permissions.js';
import { recordAudit } from '../lib/shared/audit.js';

export const rosterRoutes = new Hono();
const app = rosterRoutes;

export const ROSTER_ROLES = ['doctor', 'nurse', 'pharmacist', 'other'];
const ROLE_OF_CATEGORY = { 1: 'doctor', 2: 'nurse', 6: 'pharmacist' };
const FACILITY_ID = /^IN[A-Z0-9]{10}$/;
const text = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

export function rosterEntry(r) {
    return {
        id: r.id, facilityId: r.facility_id, facilityName: r.facility_name,
        hprIdNumber: r.hpr_id_number, hprAddress: r.hpr_address, name: r.name, role: r.role,
        hprCategoryId: r.hpr_category_id, designation: r.designation, department: r.department,
        hprVerified: !!r.hpr_verified_at, hprVerifiedAt: r.hpr_verified_at,
        status: r.status, leftAt: r.left_at, addedAt: r.created_at, updatedAt: r.updated_at,
    };
}

/** The gateway's HPR attestation, if it is genuine, current and for this clinic; else throws. */
export async function acceptAttestation(token, secret, clinicId) {
    let payload;
    try {
        payload = await verify(String(token || ''), secret, 'HS256');
    } catch {
        throw new Error('The HPR check has expired or is not valid. Look the practitioner up again.');
    }
    if (payload?.kind !== 'hpr-attestation' || !payload.hprIdNumber) throw new Error('That is not an HPR check from the ABDM gateway.');
    if (payload.clinic !== clinicId) throw new Error('That HPR check was made for another clinic.');
    return payload;
}

async function mayManage(c) {
    const account = await AccountsDb.getAccountById(c.env.DB, c.get('user').accountId);
    return can(account?.role, 'roster:manage');
}

app.get('/api/roster', requireUser(), async (c) => {
    const { clinicId } = c.get('user');
    const { facilityId, includeLeft } = c.req.query();
    const where = ['clinic_id = ?'];
    const args = [clinicId];
    if (facilityId) { where.push('facility_id = ?'); args.push(facilityId); }
    if (includeLeft !== '1') where.push("status = 'active'");
    const { results } = await c.env.DB.prepare(`SELECT * FROM facility_practitioners WHERE ${where.join(' AND ')} ORDER BY status, name COLLATE NOCASE`).bind(...args).all();
    return c.json({ success: true, practitioners: results.map(rosterEntry), canManage: await mayManage(c) });
});

app.get('/api/roster/facilities', requireUser(), async (c) => {
    const { results } = await c.env.DB
        .prepare('SELECT facility_id, MAX(facility_name) AS facility_name, SUM(status = \'active\') AS active FROM facility_practitioners WHERE clinic_id = ? GROUP BY facility_id ORDER BY facility_name')
        .bind(c.get('user').clinicId)
        .all();
    return c.json({ success: true, facilities: results.map((r) => ({ facilityId: r.facility_id, facilityName: r.facility_name, active: Number(r.active) || 0 })) });
});

app.post('/api/roster', requireUser(), async (c) => {
    const user = c.get('user');
    if (!(await mayManage(c))) return c.json({ success: false, error: 'Your role can’t change the doctor roster.' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const facilityId = String(body.facilityId || '').trim().toUpperCase();
    if (!FACILITY_ID.test(facilityId)) return c.json({ success: false, error: 'Choose an HFR facility (an id like IN3310002300).' }, 400);

    let hpr;
    try {
        hpr = await acceptAttestation(body.attestation, c.env.JWT_SECRET, user.clinicId);
    } catch (err) {
        return c.json({ success: false, error: err.message }, 400);
    }
    const role = ROSTER_ROLES.includes(body.role) ? body.role : ROLE_OF_CATEGORY[hpr.categoryId] || 'other';

    const db = c.env.DB;
    const existing = await db.prepare('SELECT * FROM facility_practitioners WHERE clinic_id = ? AND facility_id = ? AND hpr_id_number = ?').bind(user.clinicId, facilityId, hpr.hprIdNumber).first();
    if (existing?.status === 'active') return c.json({ success: false, error: `${existing.name} is already on this facility’s roster.` }, 409);

    const values = [text(body.facilityName), hpr.hprId || null, hpr.name || hpr.hprIdNumber, role, hpr.categoryId || null, text(body.designation), text(body.department)];
    let id;
    if (existing) {
        // Someone who had left, joining again: the same row, verified afresh.
        id = existing.id;
        await db
            .prepare(`UPDATE facility_practitioners SET facility_name = COALESCE(?, facility_name), hpr_address = ?, name = ?, role = ?, hpr_category_id = ?, designation = ?, department = ?,
                      hpr_verified_at = datetime('now'), status = 'active', left_at = NULL, updated_at = datetime('now') WHERE id = ?`)
            .bind(...values, id)
            .run();
    } else {
        id = crypto.randomUUID();
        await db
            .prepare(`INSERT INTO facility_practitioners (id, clinic_id, facility_id, facility_name, hpr_id_number, hpr_address, name, role, hpr_category_id, designation, department, hpr_verified_at, added_by_account_id)
                      VALUES (?, ?, ?, COALESCE(?, ''), ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`)
            .bind(id, user.clinicId, facilityId, values[0], hpr.hprIdNumber, ...values.slice(1), user.accountId)
            .run();
    }
    await recordAudit(db, {
        clinicId: user.clinicId, actorAccountId: user.accountId, actorLabel: user.email, action: 'roster.practitioner_added',
        objectId: hpr.hprIdNumber, metadata: { hprId: hpr.hprId, facilityId, role },
    });
    const row = await db.prepare('SELECT * FROM facility_practitioners WHERE id = ?').bind(id).first();
    return c.json({ success: true, practitioner: rosterEntry(row) }, existing ? 200 : 201);
});

app.patch('/api/roster/:id', requireUser(), async (c) => {
    const user = c.get('user');
    if (!(await mayManage(c))) return c.json({ success: false, error: 'Your role can’t change the doctor roster.' }, 403);
    const db = c.env.DB;
    const row = await db.prepare('SELECT * FROM facility_practitioners WHERE id = ? AND clinic_id = ?').bind(c.req.param('id'), user.clinicId).first();
    if (!row) return c.json({ success: false, error: 'Not on this clinic’s roster.' }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (body.status && !['active', 'left'].includes(body.status)) return c.json({ success: false, error: 'status is active or left.' }, 400);
    if (body.role && !ROSTER_ROLES.includes(body.role)) return c.json({ success: false, error: `role is one of ${ROSTER_ROLES.join(', ')}.` }, 400);

    const status = body.status || row.status;
    await db
        .prepare(`UPDATE facility_practitioners SET status = ?, left_at = ?, role = ?, designation = ?, department = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(
            status,
            status === 'left' ? (row.status === 'left' ? row.left_at : new Date().toISOString().replace('T', ' ').slice(0, 19)) : null,
            body.role || row.role,
            body.designation !== undefined ? text(body.designation) : row.designation,
            body.department !== undefined ? text(body.department) : row.department,
            row.id,
        )
        .run();
    if (status !== row.status) {
        await recordAudit(db, {
            clinicId: user.clinicId, actorAccountId: user.accountId, actorLabel: user.email,
            action: status === 'left' ? 'roster.practitioner_left' : 'roster.practitioner_rejoined',
            objectId: row.hpr_id_number, metadata: { hprId: row.hpr_address, facilityId: row.facility_id, status },
        });
    }
    return c.json({ success: true, practitioner: rosterEntry(await db.prepare('SELECT * FROM facility_practitioners WHERE id = ?').bind(row.id).first()) });
});
