import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import app from '../index.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { issueSessionToken } from '../lib/shared/session.js';
import { can } from '../lib/shared/permissions.js';
import { d1 } from '../testing/d1Sqlite.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';
let db, env, role;

// What clinuxflow-abdm-gateway's POST /hpr/search signs (src/lib/hprAttestation.js).
const attestation = (claims = {}, secret = JWT_SECRET) => {
    const iat = Math.floor(Date.now() / 1000);
    return sign({ kind: 'hpr-attestation', clinic: 'clinic-1', hprIdNumber: '71-0285-6047-2578', hprId: 'prabu.segaran@hpr.abdm', name: 'Prabu Segaran', categoryId: '1', iat, exp: iat + 1800, ...claims }, secret, 'HS256');
};
const headers = async (clinicId = 'clinic-1') => ({ 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${await issueSessionToken({ sub: 'acc-1', clinicId, email: 'a@x.in' }, JWT_SECRET)}` });
const call = async (path, { method = 'GET', body, clinicId } = {}) => app.request(path, { method, headers: await headers(clinicId), ...(body ? { body: JSON.stringify(body) } : {}) }, env);
const add = async (extra = {}) => call('/api/roster', { method: 'POST', body: { facilityId: 'IN3310002300', facilityName: 'tsekaran1949s Clinic', attestation: await attestation(), ...extra } });

beforeEach(() => {
    db = d1(['0016_add_audit_events_and_abdm_transactions.sql', '0018_add_doctor_roster_and_scan_share.sql']);
    env = { SERVICE_KEY, JWT_SECRET, DB: db, ENVIRONMENT: 'development' };
    role = 'hospital_admin';
    vi.spyOn(AccountsDb, 'getAccountById').mockImplementation(async () => ({ id: 'acc-1', role }));
});
afterEach(() => vi.restoreAllMocks());

describe('doctor roster', () => {
    it('adds a practitioner from the gateway’s HPR check, never from what the browser says', async () => {
        const res = await add({ name: 'Someone Else', hprIdNumber: '71-9999-9999-9999' });
        expect(res.status).toBe(201);
        const { practitioner } = await res.json();
        expect(practitioner).toMatchObject({ facilityId: 'IN3310002300', hprIdNumber: '71-0285-6047-2578', hprAddress: 'prabu.segaran@hpr.abdm', name: 'Prabu Segaran', role: 'doctor', hprVerified: true, status: 'active' });
        const audit = db.raw.prepare('SELECT action, object_id FROM audit_events').all();
        expect(audit).toEqual([{ action: 'roster.practitioner_added', object_id: '71-0285-6047-2578' }]);
    });

    it('refuses forged, expired, wrong-clinic or non-attestation tokens', async () => {
        const bad = [
            await attestation({}, 'not-the-secret'),
            await attestation({ exp: 1 }),
            await attestation({ clinic: 'clinic-2' }),
            await attestation({ kind: 'something-else' }),
            await issueSessionToken({ sub: 'acc-1', clinicId: 'clinic-1' }, JWT_SECRET),
        ];
        for (const att of bad) expect((await add({ attestation: att })).status).toBe(400);
        expect((await add({ facilityId: 'nope' })).status).toBe(400);
        expect(db.raw.prepare('SELECT COUNT(*) AS n FROM facility_practitioners').get().n).toBe(0);
    });

    it('an attestation is not a session', async () => {
        const res = await app.request('/api/roster', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${await attestation()}` } }, env);
        expect(res.status).toBe(401);
    });

    it('lists per facility, hides who has left unless asked, and lets them rejoin', async () => {
        const { practitioner } = await (await add()).json();
        expect((await add()).status).toBe(409);
        const left = await (await call(`/api/roster/${practitioner.id}`, { method: 'PATCH', body: { status: 'left' } })).json();
        expect(left.practitioner).toMatchObject({ status: 'left' });
        expect(left.practitioner.leftAt).toBeTruthy();
        expect((await (await call('/api/roster?facilityId=IN3310002300')).json()).practitioners).toEqual([]);
        expect((await (await call('/api/roster?facilityId=IN3310002300&includeLeft=1')).json()).practitioners).toHaveLength(1);
        const back = await add({ role: 'other', designation: 'Visiting consultant' });
        expect(back.status).toBe(200);
        expect((await back.json()).practitioner).toMatchObject({ id: practitioner.id, status: 'active', role: 'other', designation: 'Visiting consultant', leftAt: null });
        expect(db.raw.prepare('SELECT action FROM audit_events ORDER BY rowid').all().map((r) => r.action)).toEqual(['roster.practitioner_added', 'roster.practitioner_left', 'roster.practitioner_added']);
        const facilities = await (await call('/api/roster/facilities')).json();
        expect(facilities.facilities).toEqual([{ facilityId: 'IN3310002300', facilityName: 'tsekaran1949s Clinic', active: 1 }]);
    });

    it('keeps each clinic’s roster to itself', async () => {
        const { practitioner } = await (await add()).json();
        expect((await (await call('/api/roster', { clinicId: 'clinic-2' })).json()).practitioners).toEqual([]);
        expect((await call(`/api/roster/${practitioner.id}`, { method: 'PATCH', body: { status: 'left' }, clinicId: 'clinic-2' })).status).toBe(404);
    });

    it('only roles with roster:manage may change it; everyone may read', async () => {
        role = 'health_professional';
        expect(can(role, 'roster:manage')).toBe(false);
        expect((await add()).status).toBe(403);
        const list = await (await call('/api/roster')).json();
        expect(list).toMatchObject({ success: true, canManage: false });
    });
});
