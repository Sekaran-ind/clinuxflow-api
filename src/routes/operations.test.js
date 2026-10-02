import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../index.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { issueSessionToken } from '../lib/shared/session.js';
import { AUDIT_ACTIONS, CLIENT_ACTIONS, maskAbhaNumber, recordAudit, sanitizeMetadata } from '../lib/shared/audit.js';
import { PERMISSIONS, ROLE_PERMISSIONS, can, permissionsFor } from '../lib/shared/permissions.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';

/** A fake D1: records every statement + bindings; `rows` is what .all() returns. */
function fakeDb(rows = []) {
    const statements = [];
    return {
        statements,
        prepare(sql) {
            const st = { sql, args: [] };
            statements.push(st);
            return {
                bind(...args) { st.args = args; return this; },
                run: async () => ({ success: true }),
                all: async () => ({ results: rows }),
            };
        },
    };
}

const env = (DB) => ({ SERVICE_KEY, JWT_SECRET, DB, ENVIRONMENT: 'development' });
const token = (accountId = 'acc-1', clinicId = 'clinic-1', email = 'asha@example.in') => issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
const headers = async (extra = {}) => ({ 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${await token()}`, ...extra });

afterEach(() => vi.restoreAllMocks());

describe('audit metadata', () => {
    it('keeps only identifier/status keys and masks ABHA numbers', () => {
        expect(sanitizeMetadata({ hprId: 'asha@hpr.abdm', abhaNumber: '91-1111-2222-3333', aadhaar: '123412341234', otp: '123456', name: 'Asha', nested: { x: 1 } }))
            .toEqual({ hprId: 'asha@hpr.abdm', abhaNumber: 'xx-xxxx-xxxx-3333' });
        expect(sanitizeMetadata({ aadhaar: '1' })).toBeNull();
        expect(maskAbhaNumber('12')).toBeUndefined();
    });

    it('truncates long values', () => {
        expect(sanitizeMetadata({ status: 'x'.repeat(500) }).status).toHaveLength(80);
    });

    it('recordAudit never throws, and ignores unknown actions', async () => {
        await expect(recordAudit({ prepare: () => { throw new Error('D1 down'); } }, { clinicId: 'c', action: 'account.signed_in' })).resolves.toBeUndefined();
        const db = fakeDb();
        await recordAudit(db, { clinicId: 'c', action: 'something.made_up' });
        expect(db.statements).toEqual([]);
    });

    it('writes a sanitised row', async () => {
        const db = fakeDb();
        await recordAudit(db, { clinicId: 'c', actorAccountId: 'a', actorLabel: 'a@x', action: 'abha.recorded', objectId: 'rec-1', metadata: { abhaNumber: '91111122223333', aadhaar: '1234' } });
        const [, clinicId, actor, label, action, objectType, objectId, metadata] = db.statements[0].args;
        expect([clinicId, actor, label, action, objectType, objectId]).toEqual(['c', 'a', 'a@x', 'abha.recorded', 'patient', 'rec-1']);
        expect(JSON.parse(metadata)).toEqual({ abhaNumber: 'xx-xxxx-xxxx-3333' });
    });

    it('only registry outcomes may come from the browser', () => {
        expect(CLIENT_ACTIONS.sort()).toEqual(['abha.patient_created', 'abha.recorded', 'hfr.draft_saved', 'hfr.submitted', 'hpr.linked', 'hpr.registered']);
        expect(AUDIT_ACTIONS['account.signed_in'].client).toBeUndefined();
    });
});

describe('permissions', () => {
    it('gives every role the registries', () => {
        for (const role of Object.keys(ROLE_PERMISSIONS)) {
            for (const p of ['abha:write', 'hpr:write', 'hfr:write']) expect(can(role, p)).toBe(true);
        }
    });

    it('limits health professionals to their own activity', () => {
        expect(can('health_professional', 'activity:own')).toBe(true);
        expect(can('health_professional', 'activity:clinic')).toBe(false);
        expect(can('hospital_admin', 'activity:clinic')).toBe(true);
    });

    it('falls back to the default role, and every granted id is a real permission', () => {
        expect(permissionsFor(undefined)).toEqual(ROLE_PERMISSIONS.admin_and_health_professional);
        const ids = PERMISSIONS.map((p) => p.id);
        Object.values(ROLE_PERMISSIONS).flat().forEach((id) => expect(ids).toContain(id));
    });
});

describe('/api/operations', () => {
    it('401s without a session', async () => {
        const res = await app.request('/api/operations/audit', { headers: { 'X-Service-Key': SERVICE_KEY } }, env(fakeDb()));
        expect(res.status).toBe(401);
    });

    it('shows an admin the whole clinic', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-1', role: 'hospital_admin', clinic_id: 'clinic-1' });
        const db = fakeDb([{ id: 'e1', action: 'account.signed_in', actor_label: 'asha@example.in', created_at: '2026-10-02 09:00:00', metadata_json: null }]);
        const res = await app.request('/api/operations/audit', { headers: await headers() }, env(db));
        const body = await res.json();
        expect(body.scope).toBe('clinic');
        expect(body.events[0]).toMatchObject({ id: 'e1', label: 'Signed in', actor: 'asha@example.in' });
        expect(db.statements[0].sql).not.toContain('actor_account_id = ?');
        expect(db.statements[0].args[0]).toBe('clinic-1');
    });

    it('shows a health professional only their own events and ABDM calls', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-1', role: 'health_professional', clinic_id: 'clinic-1' });
        const db = fakeDb([]);
        const audit = await (await app.request('/api/operations/audit', { headers: await headers() }, env(db))).json();
        expect(audit.scope).toBe('own');
        expect(db.statements[0].sql).toContain('actor_account_id = ?');
        expect(db.statements[0].args).toEqual(['clinic-1', 'acc-1', 50]);

        const tx = await (await app.request('/api/operations/abdm-transactions?limit=500', { headers: await headers() }, env(db))).json();
        expect(tx.scope).toBe('own');
        expect(db.statements[1].sql).toContain('t.account_id = ?');
        expect(db.statements[1].args).toEqual(['clinic-1', 'acc-1', 200]); // limit clamped
    });

    it('records an allow-listed client event and refuses anything else', async () => {
        const db = fakeDb();
        const ok = await app.request('/api/operations/audit', { method: 'POST', headers: await headers(), body: JSON.stringify({ action: 'hfr.submitted', objectId: 'IN29', metadata: { facilityId: 'IN29', status: 'Pending' } }) }, env(db));
        expect(ok.status).toBe(201);
        expect(db.statements[0].args.slice(1, 5)).toEqual(['clinic-1', 'acc-1', 'asha@example.in', 'hfr.submitted']);

        const bad = await app.request('/api/operations/audit', { method: 'POST', headers: await headers(), body: JSON.stringify({ action: 'account.signed_in' }) }, env(db));
        expect(bad.status).toBe(400);
        expect(db.statements).toHaveLength(1);
    });

    it('returns the caller’s role, permissions and the full matrix', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-1', role: 'health_professional', clinic_id: 'clinic-1' });
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ name: 'Asha Clinic' });
        const body = await (await app.request('/api/operations/access', { headers: await headers() }, env(fakeDb()))).json();
        expect(body).toMatchObject({ role: 'health_professional', roleLabel: 'Health professional', clinicName: 'Asha Clinic' });
        expect(body.permissions).not.toContain('activity:clinic');
        expect(Object.keys(body.catalog.matrix)).toHaveLength(3);
    });
});

describe('audit hooks', () => {
    it('sign-in writes an account.signed_in event', async () => {
        const { hashPassword } = await import('../lib/shared/passwordHash.js');
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc-1', clinic_id: 'clinic-1', email: 'asha@example.in', password_hash: await hashPassword('password123'), status: 'active', role: 'hospital_admin' });
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ name: 'Asha Clinic', tier: 'free' });
        const db = fakeDb();
        const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY }, body: JSON.stringify({ email: 'asha@example.in', password: 'password123' }) }, env(db));
        expect(res.status).toBe(200);
        const insert = db.statements.find((s) => s.sql.includes('INSERT INTO audit_events'));
        expect(insert.args.slice(1, 5)).toEqual(['clinic-1', 'acc-1', 'asha@example.in', 'account.signed_in']);
    });
});

describe('entitlements.json', () => {
    it('every grant (account roles and HPR roles) names a real permission', async () => {
        const { PERMISSIONS: perms, ROLE_PERMISSIONS: byRole, HPR_ROLE_GRANTS } = await import('../lib/shared/permissions.js');
        const ids = new Set(perms.map((p) => p.id));
        for (const grants of [...Object.values(byRole), ...Object.values(HPR_ROLE_GRANTS)]) for (const g of grants) expect(ids.has(g), g).toBe(true);
        expect(Object.keys(HPR_ROLE_GRANTS)).toEqual(['Healthcare Professional', 'Facility Manager', 'Healthcare Professional and Facility Manager']);
    });
});
