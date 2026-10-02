import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import app from './index.js';
import { AccountsDb } from './lib/shared/accounts-db.js';
import { hashPassword } from './lib/shared/passwordHash.js';
import { RealtimeClient } from './lib/runtime/realtime-client.js';
import { EncounterMeetingsDb } from './lib/runtime/encounter-meetings-db.js';
import { EncounterCoordinationDb } from './lib/runtime/encounter-coordination-db.js';
import { TaskDb } from './lib/runtime/task-db.js';
import { ContactMeetingsDb } from './lib/runtime/contact-meetings-db.js';
import { UsageTracking } from './lib/shared/usageTracking.js';
import { WikidataTagging, WikidataRateLimitError } from './lib/control/wikidataTagging.js';
import { JoinTokensDb } from './lib/control/join-tokens-db.js';
import { ResourceRecordsDb } from './lib/control/resource-records-db.js';

const SERVICE_KEY = 'test-service-key';
const JWT_SECRET = 'test-jwt-secret';
const baseEnv = { SERVICE_KEY, JWT_SECRET, DB: {}, WIKIDATA_CACHE: {}, ENVIRONMENT: 'development' };

afterEach(() => vi.restoreAllMocks());

describe('POST /api/auth/register', () => {
    it('401s without X-Service-Key — the new auth routes still sit behind the existing gate', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123', role: 'hospital_admin' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on missing fields', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('defaults the role to admin_and_health_professional when none is sent', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const createSpy = vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'norole@example.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.account.role).toBe('admin_and_health_professional');
        expect(createSpy).toHaveBeenCalledWith(
            baseEnv.DB, expect.any(String), expect.any(String), expect.any(String), 'norole@example.com',
            expect.any(String), undefined, undefined, 'facility', 'admin_and_health_professional'
        );
    });

    it('400s on a too-short password', async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'short', role: 'hospital_admin' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("400s on an invalid role", async () => {
        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123', role: 'nonsense' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('201s with a token and a free-tier account on success', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'New@Example.com', password: 'password123', role: 'hospital_admin' }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.token).toBeTypeOf('string');
        expect(body.account).toMatchObject({
            email: 'new@example.com', role: 'hospital_admin', tier: 'free',
            facilityType: 'facility', clinicName: "new's Clinic",
        });
    });

    it('409s on a duplicate email', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'existing' });

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123', role: 'hospital_admin' }),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it("passes role through to AccountsDb and the response, deriving clinicName and forcing facilityType to 'facility'", async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const createSpy = vi.spyOn(AccountsDb, 'createClinicAndAccount').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'solo@example.com', password: 'password123', role: 'admin_and_health_professional' }),
        }, baseEnv);
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body.account.role).toBe('admin_and_health_professional');
        expect(body.account.facilityType).toBe('facility');
        expect(body.account.clinicName).toBe("solo's Practice");
        expect(createSpy).toHaveBeenCalledWith(
            baseEnv.DB, expect.any(String), "solo's Practice", expect.any(String), 'solo@example.com',
            expect.any(String), undefined, undefined, 'facility', 'admin_and_health_professional'
        );
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

describe('PATCH /api/auth/clinic-name', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/auth/clinic-name', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ clinicName: 'Real Hospital' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on a missing/blank clinicName', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/auth/clinic-name', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ clinicName: '   ' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("200s and updates the CALLER's OWN clinicId — never one from the request body", async () => {
        const updateSpy = vi.spyOn(AccountsDb, 'updateClinicName').mockResolvedValue(undefined);
        const token = await tokenFor('clinic1');

        const res = await app.request('/api/auth/clinic-name', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ clinicName: '  Real Hospital  ' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.clinicName).toBe('Real Hospital');
        expect(updateSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 'Real Hospital');
    });
});

describe('PATCH /api/auth/change-password', () => {
    // Small register/login/change-password closed loop, deliberately small so the new
    // PlanDefinition/Task runtime (clinux-planDefinition-runtime-built memory note) has a
    // well-understood real case to validate configuration against. Didn't exist as a route
    // before this pass — verified by grep across this whole file/repo, not assumed missing.
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/auth/change-password', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ currentPassword: 'old12345', newPassword: 'new12345' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on a missing field', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/auth/change-password', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'old12345' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('400s on a new password under 8 characters — same rule POST /api/auth/register already enforces', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/auth/change-password', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'old12345', newPassword: 'short' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('401s when currentPassword is wrong — never leaks whether the account exists, same discipline as login', async () => {
        const storedHash = await hashPassword('theRealPassword1');
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc1', password_hash: storedHash });
        const token = await tokenFor('clinic1', 'acc1');

        const res = await app.request('/api/auth/change-password', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'wrongPassword1', newPassword: 'new12345' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s and updates the CALLER's OWN accountId's password hash — never one from the request body", async () => {
        const storedHash = await hashPassword('theRealPassword1');
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc1', password_hash: storedHash });
        const updateSpy = vi.spyOn(AccountsDb, 'updatePasswordHash').mockResolvedValue(undefined);
        const token = await tokenFor('clinic1', 'acc1');

        const res = await app.request('/api/auth/change-password', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'theRealPassword1', newPassword: 'brandNewPassword1' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(updateSpy.mock.calls[0][1]).toBe('acc1'); // the caller's own accountId, not from the body
    });
});

describe('PATCH /api/auth/security-question', () => {
    // SPEC-20 (docs/SPEC-20-REFERENCE-PATTERN-JOURNEY-WORKBENCH-AND-UNAUTH-CUBO-ENTRY.md) §4's
    // Forgot Password design — didn't exist before this pass, verified by grep not assumed.
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/auth/security-question', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ securityQuestion: 'First pet?', securityAnswer: 'Rex' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when securityAnswer is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/auth/security-question', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ securityQuestion: 'First pet?' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("200s and sets the CALLER's OWN accountId's security question — never one from the request body", async () => {
        const updateSpy = vi.spyOn(AccountsDb, 'updateSecurityQuestion').mockResolvedValue(undefined);
        const token = await tokenFor('clinic1', 'acc1');

        const res = await app.request('/api/auth/security-question', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ securityQuestion: 'First pet?', securityAnswer: 'Rex' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(updateSpy.mock.calls[0][0]).toBe(baseEnv.DB);
        expect(updateSpy.mock.calls[0][1]).toBe('acc1'); // the caller's own accountId
        expect(updateSpy.mock.calls[0][2]).toBe('First pet?');
        expect(updateSpy.mock.calls[0][3]).not.toBe('Rex'); // stored as a hash, never the raw answer
    });
});

describe('POST /api/auth/forgot-password/question', () => {
    it('401s without X-Service-Key', async () => {
        const res = await app.request('/api/auth/forgot-password/question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'a@b.com' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('404s when no account exists for the email', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const res = await app.request('/api/auth/forgot-password/question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'nobody@example.com' }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('404s the same way when the account exists but never set a security question — same message, no distinguishing signal', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', security_question: null });
        const res = await app.request('/api/auth/forgot-password/question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com' }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('200s with the real security question when set', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', security_question: 'First pet?' });
        const res = await app.request('/api/auth/forgot-password/question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.securityQuestion).toBe('First pet?');
    });
});

describe('POST /api/auth/forgot-password/reset', () => {
    it('404s when no account/security-question exists', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        const res = await app.request('/api/auth/forgot-password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', securityAnswer: 'Rex', newPassword: 'brandNew123' }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('401s when the answer is wrong', async () => {
        const answerHash = await hashPassword('rex'); // normalized (lowercased) at set-time
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', security_answer_hash: answerHash });

        const res = await app.request('/api/auth/forgot-password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', securityAnswer: 'Fido', newPassword: 'brandNew123' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('200s, resets the password, and normalizes case/whitespace on the answer', async () => {
        const answerHash = await hashPassword('rex');
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', security_answer_hash: answerHash });
        const updateSpy = vi.spyOn(AccountsDb, 'updatePasswordHash').mockResolvedValue(undefined);

        const res = await app.request('/api/auth/forgot-password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', securityAnswer: '  Rex  ', newPassword: 'brandNew123' }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.token).toBeUndefined(); // deliberately no auto-login — log in fresh afterward
        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(updateSpy.mock.calls[0][1]).toBe('acc1');
    });

    it('400s on a new password under 8 characters', async () => {
        const res = await app.request('/api/auth/forgot-password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', securityAnswer: 'Rex', newPassword: 'short' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });
});

// POST /api/auth/invite retired (SPEC-26) — its own describe block removed with it (was here,
// see git history); coverage for the new mechanism lives in the
// 'POST /api/facility/join-tokens/:token/redeem' and '.../decide' blocks below.
it('POST /api/auth/invite no longer exists (retired by SPEC-26)', async () => {
    const res = await app.request('/api/auth/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
        body: JSON.stringify({ email: 'x@a.com', password: 'password123' }),
    }, baseEnv);
    expect(res.status).toBe(404);
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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

// The reverse of the block above — a practitioner's own view of the facilities they're
// affiliated with. Real gap found live: this route didn't exist at all before, even though
// migrations/0005 already added an index anticipating exactly this query.
describe('GET /api/practitioner/affiliations', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'indie1', clinicId: 'their-own-clinic', email: 'indie@example.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/practitioner/affiliations', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s with the caller's own affiliation list, queried by the caller's accountId (not clinicId)", async () => {
        const listSpy = vi.spyOn(AccountsDb, 'listAffiliationsByAccount').mockResolvedValue([
            { facilityClinicId: 'clinic1', facilityName: 'Apollo Diagnostics', role: null, status: 'active' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/practitioner/affiliations', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.affiliations).toHaveLength(1);
        expect(body.affiliations[0].facilityName).toBe('Apollo Diagnostics');
        expect(listSpy).toHaveBeenCalledWith(baseEnv.DB, 'indie1');
    });
});

// The org-to-org counterpart to the two blocks above — same consistent-method shape.
describe('GET/DELETE /api/facility/organization-affiliates', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'org-admin', clinicId: 'facility-clinic', email: 'admin@facility.com' }, JWT_SECRET);
    }

    it('GET 401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/organization-affiliates', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("GET 200s with the caller's own facility's partner-organization list", async () => {
        vi.spyOn(AccountsDb, 'listOrganizationAffiliatesByFacility').mockResolvedValue([
            { affiliateClinicId: 'lab-clinic', relationship: 'Partner Lab', status: 'active', affiliateClinicName: 'City Diagnostics Lab' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/organization-affiliates', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.affiliates).toHaveLength(1);
        expect(body.affiliates[0].affiliateClinicName).toBe('City Diagnostics Lab');
    });

    it('DELETE 401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/organization-affiliates/lab-clinic', { method: 'DELETE', headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("DELETE 200s and revokes against the CALLER's own clinicId", async () => {
        const revokeSpy = vi.spyOn(AccountsDb, 'revokeOrganizationAffiliate').mockResolvedValue(undefined);
        const token = await tokenFor();

        const res = await app.request('/api/facility/organization-affiliates/lab-clinic', {
            method: 'DELETE',
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(revokeSpy).toHaveBeenCalledWith(baseEnv.DB, 'facility-clinic', 'lab-clinic');
    });
});

// The reverse of the block above — which OTHER facilities has MY organization been linked to.
describe('GET /api/facility/organization-affiliations', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'lab-admin', clinicId: 'lab-clinic', email: 'admin@lab.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/organization-affiliations', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s with the caller's own organization's affiliation list, queried by the caller's clinicId", async () => {
        const listSpy = vi.spyOn(AccountsDb, 'listOrganizationAffiliationsByClinic').mockResolvedValue([
            { facilityClinicId: 'facility-clinic', facilityName: 'Apollo Diagnostics', relationship: 'Partner Lab', status: 'active' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/organization-affiliations', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.affiliations).toHaveLength(1);
        expect(body.affiliations[0].facilityName).toBe('Apollo Diagnostics');
        expect(listSpy).toHaveBeenCalledWith(baseEnv.DB, 'lab-clinic');
    });
});

describe('GET /api/facility/affiliates/conformance', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc-admin', clinicId: 'facility-clinic', email: 'admin@facility.com' }, JWT_SECRET);
    }

    // Real, compiled YAML -> real extraction, same discipline as the facility/provider
    // conformance tests below -- not a hand-built Organization fixture.
    async function compositionRowWithOrganization() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'), 'utf8');
        const questionnaire = compileYamlToQuestionnaire(yamlSource).questionnaire;
        const responseJson = { item: [{ linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'ABC Hospital' }] }] }] };
        return { questionnaire, dataJson: JSON.stringify(responseJson) };
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/affiliates/conformance', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('reports hasOrganization:false and an empty list when nothing has been saved/linked yet', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates/conformance', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.hasOrganization).toBe(false);
        expect(body.affiliates).toEqual([]);
    });

    it('builds and validates a real PractitionerRole per linked affiliate once a Facility Organization exists', async () => {
        const { dataJson } = await compositionRowWithOrganization();
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue({ data: dataJson, updatedAt: '2026-01-01T00:00:00Z' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([
            { accountId: 'acc-doc', role: 'Visiting Cardiologist', status: 'active', email: 'doc@example.com', adminName: 'Dr Doc' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates/conformance', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.hasOrganization).toBe(true);
        expect(body.affiliates).toHaveLength(1);
        expect(body.affiliates[0].role.organization.reference).toMatch(/^Organization\//);
        expect(body.affiliates[0].role.code).toEqual([{ text: 'Visiting Cardiologist' }]);
        expect(body.affiliates[0].valid).toBe(true); // active + practitioner + organization all present; code is optional
    });

    it('honestly reports a missing Organization link rather than silently dropping it', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(null); // Hospital Profile never saved
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([
            { accountId: 'acc-doc', role: null, status: 'active', email: 'doc@example.com', adminName: 'Dr Doc' },
        ]);
        const token = await tokenFor();

        const res = await app.request('/api/facility/affiliates/conformance', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        const body = await res.json();
        expect(body.affiliates[0].valid).toBe(false);
        expect(body.affiliates[0].errors.some((e) => e.path === 'PractitionerRole.organization')).toBe(true);
    });
});

describe('GET/PUT /api/provider-composition', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
            body: JSON.stringify({
                data: { resourceType: 'QuestionnaireResponse', item: [{ linkId: 'section_hospital' }] },
                published: true,
                clinicId: 'someone-elses-clinic',
            }),
        }, baseEnv);
        expect(res.status).toBe(200);

        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', expect.stringContaining('section_hospital'), true);
    });

    it('PUT defaults published to false when omitted', async () => {
        const upsertSpy = vi.spyOn(AccountsDb, 'upsertProviderComposition').mockResolvedValue(undefined);
        const token = await tokenFor();

        await app.request('/api/provider-composition', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ data: { resourceType: 'QuestionnaireResponse', item: [] } }),
        }, baseEnv);

        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', expect.any(String), false);
    });
});

// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md — token-based staff/affiliate linking.
describe('POST /api/facility/join-tokens (issue)', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/join-tokens', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ linkKind: 'staff' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('409s when the facility has not published yet', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ linkKind: 'staff' }),
        }, baseEnv);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.stage).toBe('draft');
    });

    it('200s and issues a token once the facility is published', async () => {
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue({
            data: JSON.stringify({ item: [{ linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'ABC' }] }] }] }),
            publishedAt: '2026-09-09T00:00:00Z',
        });
        vi.spyOn(JoinTokensDb, 'issue').mockResolvedValue(undefined);
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ expires_at: '2026-09-12T00:00:00Z' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ linkKind: 'affiliate' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.token).toMatch(/^[A-Z0-9]{8}$/);
        expect(body.expiresAt).toBe('2026-09-12T00:00:00Z');
    });

    it('400s an invalid linkKind', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ linkKind: 'bogus' }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });
});

describe('POST /api/facility/join-tokens/:token/renew', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
    }

    it('409s when the token is not renewable (not found/not yours/already redeemed)', async () => {
        vi.spyOn(JoinTokensDb, 'renew').mockResolvedValue({ meta: { changes: 0 } });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/renew', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it('200s and returns the new expiry on success', async () => {
        vi.spyOn(JoinTokensDb, 'renew').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ expires_at: '2026-09-15T00:00:00Z' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/renew', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        expect((await res.json()).expiresAt).toBe('2026-09-15T00:00:00Z');
    });
});

describe('POST /api/facility/join-tokens/:token/redeem', () => {
    const issuedRow = {
        token: 'ABC12345', facility_clinic_id: 'clinic1', link_kind: 'staff',
        issued_by_account_id: 'admin1', status: 'issued', expires_at: '2099-01-01T00:00:00Z',
    };
    const publishedComposition = {
        data: JSON.stringify({ item: [{ linkId: 'section_hospital', item: [{ linkId: 'hospital_name', answer: [{ valueString: 'ABC' }] }] }] }),
        publishedAt: '2026-09-09T00:00:00Z',
    };

    it('404s an invalid token', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue(null);
        const res = await app.request('/api/facility/join-tokens/NOPE/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('409s a token that is not `issued` (already redeemed)', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ ...issuedRow, status: 'redeemed' });
        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it('410s an expired token', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ ...issuedRow, expires_at: '2000-01-01T00:00:00Z' });
        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(410);
    });

    it("409s if the facility's own setup stage regressed below the eligibility bar", async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue(issuedRow);
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(null);
        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it('creates a new PENDING staff account and does NOT hand back a usable session token', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue(issuedRow);
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(publishedComposition);
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue(null);
        vi.spyOn(AccountsDb, 'countAccountsByClinicId').mockResolvedValue({ count: 1 });
        const createSpy = vi.spyOn(AccountsDb, 'createTeammateAccount').mockResolvedValue(undefined);
        vi.spyOn(JoinTokensDb, 'redeem').mockResolvedValue(true);
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'admin1', admin_name: 'Dr Admin' });
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ name: 'ABC Hospital' });

        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'new@a.com', password: 'password123', adminName: 'New Person' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.sessionToken).toBeUndefined();
        expect(body.personEmail).toBe('new@a.com');
        expect(body.admin).toEqual({ accountId: 'admin1', name: 'Dr Admin' });
        expect(body.facilityName).toBe('ABC Hospital');
        expect(createSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', expect.any(String), 'new@a.com', expect.any(String), 'New Person', undefined, 'pending');
    });

    it('409s a staff redeem when the email already has an account', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue(issuedRow);
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(publishedComposition);
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'existing' });
        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'taken@a.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it('401s an unauthenticated affiliate redemption attempt (must log in first)', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ ...issuedRow, link_kind: 'affiliate' });
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(publishedComposition);
        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('an already-authenticated caller redeeming (affiliate) reuses their existing account, no new one created', async () => {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        const callerToken = await issueSessionToken({ sub: 'affiliate-acc', clinicId: 'affiliate-own-clinic', email: 'aff@a.com' }, JWT_SECRET);
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ ...issuedRow, link_kind: 'affiliate' });
        vi.spyOn(AccountsDb, 'getProviderComposition').mockResolvedValue(publishedComposition);
        const createSpy = vi.spyOn(AccountsDb, 'createTeammateAccount');
        vi.spyOn(JoinTokensDb, 'redeem').mockResolvedValue(true);
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'admin1', admin_name: 'Dr Admin' });
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ name: 'ABC Hospital' });

        const res = await app.request('/api/facility/join-tokens/ABC12345/redeem', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${callerToken}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.accountId).toBe('affiliate-acc');
        expect(body.sessionToken).toBeUndefined();
        expect(body.personEmail).toBeNull();
        expect(createSpy).not.toHaveBeenCalled();
    });
});

describe('POST /api/facility/join-tokens/:token/deliver', () => {
    async function tokenFor(accountId = 'redeemer1') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId: 'clinic-redeemer', email: 'r@a.com' }, JWT_SECRET);
    }

    it('403s when the caller is not who redeemed this token', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ redeemed_by_account_id: 'someone-else' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/deliver', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ciphertext: 'cfx1.xxx' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('sends onto the CUBO_TASK_QUEUE, tagged with its own type, when the binding is configured', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ redeemed_by_account_id: 'redeemer1' });
        const send = vi.fn().mockResolvedValue(undefined);
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/deliver', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ciphertext: 'cfx1.xxx' }),
        }, { ...baseEnv, CUBO_TASK_QUEUE: { send } });
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledWith({ type: 'facility-join-request', token: 'ABC12345', ciphertext: 'cfx1.xxx' });
    });

    it('degrades to a direct durable write when the queue binding is absent (local dev)', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ redeemed_by_account_id: 'redeemer1' });
        const setSpy = vi.spyOn(JoinTokensDb, 'setPendingPayload').mockResolvedValue(undefined);
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/deliver', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ciphertext: 'cfx1.xxx' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(setSpy).toHaveBeenCalledWith(baseEnv.DB, 'ABC12345', 'cfx1.xxx');
    });
});

describe('POST /api/facility/join-tokens/:token/decide', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'admin1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
    }

    it("403s a decision on another facility's token", async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'someone-elses-clinic' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('409s a decision on a token not awaiting one', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 0 } });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved' }),
        }, baseEnv);
        expect(res.status).toBe(409);
    });

    it('approving a STAFF request for a genuinely fresh account (clinic_id already matches) flips their account status to active, never touches facility_affiliates', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'staff', redeemed_by_account_id: 'newstaff1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'newstaff1', clinic_id: 'clinic1' });
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus').mockResolvedValue(undefined);
        const addAffiliateSpy = vi.spyOn(AccountsDb, 'addAffiliate');
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(statusSpy).toHaveBeenCalledWith(baseEnv.DB, 'newstaff1', 'active');
        expect(addAffiliateSpy).not.toHaveBeenCalled();
    });

    it('rejecting a STAFF request for a genuinely fresh account flips their account status to rejected', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'staff', redeemed_by_account_id: 'newstaff1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'newstaff1', clinic_id: 'clinic1' });
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus').mockResolvedValue(undefined);
        const token = await tokenFor();
        await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'rejected' }),
        }, baseEnv);
        expect(statusSpy).toHaveBeenCalledWith(baseEnv.DB, 'newstaff1', 'rejected');
    });

    // Real bug found live: an already-registered, independent practitioner (their OWN clinic_id,
    // from individual registration) can redeem a 'staff' token via the bearer path — .../redeem's
    // own comment explicitly anticipates this. The account's clinic_id never matches the
    // facility's, so flipping `status` was a silent no-op; the relationship must be recorded as a
    // facility_affiliates cross-reference instead, same as an 'affiliate'-kind decision.
    it("approving a STAFF request for a PRE-EXISTING independent account (clinic_id doesn't match) adds a facility_affiliates row instead, never touches account status", async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'staff', redeemed_by_account_id: 'indie1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'indie1', clinic_id: 'their-own-clinic' });
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus');
        const addAffiliateSpy = vi.spyOn(AccountsDb, 'addAffiliate').mockResolvedValue(undefined);
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(addAffiliateSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 'indie1', null);
        expect(statusSpy).not.toHaveBeenCalled();
    });

    // The second half of the same fix — a rejected decision against a pre-existing independent
    // account must not touch their account status at all: they were never 'pending' to begin
    // with, and setAccountStatus('rejected') would lock them out of their OWN account over a
    // different facility's unrelated rejection.
    it('rejecting a STAFF request for a pre-existing independent account touches nothing at all', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'staff', redeemed_by_account_id: 'indie1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'indie1', clinic_id: 'their-own-clinic' });
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus');
        const addAffiliateSpy = vi.spyOn(AccountsDb, 'addAffiliate');
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'rejected' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(statusSpy).not.toHaveBeenCalled();
        expect(addAffiliateSpy).not.toHaveBeenCalled();
    });

    it('approving an AFFILIATE request adds the facility_affiliates row with the given role, never touches account status', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'affiliate', redeemed_by_account_id: 'aff1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        const addAffiliateSpy = vi.spyOn(AccountsDb, 'addAffiliate').mockResolvedValue(undefined);
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus');
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved', role: 'Visiting Cardiologist' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(addAffiliateSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 'aff1', 'Visiting Cardiologist');
        expect(statusSpy).not.toHaveBeenCalled();
    });

    // migrations/0015's 3rd relationship kind — a facility admin (their own separate clinic)
    // redeeming another facility's 'organization' token. What gets linked is the redeemer's own
    // CLINIC, not their account — resolved via getAccountById, same lookup pattern the 'staff'
    // branch above already uses for a different reason.
    it("approving an ORGANIZATION request adds a facility_organization_affiliates row keyed by the redeemer's OWN clinic_id, never touches account status", async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'organization', redeemed_by_account_id: 'org-admin1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'org-admin1', clinic_id: 'lab-clinic' });
        const addOrgAffiliateSpy = vi.spyOn(AccountsDb, 'addOrganizationAffiliate').mockResolvedValue(undefined);
        const addAffiliateSpy = vi.spyOn(AccountsDb, 'addAffiliate');
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus');
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'approved', role: 'Partner Lab' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(addOrgAffiliateSpy).toHaveBeenCalledWith(baseEnv.DB, 'clinic1', 'lab-clinic', 'Partner Lab');
        expect(addAffiliateSpy).not.toHaveBeenCalled();
        expect(statusSpy).not.toHaveBeenCalled();
    });

    it('rejecting an ORGANIZATION request touches nothing at all', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', link_kind: 'organization', redeemed_by_account_id: 'org-admin1' });
        vi.spyOn(JoinTokensDb, 'decide').mockResolvedValue({ meta: { changes: 1 } });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'org-admin1', clinic_id: 'lab-clinic' });
        const addOrgAffiliateSpy = vi.spyOn(AccountsDb, 'addOrganizationAffiliate');
        const statusSpy = vi.spyOn(AccountsDb, 'setAccountStatus');
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ decision: 'rejected' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(addOrgAffiliateSpy).not.toHaveBeenCalled();
        expect(statusSpy).not.toHaveBeenCalled();
    });
});

describe('GET /api/facility/join-tokens', () => {
    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/join-tokens', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it("200s with the caller's own facility's tokens", async () => {
        vi.spyOn(JoinTokensDb, 'listByClinic').mockResolvedValue([{ token: 'ABC12345', status: 'issued' }]);
        const { issueSessionToken } = await import('./lib/shared/session.js');
        const token = await issueSessionToken({ sub: 'admin1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
        const res = await app.request('/api/facility/join-tokens', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tokens).toEqual([{ token: 'ABC12345', status: 'issued' }]);
    });
});

describe('GET /api/facility/join-tokens/pending', () => {
    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/join-tokens/pending', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('200s with redeemed-but-undecided tokens issued by the CALLER, joined with redeemer identity', async () => {
        vi.spyOn(JoinTokensDb, 'listPendingByIssuer').mockResolvedValue([
            { token: 'ABC12345', linkKind: 'staff', accountId: 'newstaff1', email: 'new@a.com', adminName: 'New Hire', createdAt: '2026-09-09T00:00:00Z' },
        ]);
        const { issueSessionToken } = await import('./lib/shared/session.js');
        const token = await issueSessionToken({ sub: 'admin1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
        const res = await app.request('/api/facility/join-tokens/pending', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.pending[0]).toMatchObject({ token: 'ABC12345', accountId: 'newstaff1', adminName: 'New Hire' });
    });
});

describe('GET /api/facility/join-tokens/:token/payload', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'admin1', clinicId: 'clinic1', email: 'admin@a.com' }, JWT_SECRET);
    }

    it("403s for another facility's token", async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'someone-elses-clinic' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/payload', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('200s with the stored ciphertext (never plaintext)', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', pending_payload: 'cfx1.xxx' });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/payload', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(200);
        expect((await res.json()).ciphertext).toBe('cfx1.xxx');
    });

    it('returns null (not an error) when nothing has been delivered yet', async () => {
        vi.spyOn(JoinTokensDb, 'getByToken').mockResolvedValue({ facility_clinic_id: 'clinic1', pending_payload: null });
        const token = await tokenFor();
        const res = await app.request('/api/facility/join-tokens/ABC12345/payload', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect((await res.json()).ciphertext).toBeNull();
    });
});

describe('POST /api/auth/login account status gate (SPEC-26)', () => {
    it('403s a pending (unapproved) account, even with the correct password', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', password_hash: await hashPassword('password123'), status: 'pending' });
        const res = await app.request('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('403s a rejected account', async () => {
        vi.spyOn(AccountsDb, 'getAccountByEmail').mockResolvedValue({ id: 'acc1', password_hash: await hashPassword('password123'), status: 'rejected' });
        const res = await app.request('/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ email: 'a@b.com', password: 'password123' }),
        }, baseEnv);
        expect(res.status).toBe(403);
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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

// SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6/§10 step 4 — same requireUser()+
// requirePaidTier() gate and route-shape conventions as the /api/encounters/* block above,
// mirrored here for /api/tasks/:planId/*.
describe('GET/PUT /api/tasks/:planId/snapshot', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/tasks/plan1/snapshot', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a logged-in free-tier caller', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/snapshot', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('GET 404s when nothing has ever been pushed for this plan', async () => {
        vi.spyOn(TaskDb, 'getSnapshot').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/snapshot', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('GET 200s with the parsed snapshot', async () => {
        vi.spyOn(TaskDb, 'getSnapshot').mockResolvedValue({ snapshot: JSON.stringify({ value: { register: 'done' } }), updatedAt: '2026-09-09' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/snapshot', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.snapshot).toEqual({ value: { register: 'done' } });
    });

    it('PUT 200s and upserts against the planId in the URL', async () => {
        const upsertSpy = vi.spyOn(TaskDb, 'upsertSnapshot').mockResolvedValue({ meta: { changes: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/snapshot', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ value: { register: 'done' } }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'plan1', 'clinic1', JSON.stringify({ value: { register: 'done' } }));
    });
});

describe('POST/GET /api/tasks/:planId/audit', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/tasks/plan1/audit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ taskId: 'plan1:register', actionId: 'register', toStatus: 'done' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s on a missing taskId/actionId', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/audit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('200s and appends with the CALLER as accountId, never a client-supplied one', async () => {
        const appendSpy = vi.spyOn(TaskDb, 'appendAuditEntry').mockResolvedValue({ meta: { changes: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/audit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ taskId: 'plan1:register', actionId: 'register', fromStatus: 'ready', toStatus: 'done', accountId: 'someone-else' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(appendSpy).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
            planId: 'plan1', taskId: 'plan1:register', clinicId: 'clinic1', accountId: 'acc1',
            actionId: 'register', fromStatus: 'ready', toStatus: 'done',
        }));
    });

    it('GET 200s with the full trail, oldest first, as returned by TaskDb', async () => {
        vi.spyOn(TaskDb, 'listAuditLog').mockResolvedValue([
            { id: 'a1', task_id: 'plan1:register', account_id: 'acc1', action_id: 'register', from_status: null, to_status: 'ready', created_at: '2026-09-09T00:00:00Z' },
        ]);
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/audit', {
            headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.entries).toEqual([
            { id: 'a1', taskId: 'plan1:register', accountId: 'acc1', actionId: 'register', fromStatus: null, toStatus: 'ready', createdAt: '2026-09-09T00:00:00Z' },
        ]);
    });
});

describe('POST /api/tasks/:planId/lock', () => {
    async function tokenFor(accountId = 'acc1') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/tasks/plan1/lock', { method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a logged-in free-tier caller', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('200s when the lock is successfully acquired', async () => {
        vi.spyOn(TaskDb, 'acquireLock').mockResolvedValue(true);
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
    });

    it('409s with who holds it when acquisition fails', async () => {
        vi.spyOn(TaskDb, 'acquireLock').mockResolvedValue(false);
        vi.spyOn(TaskDb, 'getLock').mockResolvedValue({ assigned_to_account_id: 'acc-other' });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ admin_name: 'Dr Other', email: 'other@a.com' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.lockedBy).toBe('Dr Other');
    });
});

describe('POST /api/tasks/:planId/lock/renew and /release', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('renew 200s and renews against the CALLER account, not a client-supplied one', async () => {
        const renewSpy = vi.spyOn(TaskDb, 'renewLock').mockResolvedValue({ meta: { changes: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock/renew', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(renewSpy).toHaveBeenCalledWith(baseEnv.DB, 'plan1', 'acc1');
    });

    it('release 200s and releases against the CALLER account', async () => {
        const releaseSpy = vi.spyOn(TaskDb, 'releaseLock').mockResolvedValue({ meta: { changes: 1 } });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock/release', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv);
        expect(res.status).toBe(200);
        expect(releaseSpy).toHaveBeenCalledWith(baseEnv.DB, 'plan1', 'acc1');
    });
});

describe('GET /api/tasks/:planId/lock', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('returns null when nothing has ever held this lock', async () => {
        vi.spyOn(TaskDb, 'getLock').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        const body = await res.json();
        expect(body.lock).toBeNull();
    });

    it('active:false for a released (expires_at NULL) row — task_locks rows are never deleted, so a real "last held it" answer', async () => {
        vi.spyOn(TaskDb, 'getLock').mockResolvedValue({ assigned_to_account_id: 'acc-doc', expires_at: null });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ admin_name: 'Dr Doc' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        const body = await res.json();
        expect(body.lock).toEqual({ accountId: 'acc-doc', name: 'Dr Doc', active: false });
    });

    it('active:true for a still-unexpired lock', async () => {
        vi.spyOn(TaskDb, 'getLock').mockResolvedValue({ assigned_to_account_id: 'acc-doc', expires_at: '2999-01-01T00:00:00.000Z' });
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ admin_name: 'Dr Doc' });
        const token = await tokenFor();
        const res = await app.request('/api/tasks/plan1/lock', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        const body = await res.json();
        expect(body.lock).toEqual({ accountId: 'acc-doc', name: 'Dr Doc', active: true });
    });
});

describe('GET /api/admin/usage-summary', () => {
    async function tokenFor() {
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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
        const { issueSessionToken } = await import('./lib/shared/session.js');
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

// Hospital/Provider/Affiliate journey follow-up — the same trust-boundary tests
// GET /api/chat/signal already has, plus the same create/reuse-meeting tests
// POST /api/realtime/join already has, combined for the new contact-call route.
describe('POST /api/realtime/contact-call/:peerAccountId/join', () => {
    const realtimeEnv = { ...baseEnv, CF_REALTIME_ACCOUNT_ID: 'acct1', CF_REALTIME_APP_ID: 'app1', CF_REALTIME_API_TOKEN: 'cftoken' };

    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'a@b.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/realtime/contact-call/acc2/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY },
        }, realtimeEnv);
        expect(res.status).toBe(401);
    });

    it('501s when Cloudflare RealtimeKit credentials are not configured', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/realtime/contact-call/acc2/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, baseEnv); // no CF_REALTIME_* vars set
        expect(res.status).toBe(501);
    });

    it('400s when calling yourself', async () => {
        const token = await tokenFor('clinic1', 'acc1');
        const res = await app.request('/api/realtime/contact-call/acc1/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, realtimeEnv);
        expect(res.status).toBe(400);
    });

    it('404s on an unknown peer', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue(null);
        const token = await tokenFor();
        const res = await app.request('/api/realtime/contact-call/nope/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, realtimeEnv);
        expect(res.status).toBe(404);
    });

    it("403s if the peer is neither same-clinic staff nor a linked affiliate", async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockResolvedValue({ id: 'acc2', clinic_id: 'clinic-other', admin_name: 'Stranger' });
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([]);
        const token = await tokenFor('clinic1', 'acc1');
        const res = await app.request('/api/realtime/contact-call/acc2/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, realtimeEnv);
        expect(res.status).toBe(403);
    });

    it('200s and creates a new meeting on first join for same-clinic staff, keyed by the deterministic room id', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockImplementation(async (db, id) => (
            id === 'acc1' ? { id: 'acc1', clinic_id: 'clinic1', admin_name: 'Dr A' } : { id: 'acc2', clinic_id: 'clinic1', admin_name: 'Dr B' }
        ));
        vi.spyOn(ContactMeetingsDb, 'getByRoomId').mockResolvedValue(null);
        const createSpy = vi.spyOn(RealtimeClient, 'createMeeting').mockResolvedValue('cf-meeting-abc');
        const dbCreateSpy = vi.spyOn(ContactMeetingsDb, 'create').mockResolvedValue(undefined);
        const addSpy = vi.spyOn(RealtimeClient, 'addParticipant').mockResolvedValue('cf-auth-token-1');

        const token = await tokenFor('clinic1', 'acc1');
        const res = await app.request('/api/realtime/contact-call/acc2/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, realtimeEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toMatchObject({ success: true, authToken: 'cf-auth-token-1', meetingId: 'cf-meeting-abc' });
        // chatRoomName() sorts the pair -- same room regardless of who initiates.
        expect(dbCreateSpy).toHaveBeenCalledWith(realtimeEnv.DB, 'chat:acc1:acc2', 'cf-meeting-abc');
        expect(createSpy).toHaveBeenCalled();
        expect(addSpy).toHaveBeenCalledWith('acct1', 'app1', 'cftoken', 'cf-meeting-abc', {
            name: 'Dr A', presetName: 'group_call_host', customParticipantId: 'acc1',
        });
    });

    it('200s for a linked affiliate of a DIFFERENT clinic and reuses an existing meeting', async () => {
        vi.spyOn(AccountsDb, 'getAccountById').mockImplementation(async (db, id) => (
            id === 'acc1' ? { id: 'acc1', clinic_id: 'clinic1', admin_name: 'Dr A' } : { id: 'acc-aff', clinic_id: 'clinic-other', admin_name: 'Dr Affiliate' }
        ));
        vi.spyOn(AccountsDb, 'listAffiliatesByFacility').mockResolvedValue([{ accountId: 'acc-aff' }]);
        vi.spyOn(ContactMeetingsDb, 'getByRoomId').mockResolvedValue({ room_id: 'chat:acc-aff:acc1', cf_meeting_id: 'cf-meeting-existing' });
        const createSpy = vi.spyOn(RealtimeClient, 'createMeeting');
        vi.spyOn(RealtimeClient, 'addParticipant').mockResolvedValue('token');

        const token = await tokenFor('clinic1', 'acc1');
        const res = await app.request('/api/realtime/contact-call/acc-aff/join', {
            method: 'POST', headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
        }, realtimeEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.meetingId).toBe('cf-meeting-existing');
        expect(createSpy).not.toHaveBeenCalled();
    });
});

describe('POST /api/workflow/extract', () => {
    // SPEC-22 decision #2's real loader, request-time half — the Room-Architect Designer's
    // "Design & Compile Room" step needs this to turn a filled-in authoring-form response into a
    // real PlanDefinition interactively; hospital-setup-workflow.test.js/build-system-flows.js
    // both call ComprehensiveLocalExtractor directly (build-time/test-time), this is the first
    // real HTTP caller. Reuses the SAME real compiler + the SAME real hospital-setup-workflow-v1
    // worked-example response as those, proving the endpoint wraps the extractor correctly rather
    // than re-testing the extractor's own logic (already covered there).
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/workflow/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when questionnaireJson or responseJson is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/workflow/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
    });

    it('extracts a real PlanDefinition from a real compiled Questionnaire + a real filled-in response', async () => {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const { buildHospitalSetupWorkflowResponse } = await import('./lib/runtime/hospital-setup-workflow-response.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'samples', 'hospital-setup-workflow-v1.yaml'), 'utf8');
        const compiled = compileYamlToQuestionnaire(yamlSource);
        const responseJson = buildHospitalSetupWorkflowResponse();

        const token = await tokenFor();
        const res = await app.request('/api/workflow/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: compiled.questionnaire, responseJson }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.warnings).toEqual([]);
        const plan = body.resources.find((r) => r.resourceType === 'PlanDefinition');
        expect(plan.title).toBe('Hospital Setup Workflow');
        expect(plan.action.length).toBe(10);
        expect(plan.action.map((a) => a.id)).toContain('section_appointment');
    });
});

describe('POST /api/workflow/assemble-document', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/workflow/assemble-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ resources: [], title: 'x', authorRef: { resourceType: 'Practitioner', id: 'p1' } }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when resources is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/workflow/assemble-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ title: 'x', authorRef: { resourceType: 'Practitioner', id: 'p1' } }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('400s when the assembler itself rejects (missing required FHIR fields), surfacing the real error', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/workflow/assemble-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ resources: [{ resourceType: 'Organization', id: 'org-1' }] }), // no title, no authorRef
        }, baseEnv);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/title/i);
    });

    it('assembles a real document Bundle from real extracted resources — the full compile -> extract -> assemble chain via real HTTP calls', async () => {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const { ComprehensiveLocalExtractor } = await import('./lib/shared/local-extractor.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'samples', 'hospital-setup-workflow-v1.yaml'), 'utf8');
        // Use the real Provider composition instead — a genuine data-capture YAML, not the
        // workflow-authoring one — to produce real Organization/Location resources to assemble.
        const providerYaml = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'), 'utf8');
        const compiled = compileYamlToQuestionnaire(providerYaml);
        const response = {
            item: [{ linkId: 'section_hospital', item: [
                { linkId: 'hospital_name', answer: [{ valueString: 'HTTP Test Hospital' }] },
            ]}],
        };
        const resources = ComprehensiveLocalExtractor.extract(compiled.questionnaire, response);
        const org = resources.find((r) => r.resourceType === 'Organization');

        const token = await tokenFor();
        const res = await app.request('/api/workflow/assemble-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                resources,
                title: 'HTTP Test Hospital — Facility Registration',
                authorRef: { resourceType: 'Organization', id: org.id },
            }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.bundle.resourceType).toBe('Bundle');
        expect(body.bundle.type).toBe('document');
        expect(body.bundle.entry[0].resource.resourceType).toBe('Composition');
        expect(body.bundle.entry.length).toBe(resources.length + 1);
    });
});

describe('POST /api/facility/conformance', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    // The real, compiled system-provider-composition-v1.yaml Questionnaire — same "compile the
    // real YAML, don't hand-build a fixture" discipline as the assemble-document test above.
    async function compiledQuestionnaire() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'), 'utf8');
        return compileYamlToQuestionnaire(yamlSource).questionnaire;
    }

    function stringAnswer(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }

    // Every element ClinuxFlowFacility.json (data/structure-definitions) actually requires,
    // through the real section_hospital + ABDM sub-groups — this is SPEC-24 §7 step 5's own
    // "prove the whole chain end to end" case: real YAML -> real compiled Questionnaire -> real
    // extraction -> real conformance validation, via one real HTTP call.
    function completeHospitalAnswers() {
        return [
            stringAnswer('hospital_name', 'ABC Hospital'),
            stringAnswer('hospital_type', 'Hospital'),
            stringAnswer('hospital_address', 'Temple street'),
            stringAnswer('hospital_pin', '600107'),
            stringAnswer('hospital_country', 'India'),
            stringAnswer('hospital_ownership_code', 'G'),
            stringAnswer('hospital_facility_type', '5'),
            stringAnswer('hospital_facility_subtype', '30'),
            stringAnswer('hospital_ownership_subtype_code', 'S'),
            { linkId: 'hospital_system_of_medicine', answer: [{ valueString: 'Modern Medicine (Allopathy)' }, { valueString: 'Dentistry' }] },
            { linkId: 'hospital_operational_status', answer: [{ valueBoolean: true }] },
            stringAnswer('hospital_operational_status_code', 'F'),
            stringAnswer('hospital_state_lgd_code', '33'),
            stringAnswer('hospital_district_lgd_code', '568'),
            stringAnswer('hospital_subdistrict_lgd_code', '5704'),
            stringAnswer('hospital_geo_latitude', '24.068570'),
            stringAnswer('hospital_geo_longitude', '24.068570'),
        ];
    }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/facility/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when responseJson is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/facility/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('reports invalid with real per-field errors for a facility missing most required fields — just the old ad-hoc "hospital_name present" check would have said this was done', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = { item: [{ linkId: 'section_hospital', item: [stringAnswer('hospital_name', 'Only A Name')] }] };

        const res = await app.request('/api/facility/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.valid).toBe(false);
        expect(body.errors.length).toBeGreaterThan(0);
        expect(body.errors.some((e) => e.path === 'Organization.address')).toBe(true);
        expect(body.nextActions).toEqual([]); // never suggests a next step off an invalid facility
    });

    it('reports no facility captured yet distinctly from an incomplete one', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const res = await app.request('/api/facility/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson: { item: [] } }),
        }, baseEnv);
        const body = await res.json();
        expect(body.valid).toBe(false);
        expect(body.organization).toBeNull();
    });

    it('the real chain: a fully completed real HFR-grounded facility validates clean AND surfaces real next-best-actions off the real GraphDefinition', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = { item: [{ linkId: 'section_hospital', item: completeHospitalAnswers() }] };

        const res = await app.request('/api/facility/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.valid).toBe(true);
        expect(body.errors).toEqual([]);
        expect(body.organization.resourceType).toBe('Organization');

        // Both real reverse-link candidates off ClinuxFlowOnboardingGraph (SPEC-24 §3) — a valid
        // Facility can always take another staff role and another organization affiliation.
        const linkIds = body.nextActions.map((a) => a.linkId);
        expect(linkIds).toContain('role-at-facility');
        expect(linkIds).toContain('affiliation-from-facility');
        expect(body.nextActions.every((a) => a.sourceResourceId === body.organization.id)).toBe(true);
    });
});

describe('POST /api/provider/conformance', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }
    async function compiledQuestionnaire() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'), 'utf8');
        return compileYamlToQuestionnaire(yamlSource).questionnaire;
    }
    function stringAnswer(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/provider/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('400s when responseJson is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/provider/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('reports an empty providers list when no staff have been captured yet', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const res = await app.request('/api/provider/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson: { item: [] } }),
        }, baseEnv);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.providers).toEqual([]);
    });

    it('the real chain: two staff members, each a real, correctly-paired Practitioner + PractitionerRole, auto-linked to the same real Organization', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = {
            item: [
                { linkId: 'section_hospital', item: [stringAnswer('hospital_name', 'ABC Hospital')] },
                { linkId: 'section_staff', item: [
                    stringAnswer('staff_first_name', 'Priya'), stringAnswer('staff_last_name', 'Rao'),
                    stringAnswer('staff_email', 'priya@example.com'), stringAnswer('staff_hprid', 'priya@hpr.abdm'),
                    stringAnswer('staff_hp_category_code', '1'), stringAnswer('staff_hp_subcategory_code', '1'),
                ] },
                { linkId: 'section_staff_role', item: [
                    { linkId: 'staff_role_active', answer: [{ valueBoolean: true }] },
                    stringAnswer('staff_provider_role', 'Healthcare Professional'),
                ] },
                { linkId: 'section_staff', item: [
                    stringAnswer('staff_first_name', 'Arjun'), stringAnswer('staff_last_name', 'Mehta'),
                ] },
                { linkId: 'section_staff_role', item: [
                    stringAnswer('staff_provider_role', 'Facility Manager'),
                ] },
            ],
        };

        const res = await app.request('/api/provider/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.providers).toHaveLength(2);
        const priya = body.providers.find((p) => p.practitioner.name[0].given?.includes('Priya'));
        const arjun = body.providers.find((p) => p.practitioner.name[0].given?.includes('Arjun'));

        // Priya has a real license/HPR-id/category set but no license (identifier slicing is a
        // known, deliberately deferred gap — see the YAML's own comment); Arjun has almost nothing.
        // Role vs entitlement: the HPR role is an entitlement source (extension hpr-role); the
        // professional role (SNOMED CT, from the HPR category) is PractitionerRole.code.
        expect(priya.role.extension).toEqual(expect.arrayContaining([{ url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-role', valueString: 'Healthcare Professional' }]));
        expect(priya.role.code?.[0]?.coding?.[0]?.system ?? 'http://snomed.info/sct').toBe('http://snomed.info/sct');
        expect(priya.role.practitioner.reference).toBe(`Practitioner/${priya.practitioner.id}`);
        expect(arjun.role.extension).toEqual(expect.arrayContaining([{ url: 'https://clinux.yaxb.ai/fhir/StructureDefinition/hpr-role', valueString: 'Facility Manager' }]));
        expect(arjun.role.practitioner.reference).toBe(`Practitioner/${arjun.practitioner.id}`);
        // Neither role got cross-linked to the OTHER practitioner — the real bug this whole chain exists to catch.
        expect(priya.role.practitioner.reference).not.toBe(arjun.role.practitioner.reference);

        expect(priya.roleValid).toBe(true); // PractitionerRole itself has no deferred-slicing gap
        expect(priya.practitionerValid).toBe(false); // telecom:email/identifier:hprId slicing — known, deferred
        expect(arjun.practitionerErrors.length).toBeGreaterThan(priya.practitionerErrors.length); // Arjun genuinely has less captured
    });
});

describe('POST /api/affiliate-organization/conformance', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }
    async function compiledQuestionnaire() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-provider-composition-v1.yaml'), 'utf8');
        return compileYamlToQuestionnaire(yamlSource).questionnaire;
    }
    function stringAnswer(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }
    function multiAnswer(linkId, values) { return { linkId, answer: values.map((v) => ({ valueString: v })) }; }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/affiliate-organization/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('reports an empty list when none have been captured yet', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const res = await app.request('/api/affiliate-organization/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson: { item: [] } }),
        }, baseEnv);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.affiliations).toEqual([]);
    });

    it('the real chain: a real OrganizationAffiliation, auto-linked to this facility\'s own Organization, validated with real MultiSelect-produced arrays', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = {
            item: [
                { linkId: 'section_hospital', item: [stringAnswer('hospital_name', 'ABC Hospital')] },
                { linkId: 'section_affiliate_organization', item: [
                    stringAnswer('affiliate_org_name', 'City Diagnostics Lab'),
                    multiAnswer('affiliate_org_relationship', ['Diagnostics', 'Laboratory']),
                    { linkId: 'affiliate_org_active', answer: [{ valueBoolean: true }] },
                ] },
            ],
        };

        const res = await app.request('/api/affiliate-organization/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.affiliations).toHaveLength(1);
        const org = body.affiliations[0].organizationAffiliation;
        expect(org.participatingOrganization).toBe('City Diagnostics Lab');
        expect(org.code).toEqual([{ text: 'Diagnostics' }, { text: 'Laboratory' }]); // both MultiSelect answers survived, not truncated to the first
        expect(org.organization.reference).toMatch(/^Organization\//); // auto-linked, never a form field
        expect(body.affiliations[0].valid).toBe(true); // active + code + organization + participatingOrganization all present

        // Two real, distinct next-best-action behaviors, both correct given how this entity is
        // actually captured (see the YAML's own comment on why participatingOrganization is a
        // plain string, not a real Reference): (1) 'affiliation-from-facility' (reverse, source =
        // the Facility Organization) stays suppressed — this Organization only has hospital_name
        // set, genuinely invalid, already covered by the facility conformance tests. (2)
        // 'affiliate-partner-org' (forward, source = this valid OrganizationAffiliation) DOES
        // fire — participatingOrganization has no `.reference` to resolve (it's a bare string,
        // not a real target Organization instance), so next-best-action.js correctly reports the
        // partner org as not-yet-linked, an honest reflection of the real capture gap rather than
        // a false "done".
        expect(body.nextActions.map((a) => a.linkId)).toEqual(['affiliate-partner-org']);
    });

    it('reports a real cardinality error when a required field is missing (no relationship code)', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = {
            item: [
                { linkId: 'section_hospital', item: [stringAnswer('hospital_name', 'ABC Hospital')] },
                { linkId: 'section_affiliate_organization', item: [stringAnswer('affiliate_org_name', 'City Diagnostics Lab')] },
            ],
        };

        const res = await app.request('/api/affiliate-organization/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        const body = await res.json();
        expect(body.affiliations[0].valid).toBe(false);
        expect(body.affiliations[0].errors.some((e) => e.path === 'OrganizationAffiliation.code')).toBe(true);
    });
});

// Generic StructureDefinition-anchored conformance/search/save (resource-registry.js,
// resource-records-db.js, migrations/0013) — the real fix for the 5 hand-copied conformance
// endpoints above. Patient is the only registered resourceType this pass.
describe('POST /api/resources/:resourceType/conformance', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }
    async function compiledQuestionnaire() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-patient-profile-v1.yaml'), 'utf8');
        return compileYamlToQuestionnaire(yamlSource).questionnaire;
    }
    function stringAnswer(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/resources/Patient/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('404s for an unregistered resourceType — honest, not a silent no-op', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/resources/Observation/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(404);
    });

    it('400s when responseJson is missing', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/resources/Patient/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {} }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it('reports no patient captured yet distinctly from an incomplete one, with no nextActions', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const res = await app.request('/api/resources/Patient/conformance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson: { item: [] } }),
        }, baseEnv);
        const body = await res.json();
        expect(body.valid).toBe(false);
        expect(body.resource).toBeNull();
        expect(body.nextActions).toEqual([]);
    });

    it('the real chain: a fully-captured patient is now fully conformant — the former Patient.telecom:mobile slicing gap is closed by the mobile slice', async () => {
        // Same fixture the now-retired POST /api/patient/conformance's own test suite proved
        // this exact result against before the cutover — kept as a regression anchor so this
        // route stays behaviorally equivalent to what it replaced, without a second live route
        // to compare against any more.
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = { item: [{ linkId: 'section_patient', item: [
            stringAnswer('patient_name', 'Arjun Verma'),
            stringAnswer('patient_first_name', 'Arjun'),
            stringAnswer('patient_last_name', 'Verma'),
            { linkId: 'patient_active', answer: [{ valueBoolean: true }] },
            stringAnswer('patient_gender', 'male'),
            { linkId: 'patient_birthdate', answer: [{ valueDate: '1990-01-01' }] },
            stringAnswer('patient_mobile', '9876543210'),
        ] }] };

        const res = await app.request('/api/resources/Patient/conformance', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson }),
        }, baseEnv);
        const body = await res.json();
        expect(body.resource.name[0].given).toEqual(['Arjun']);
        expect(body.resource.name[0].family).toBe('Verma');
        expect(body.resource.active).toBe(true);
        expect(body.errors.some((e) => e.path === 'Patient.name.given')).toBe(false);
        // The formerly known-deferred Patient.telecom:mobile slicing gap is closed: patient_mobile
        // now writes the mobile slice (data/ig-conformance.json: system phone, use mobile).
        expect(body.errors).toEqual([]);
        expect(body.resource.telecom).toEqual([{ system: 'phone', use: 'mobile', value: expect.any(String) }]);
    });

    it("surfaces the real Patient-graph next-action once valid — mocked past the known-deferred telecom:mobile capture gap to isolate this route's own conformance -> next-best-action wiring", async () => {
        const { ComprehensiveLocalExtractor } = await import('./lib/shared/local-extractor.js');
        vi.spyOn(ComprehensiveLocalExtractor, 'extract').mockReturnValue([{
            resourceType: 'Patient', id: 'pat-1', active: true,
            name: [{ given: ['Arjun'], family: 'Verma' }],
            gender: 'male', birthDate: '1990-01-01',
            telecom: [{ system: 'phone', use: 'mobile', value: '9876543210' }],
        }]);
        const token = await tokenFor();
        const res = await app.request('/api/resources/Patient/conformance', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {} }),
        }, baseEnv);
        const body = await res.json();
        expect(body.valid).toBe(true);
        expect(body.nextActions).toEqual([{
            resourceType: 'Encounter', profiles: [], reason: expect.any(String),
            linkId: 'encounters-for-patient', sourceResourceId: 'pat-1',
        }]);
    });
});

describe('GET /api/resources/:resourceType/search', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/resources/Patient/search?q=arjun', { headers: { 'X-Service-Key': SERVICE_KEY } }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a free-tier caller — cross-device search is a paid-tier capability', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/resources/Patient/search?q=arjun', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('404s for an unregistered resourceType', async () => {
        const token = await tokenFor();
        const res = await app.request('/api/resources/Observation/search', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(404);
    });

    it("200s and returns matching records, scoped to the caller's own clinic", async () => {
        const searchSpy = vi.spyOn(ResourceRecordsDb, 'search').mockResolvedValue([
            { id: 'rec-1', data: JSON.stringify({ resourceType: 'Patient', id: 'rec-1', name: [{ text: 'Arjun Verma' }] }), updatedAt: '2026-01-01' },
        ]);
        const token = await tokenFor();
        const res = await app.request('/api/resources/Patient/search?q=arjun', { headers: { 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` } }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.records).toHaveLength(1);
        expect(body.records[0].resource.name[0].text).toBe('Arjun Verma');
        expect(searchSpy).toHaveBeenCalledWith(baseEnv.DB, 'Patient', 'clinic1', 'arjun');
    });
});

describe('POST /api/resources/:resourceType/save', () => {
    async function tokenFor(clinicId = 'clinic1', accountId = 'acc1', email = 'admin@a.com') {
        const { issueSessionToken } = await import('./lib/shared/session.js');
        return issueSessionToken({ sub: accountId, clinicId, email }, JWT_SECRET);
    }
    async function compiledQuestionnaire() {
        const { compileYamlToQuestionnaire } = await import('./lib/shared/yaml-to-questionnaire.js');
        const fs = await import('fs');
        const path = await import('path');
        const yamlSource = fs.readFileSync(path.join(process.cwd(), 'tools', 'system-forms', 'system-patient-profile-v1.yaml'), 'utf8');
        return compileYamlToQuestionnaire(yamlSource).questionnaire;
    }
    function stringAnswer(linkId, value) { return { linkId, answer: [{ valueString: value }] }; }

    beforeEach(() => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
    });

    it('401s with no Authorization header', async () => {
        const res = await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {}, recordId: 'rec-1' }),
        }, baseEnv);
        expect(res.status).toBe(401);
    });

    it('403s a free-tier caller', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await tokenFor();
        const res = await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson: {}, responseJson: {}, recordId: 'rec-1' }),
        }, baseEnv);
        expect(res.status).toBe(403);
    });

    it('400s when recordId is missing — the stable identity every save needs', async () => {
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const res = await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson: { item: [] } }),
        }, baseEnv);
        expect(res.status).toBe(400);
    });

    it("saves even an incomplete/invalid patient — persistence is not gated on valid:true (see the route's own header comment)", async () => {
        const upsertSpy = vi.spyOn(ResourceRecordsDb, 'upsert').mockResolvedValue({ meta: { rows_written: 1 } });
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = { item: [{ linkId: 'section_patient', item: [stringAnswer('patient_name', 'Only A Name')] }] };
        const res = await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson, recordId: 'rec-1' }),
        }, baseEnv);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(body.valid).toBe(false);
        expect(body.resource.id).toBe('rec-1'); // recordId overrides the extractor's own freshly-minted id
        expect(upsertSpy).toHaveBeenCalledWith(baseEnv.DB, 'Patient', 'rec-1', 'clinic1', expect.any(String), expect.any(Object));
    });

    it('re-saving the same recordId upserts the same row, not a duplicate — the whole reason recordId is required', async () => {
        const upsertSpy = vi.spyOn(ResourceRecordsDb, 'upsert').mockResolvedValue({ meta: { rows_written: 1 } });
        const token = await tokenFor();
        const questionnaireJson = await compiledQuestionnaire();
        const responseJson = { item: [{ linkId: 'section_patient', item: [stringAnswer('patient_name', 'Arjun Verma')] }] };
        await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson, recordId: 'rec-1' }),
        }, baseEnv);
        await app.request('/api/resources/Patient/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_KEY, Authorization: `Bearer ${token}` },
            body: JSON.stringify({ questionnaireJson, responseJson, recordId: 'rec-1' }),
        }, baseEnv);
        expect(upsertSpy).toHaveBeenCalledTimes(2);
        expect(upsertSpy.mock.calls[0][2]).toBe('rec-1');
        expect(upsertSpy.mock.calls[1][2]).toBe('rec-1');
    });
});
