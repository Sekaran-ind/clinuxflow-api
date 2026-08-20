import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import app from './index.js';
import { AccountsDb } from './lib/accounts-db.js';
import { hashPassword } from './lib/passwordHash.js';
import { RealtimeClient } from './lib/realtime-client.js';
import { EncounterMeetingsDb } from './lib/encounter-meetings-db.js';
import { EncounterCoordinationDb } from './lib/encounter-coordination-db.js';
import { UsageTracking } from './lib/usageTracking.js';
import { WikidataTagging, WikidataRateLimitError } from './lib/wikidataTagging.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';
const baseEnv = { SERVICE_KEY, JWT_SECRET, DB: {}, WIKIDATA_CACHE: {}, ENVIRONMENT: 'development' };

afterEach(() => vi.restoreAllMocks());

describe('POST /api/auth/register', () => {
    it('401s without X-Service-Key — the new auth routes still sit behind the existing gate', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clinicName: 'C', email: 'a@b.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on missing fields', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('400s on a too-short password', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'C', email: 'a@b.com', password: 'short' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('201s with a token and a free-tier account on success', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'City Clinic', email: 'New@Example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.token).toBeTypeOf('string');
        expect(body.account).toMatchObject({ email: 'new@example.com', clinicName: 'City Clinic', tier: 'free' });
    });

    it('409s on a duplicate email', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'existing' });

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'C', email: 'a@b.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it("400s on an invalid facilityType", async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'C', email: 'a@b.com', password: 'password123', facilityType: 'hospital' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("passes facilityType 'individual' through to AccountsDb and the response", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const createSpy = vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({
                clinicName: 'Dr. Solo', email: 'solo@example.com', password: 'password123', facilityType: 'individual',
            }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.account.facilityType).toBe('individual');
        expect(createSpy).toHaveBeenCalledWith(
            baseEnv.DB, expect.any(String), 'Dr. Solo', expect.any(String), 'solo@example.com',
            expect.any(String), undefined, undefined, 'individual'
        );
    });

    it("defaults facilityType to 'facility' when omitted, unchanged from before", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'City Clinic', email: 'facility@example.com', password: 'password123' }),
        }, baseEnv);

        const body = await res.json();
        expect(body.account.facilityType).toBe('facility');
    });
});

describe('POST /api/auth/login', () => {
    it('401s on an unknown email', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);

        const res = await app.request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'nope@example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('401s on the wrong password against a real hash', async () => {
        const passwordHash = await hashPassword('correct-password');
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({
            id: 'acc1', clinic_id: 'clinic1', email: 'a@b.com', password_hash: passwordHash,
        });

        const res = await app.request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'wrong-password' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('200s with a token and the clinic tier on success', async () => {
        const passwordHash = await hashPassword('correct-password');
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({
            id: 'acc1', clinic_id: 'clinic1', email: 'a@b.com', password_hash: passwordHash,
            admin_name: 'Dr A', designation: 'Doctor',
        });
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', name: 'City Clinic', tier: 'paid' });

        const res = await app.request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'correct-password' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.token).toBeTypeOf('string');
        expect(body.account).toMatchObject({ id: 'acc1', clinicId: 'clinic1', clinicName: 'City Clinic', tier: 'paid' });
    });
});

describe('POST /api/auth/invite', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header — inviting requires being logged in yourself', async () => {
        const res = await app.request('/api/auth/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'new@example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on missing fields', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/auth/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ email: 'new@example.com' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('409s on a duplicate email', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'existing' });
        const token = await tokenFor();

        const res = await app.request('/api/auth/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ email: 'new@example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it("403s once the caller's clinic already has the max team accounts", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'countAccountsByClinicId').mockResolvedValue({ count: 4 });
        const token = await tokenFor();

        const res = await app.request('/api/auth/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ email: 'new@example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it("201s and attaches the new account to the CALLER's OWN clinicId — never one from the request body", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'countAccountsByClinicId').mockResolvedValue({ count: 1 });
        const createSpy = vi.spyOn(AccountsDb, 'createTeammateAccount').mockResolvedValue(undefined);
        const token = await tokenFor('clinic-real', 'acc-admin', 'admin@a.com');

        const res = await app.request('/api/auth/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                email: 'Teammate@Example.com', password: 'password123', adminName: 'Dr B', designation: 'Nurse',
                clinicId: 'someone-elses-clinic', // must be ignored entirely
            }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.account).toMatchObject({ clinicId: 'clinic-real', email: 'teammate@example.com', adminName: 'Dr B' });
        expect(createSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic-real', expect.any(String), 'teammate@example.com', expect.any(String), 'Dr B', 'Nurse');
    });
});

describe('GET /api/auth/team', () => {
    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/auth/team', {
            headers: { 'X-Service-Key': SERVICE_KEY },
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s with every account on the caller's clinic, never a password hash", async () => {
        vi.spyOn(AccountsDb, 'listAccountsByClinicId').mockResolvedValue([
            { id: 'acc1', email: 'a@b.com', admin_name: 'Dr A', designation: 'Doctor', created_at: '2026-01-01', password_hash: 'should-not-leak' },
            { id: 'acc2', email: 'c@d.com', admin_name: 'Dr C', designation: 'Nurse', created_at: '2026-01-02', password_hash: 'should-not-leak' },
        ]);
        const { issueSessionToken } = await import('./lib/session.js');
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);

        const res = await app.request('/api/auth/team', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.accounts).toHaveLength(2);
        expect(body.accounts[0]).toMatchObject({ id: 'acc1', email: 'a@b.com', adminName: 'Dr A', designation: 'Doctor' });
        expect(JSON.stringify(body.accounts)).not.toContain('should-not-leak');
    });
});

describe('POST /api/facility/affiliates', () => {
    async function tokenFor(clinicId = 'facility-clinic', accountId = 'acc-admin', email = 'admin@facility.com') {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ practitionerEmail: 'doc@example.com' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on a missing practitionerEmail', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/facility/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("404s if no account exists yet for that email — affiliates must already have their own account", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ practitionerEmail: 'unknown@example.com' }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it("400s if the practitioner is already a full staff account on the SAME clinic", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc-x', clinic_id: 'facility-clinic', email: 'staff@example.com' });
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ practitionerEmail: 'staff@example.com' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("201s and links the practitioner's OWN account to the caller's facility, never creating a new login", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({
            id: 'acc-doc', clinic_id: 'doctors-own-clinic', email: 'doc@example.com', admin_name: 'Dr Doc', designation: 'Cardiologist',
        });
        const addSpy = vi.spyOn(AccountsDb, 'addAffiliate').mockResolvedValue(undefined);
        const token = await tokenFor('facility-clinic', 'acc-admin', 'admin@facility.com');

        const res = await app.request('/api/facility/affiliates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ practitionerEmail: 'Doc@Example.com', role: 'Visiting Cardiologist' }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.affiliate).toMatchObject({ accountId: 'acc-doc', email: 'doc@example.com', role: 'Visiting Cardiologist' });
        expect(addSpy).toHaveBeenCalledWith(baseEnv.DB, 'facility-clinic', 'acc-doc', 'Visiting Cardiologist');
    });
});

describe('GET/DELETE /api/facility/affiliates', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc-admin', clinicId: 'facility-clinic', email: 'admin@facility.com' }, JWT_SECRET);
    }

    it('GET 401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/affiliates', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("GET 200s with the caller's own facility's affiliate list", async () => {
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([
            { accountId: 'acc-doc', role: 'Visiting Cardiologist', status: 'active', email: 'doc@example.com', adminName: 'Dr Doc' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.affiliates).toHaveLength(1);
    });

    it('DELETE 401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/affiliates/acc-doc', { method: 'DELETE', headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('DELETE 200s and revokes against the CALLER\'s own clinicId', async () => {
        const revokeSpy = vi.spyOn(AccountsDb, 'revokeAffiliate').mockResolvedValue(undefined);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates/acc-doc', {
            method: 'DELETE',
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(revokeSpy).toHaveBeenCalledWith(baseEnv.DB, 'facility-clinic', 'acc-doc');
    });
});

describe('GET/PUT /api/provider-composition', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    it('GET 401s with no Authorization header', async () => {
        const res = await app.request('/api/provider-composition', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('GET 404s when nothing has ever been pushed for this clinic', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(null);
        const token = await tokenFor();

        const res = await app.request('/api/provider-composition', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('GET 200s with the stored document, parsed back to an object', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue({
            data: JSON.stringify({ resourceType: 'QuestionnaireResponse', item: [] }), updatedAt: '2026-01-01T00:00:00Z',
        });
        const token = await tokenFor();

        const res = await app.request('/api/provider-composition', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toMatchObject({ resourceType: 'QuestionnaireResponse' });
    });

    it('PUT 401s with no Authorization header', async () => {
        const res = await app.request('/api/provider-composition', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ resourceType: 'QuestionnaireResponse' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("PUT 200s and upserts against the CALLER's own clinicId, never a client-supplied one", async () => {
        const upsertSpy = vi.spyOn(AccountsDb, 'upsertProviderComposition').mockResolvedValue(undefined);
        const token = await tokenFor();

        const res = await app.request('/api/provider-composition', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ resourceType: 'QuestionnaireResponse', item: [{ linkId: 'section_hospital' }], clinicId: 'someone-elses-clinic' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', expect.stringContaining('section_hospital'));
    });
});

// Every /api/encounters/* route added requirePaidTier() in this pass (see
// docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md §6) — each describe block below defaults the
// caller's clinic to paid tier so the existing success-path assertions keep testing what they
// were testing before, and the gate itself only gets its own dedicated coverage once (in the
// lock and assign blocks) rather than duplicated in all five, since it's the same shared
// middleware everywhere.
describe('GET/PUT /api/encounters/:id (document mirror)', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('GET 401s with no Authorization header', async () => {
        const res = await app.request('/api/encounters/enc1', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('GET 404s when nothing has ever been pushed for this encounter', async () => {
        vi.spyOn(EncounterCoordinationDb, 'getDocument').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('PUT 200s and upserts against the encounter id in the URL', async () => {
        const upsertSpy = vi.spyOn(EncounterCoordinationDb, 'upsertDocument').mockResolvedValue({ meta: { rows_written: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ resourceType: 'QuestionnaireResponse' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'enc1', 'clinic1', expect.any(String));
    });
});

describe('POST /api/encounters/:id/assign', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc-admin', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ assignedToAccountId: 'acc-doc' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a logged-in free-tier caller before ever reaching assign logic', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ assignedToAccountId: 'acc-doc' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('400s on a missing assignedToAccountId', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('404s if the assignee account does not exist', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ assignedToAccountId: 'nobody' }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it("403s if the assignee is neither same-clinic staff nor a linked affiliate", async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-stranger', clinic_id: 'some-other-clinic' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([]);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ assignedToAccountId: 'acc-stranger' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('200s and assigns when the assignee is same-clinic staff', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-doc', clinic_id: 'clinic1' });
        const assignSpy = vi.spyOn(EncounterCoordinationDb, 'assignEncounter').mockResolvedValue({ meta: { rows_written: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ assignedToAccountId: 'acc-doc' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(assignSpy).toHaveBeenCalledWith(baseEnv.DB, 'enc1', 'clinic1', 'acc-doc', 'acc-admin');
    });

    it('200s and assigns when the assignee is a linked affiliate of a DIFFERENT clinic', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-affiliate', clinic_id: 'their-own-clinic' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([{ accountId: 'acc-affiliate' }]);
        const assignSpy = vi.spyOn(EncounterCoordinationDb, 'assignEncounter').mockResolvedValue({ meta: { rows_written: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assign', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ assignedToAccountId: 'acc-affiliate' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(assignSpy).toHaveBeenCalled();
    });
});

describe('POST /api/encounters/:id/lock', () => {
    async function tokenFor(accountId = 'acc1') {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: accountId, clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/encounters/enc1/lock', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ stage: 'onboarding' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a logged-in free-tier caller — worklist locking is a paid-tier capability', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/lock', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ stage: 'onboarding' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it("400s on an invalid stage — 'consultation' is assignment-only, never lockable", async () => {
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/lock', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ stage: 'consultation' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('200s when the lock is successfully acquired', async () => {
        vi.spyOn(EncounterCoordinationDb, 'acquireLock').mockResolvedValue(true);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/lock', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ stage: 'onboarding' }),
        }, baseEnv);
        expect(res.status).toBe(200);
    });

    it("409s with who holds it when acquisition fails", async () => {
        vi.spyOn(EncounterCoordinationDb, 'acquireLock').mockResolvedValue(false);
        vi.spyOn(EncounterCoordinationDb, 'getAssignment').mockResolvedValue({ assigned_to_account_id: 'acc-other' });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ admin_name: 'Dr Other', email: 'other@a.com' });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/lock', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ stage: 'onboarding' }),
        }, baseEnv);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.lockedBy).toBe('Dr Other');
    });
});

describe('GET /api/encounters/:id/assignment', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/encounters/enc1/assignment?stage=onboarding', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('returns null when nothing is assigned/locked', async () => {
        vi.spyOn(EncounterCoordinationDb, 'getAssignment').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assignment?stage=onboarding', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.assignment).toBeNull();
    });

    it('treats an EXPIRED lock as null — an expired lock is exactly as if it never existed', async () => {
        vi.spyOn(EncounterCoordinationDb, 'getAssignment').mockResolvedValue({
            assigned_to_account_id: 'acc-other', kind: 'lock', expires_at: '2020-01-01T00:00:00.000Z',
        });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assignment?stage=onboarding', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        const body = await res.json();
        expect(body.assignment).toBeNull();
    });

    it('returns the holder for a still-valid assignment/lock', async () => {
        vi.spyOn(EncounterCoordinationDb, 'getAssignment').mockResolvedValue({ assigned_to_account_id: 'acc-doc', kind: 'assignment', expires_at: null });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ admin_name: 'Dr Doc' });
        const token = await tokenFor();
        const res = await app.request('/api/encounters/enc1/assignment?stage=consultation', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        const body = await res.json();
        expect(body.assignment).toMatchObject({ accountId: 'acc-doc', name: 'Dr Doc', kind: 'assignment' });
    });
});

describe('GET /api/encounters/assignments', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/encounters/assignments?stage=consultation', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s with the CALLER's own assigned encounters only", async () => {
        const listSpy = vi.spyOn(EncounterCoordinationDb, 'listAssignedTo').mockResolvedValue([
            { encounter_id: 'enc1', kind: 'assignment', created_at: '2026-01-01', expires_at: null },
        ]);
        const token = await tokenFor();
        const res = await app.request('/api/encounters/assignments?stage=consultation', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.assignments).toHaveLength(1);
        expect(listSpy).toHaveBeenCalledWith(baseEnv.DB, 'acc1', 'clinic1', 'consultation');
    });
});

describe('GET /api/admin/usage-summary', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/admin/usage-summary', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('is available to a FREE-tier caller — not itself paid-gated', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        vi.spyOn(UsageTracking, 'summaryForClinic').mockResolvedValue([]);
        const token = await tokenFor();
        const res = await app.request('/api/admin/usage-summary', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
    });

    it("200s with the CALLER's own clinic usage only, defaulting to 30 days", async () => {
        const summarySpy = vi.spyOn(UsageTracking, 'summaryForClinic').mockResolvedValue([
            { date: '2026-08-18', component: 'd1_write', quantity: 4 },
        ]);
        const token = await tokenFor();
        const res = await app.request('/api/admin/usage-summary', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.usage).toHaveLength(1);
        expect(summarySpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 30);
    });

    it('honors a custom ?days= override', async () => {
        const summarySpy = vi.spyOn(UsageTracking, 'summaryForClinic').mockResolvedValue([]);
        const token = await tokenFor();
        await app.request('/api/admin/usage-summary?days=7', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(summarySpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 7);
    });
});

describe('POST /api/workflow/test-scribe wiring', () => {
    it('401s with no Authorization header, never reaching the AI binding', async () => {
        // No c.env.AI provided at all — if the handler were reached without requireUser()
        // gating it first, this would throw a TypeError instead of cleanly 401ing.
        const res = await app.request('/api/workflow/test-scribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ transcript: 'test', activeBlueprint: { item: [] } }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a logged-in free-tier caller before ever reaching the AI binding', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const { issueSessionToken } = await import('./lib/session.js');
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);

        const res = await app.request('/api/workflow/test-scribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ transcript: 'test', activeBlueprint: { item: [] } }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });
});

describe('GET /api/chat/signal', () => {
    async function tokenFor(accountId = 'acc1', clinicId = 'clinic1') {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email: 'a@b.com' }, JWT_SECRET);
    }

    // Fresh mock DO namespace per test — idFromName/get/fetch never need to carry state across
    // tests, unlike the vi.spyOn()s elsewhere in this file that afterEach() restores. The mocked
    // stub response uses 200, not the real 101 Switching Protocols the actual DO returns — the
    // Fetch API's Response constructor here runs under vitest's Node environment, which (unlike
    // the real Workers runtime) rejects 101 as out of the generic 200-599 range. What's under
    // test is the route forwarding to the right DO instance, not the literal upgrade response.
    function buildChatEnv() {
        const stubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        return {
            env: { ...baseEnv, CHAT_SIGNALING: { idFromName: vi.fn(() => 'room-id'), get: vi.fn(() => ({ fetch: stubFetch })) } },
            stubFetch,
        };
    }

    it('400s when token or peer is missing', async () => {
        const { env } = buildChatEnv();
        const res = await app.request('/api/chat/signal?peer=acc2', { headers: { 'X-Service-Key': SERVICE_KEY } }, env);
        expect(res.status).toBe(400);
    });

    it('works with NO X-Service-Key header at all — browsers cannot set one on a WebSocket upgrade', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc2', clinic_id: 'clinic1' });
        const { env, stubFetch } = buildChatEnv();
        const token = await tokenFor('acc1', 'clinic1');
        const res = await app.request(`/api/chat/signal?peer=acc2&token=${token}`, {}, env);
        expect(res.status).toBe(200);
        expect(stubFetch).toHaveBeenCalled();
    });

    it('401s on an invalid/missing token — auth travels via query param here, not a header', async () => {
        const { env } = buildChatEnv();
        const res = await app.request('/api/chat/signal?peer=acc2&token=not-a-real-jwt', { headers: { 'X-Service-Key': SERVICE_KEY } }, env);
        expect(res.status).toBe(401);
    });

    it('400s when peer equals the caller — cannot chat with yourself', async () => {
        const { env } = buildChatEnv();
        const token = await tokenFor('acc1');
        const res = await app.request(`/api/chat/signal?peer=acc1&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY } }, env);
        expect(res.status).toBe(400);
    });

    it('404s for an unknown peer account', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue(null);
        const { env } = buildChatEnv();
        const token = await tokenFor('acc1');
        const res = await app.request(`/api/chat/signal?peer=nobody&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY } }, env);
        expect(res.status).toBe(404);
    });

    it("403s if the peer is neither same-clinic staff nor a linked affiliate", async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-stranger', clinic_id: 'some-other-clinic' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([]);
        const { env } = buildChatEnv();
        const token = await tokenFor('acc1', 'clinic1');
        const res = await app.request(`/api/chat/signal?peer=acc-stranger&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY } }, env);
        expect(res.status).toBe(403);
    });

    it('forwards the upgrade to a deterministic per-pair Durable Object when the peer is same-clinic staff', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc2', clinic_id: 'clinic1' });
        const { env, stubFetch } = buildChatEnv();
        const token = await tokenFor('acc1', 'clinic1');
        const res = await app.request(`/api/chat/signal?peer=acc2&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY, Upgrade: 'websocket' } }, env);
        expect(res.status).toBe(200);
        expect(env.CHAT_SIGNALING.idFromName).toHaveBeenCalledWith('chat:acc1:acc2');
        expect(stubFetch).toHaveBeenCalled();
    });

    it('resolves the SAME room name regardless of which side connects first', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc1', clinic_id: 'clinic1' });
        const { env } = buildChatEnv();
        const token = await tokenFor('acc2', 'clinic1');
        await app.request(`/api/chat/signal?peer=acc1&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY, Upgrade: 'websocket' } }, env);
        expect(env.CHAT_SIGNALING.idFromName).toHaveBeenCalledWith('chat:acc1:acc2');
    });

    it('allows a linked affiliate of a DIFFERENT clinic through', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc-affiliate', clinic_id: 'their-own-clinic' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([{ accountId: 'acc-affiliate' }]);
        const { env } = buildChatEnv();
        const token = await tokenFor('acc1', 'clinic1');
        const res = await app.request(`/api/chat/signal?peer=acc-affiliate&token=${token}`, { headers: { 'X-Service-Key': SERVICE_KEY, Upgrade: 'websocket' } }, env);
        expect(res.status).toBe(200);
    });
});

describe('GET /api/nlp/wikidata-search', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/nlp/wikidata-search?term=cardiology', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('is available to a free-tier caller — not paid-gated, by design', async () => {
        vi.spyOn(WikidataTagging, 'search').mockResolvedValue([{ qid: 'Q10379', label: 'cardiology', description: 'medical specialty' }]);
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-search?term=cardiology', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
    });

    it('400s when term is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-search', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('200s with candidates on success', async () => {
        const searchSpy = vi.spyOn(WikidataTagging, 'search').mockResolvedValue([
            { qid: 'Q11180', label: 'internal medicine', description: 'medical specialty' },
        ]);
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-search?term=internal+medicine', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.candidates).toHaveLength(1);
        expect(searchSpy).toHaveBeenCalledWith(baseEnv.WIKIDATA_CACHE, 'internal medicine');
    });

    it('429s with retryAfterSeconds when Wikidata rate-limits, rather than surfacing a generic 500', async () => {
        vi.spyOn(WikidataTagging, 'search').mockRejectedValue(new WikidataRateLimitError(30));
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-search?term=x', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.retryAfterSeconds).toBe(30);
    });

    it('502s cleanly on an unexpected Wikidata failure', async () => {
        vi.spyOn(WikidataTagging, 'search').mockRejectedValue(new Error('network blip'));
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-search?term=x', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(502);
    });
});

describe('GET /api/nlp/wikidata-concept', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/nlp/wikidata-concept?qid=Q11180', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when qid is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-concept', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('200s with the concept detail on success', async () => {
        const conceptSpy = vi.spyOn(WikidataTagging, 'getConcept').mockResolvedValue({
            qid: 'Q11180', label: 'internal medicine', description: 'medical specialty', aliases: ['general medicine'],
        });
        const token = await tokenFor();
        const res = await app.request('/api/nlp/wikidata-concept?qid=Q11180', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.concept.aliases).toEqual(['general medicine']);
        expect(conceptSpy).toHaveBeenCalledWith(baseEnv.WIKIDATA_CACHE, 'Q11180');
    });
});

describe('POST /api/realtime/join', () => {
    const realtimeEnv = { ...baseEnv, CF_REALTIME_ACCOUNT_ID: 'acct1', CF_REALTIME_APP_ID: 'app1', CF_REALTIME_API_TOKEN: 'cftoken' };

    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'a@b.com') {
        const { issueSessionToken } = await import('./lib/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ encounterId: 'enc1' }),
        }, realtimeEnv);
        expect(res.status).toBe(401);
    });

    it('501s when Cloudflare RealtimeKit credentials are not configured', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ encounterId: 'enc1' }),
        }, baseEnv); // no CF_REALTIME_* vars set
        expect(res.status).toBe(501);
    });

    it('400s on a missing encounterId', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        }, realtimeEnv);
        expect(res.status).toBe(400);
    });

    it('creates a new meeting on first join and returns an authToken', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc1', admin_name: 'Dr A', email: 'a@b.com' });
        vi.spyOn(EncounterMeetingsDb, 'getByEncounterId').mockResolvedValue(null);
        const createSpy = vi.spyOn(RealtimeClient, 'createMeeting').mockResolvedValue('cf-meeting-123');
        const dbCreateSpy = vi.spyOn(EncounterMeetingsDb, 'create').mockResolvedValue(undefined);
        const addSpy = vi.spyOn(RealtimeClient, 'addParticipant').mockResolvedValue('cf-auth-token-xyz');

        const token = await tokenFor('clinic1', 'acc1', 'a@b.com');
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ encounterId: 'enc1', encounterTitle: 'Headache visit' }),
        }, realtimeEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toMatchObject({ success: true, authToken: 'cf-auth-token-xyz', meetingId: 'cf-meeting-123' });
        expect(createSpy).toHaveBeenCalledWith('acct1', 'app1', 'cftoken', 'Headache visit');
        expect(dbCreateSpy).toHaveBeenCalledWith(realtimeEnv.DB, 'enc1', 'clinic1', 'cf-meeting-123');
        expect(addSpy).toHaveBeenCalledWith('acct1', 'app1', 'cftoken', 'cf-meeting-123', {
            name: 'Dr A', presetName: 'group_call_host', customParticipantId: 'acc1',
        });
    });

    it('reuses an EXISTING meeting for the same encounterId instead of creating a new one', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc2', admin_name: 'Nurse B', email: 'b@c.com' });
        vi.spyOn(EncounterMeetingsDb, 'getByEncounterId').mockResolvedValue({ encounter_id: 'enc1', cf_meeting_id: 'cf-meeting-existing' });
        const createSpy = vi.spyOn(RealtimeClient, 'createMeeting');
        vi.spyOn(RealtimeClient, 'addParticipant').mockResolvedValue('cf-auth-token-2');

        const token = await tokenFor('clinic1', 'acc2', 'b@c.com');
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ encounterId: 'enc1' }),
        }, realtimeEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.meetingId).toBe('cf-meeting-existing');
        expect(createSpy).not.toHaveBeenCalled();
    });

    it("uses the account's own D1 name, never anything from the request body", async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc3', admin_name: 'Real Name', email: 'c@d.com' });
        vi.spyOn(EncounterMeetingsDb, 'getByEncounterId').mockResolvedValue({ cf_meeting_id: 'cf-meeting-x' });
        const addSpy = vi.spyOn(RealtimeClient, 'addParticipant').mockResolvedValue('token');

        const token = await tokenFor('clinic1', 'acc3', 'c@d.com');
        await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ encounterId: 'enc1', name: 'Spoofed Name' }),
        }, realtimeEnv);

        expect(addSpy).toHaveBeenCalledWith('acct1', 'app1', 'cftoken', 'cf-meeting-x', expect.objectContaining({ name: 'Real Name' }));
    });

    it('502s when the underlying Cloudflare API call fails', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc1', admin_name: 'Dr A' });
        vi.spyOn(EncounterMeetingsDb, 'getByEncounterId').mockResolvedValue(null);
        vi.spyOn(RealtimeClient, 'createMeeting').mockRejectedValue(new Error('Cloudflare RealtimeKit request failed: HTTP 401'));

        const token = await tokenFor();
        const res = await app.request('/api/realtime/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ encounterId: 'enc1' }),
        }, realtimeEnv);
        expect(res.status).toBe(502);
    });
});
