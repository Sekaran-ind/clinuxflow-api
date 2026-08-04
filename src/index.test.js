import { describe, it, expect, vi, afterEach } from 'vitest';
import app from './index.js';
import { AccountsDb } from './lib/accounts-db.js';
import { hashPassword } from './lib/passwordHash.js';

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
