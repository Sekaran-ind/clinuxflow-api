import { describe, it, expect, vi, afterEach } from 'vitest';
import app from './index.js';
import { AccountsDb } from './lib/accounts-db.js';
import { hashPassword } from './lib/passwordHash.js';
import { RealtimeClient } from './lib/realtime-client.js';
import { EncounterMeetingsDb } from './lib/encounter-meetings-db.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';
const baseEnv = { SERVICE_KEY, JWT_SECRET, DB: {}, ENVIRONMENT: 'development' };

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
