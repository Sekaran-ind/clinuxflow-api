import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { requireUser, requirePaidTier } from './userAuth.js';
import { issueSessionToken } from './session.js';
import { AccountsDb } from './accounts-db.js';

afterEach(() => vi.restoreAllMocks());

function buildApp() {
    const app = new Hono();
    app.use('*', requireUser());
    app.get('/protected', (c) => c.json({ user: c.get('user') }));
    return app;
}

describe('requireUser', () => {
    it('rejects a request with no Authorization header', async () => {
        const res = await buildApp().request('/protected', {}, { JWT_SECRET: 'secret' });
        expect(res.status).toBe(401);
    });

    it('rejects a malformed Authorization header (no Bearer prefix)', async () => {
        const res = await buildApp().request(
            '/protected', { headers: { Authorization: 'sometoken' } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(401);
    });

    it('rejects a tampered/invalid token', async () => {
        const res = await buildApp().request(
            '/protected', { headers: { Authorization: 'Bearer not-a-real-jwt' } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(401);
    });

    // Fails closed: an unset JWT_SECRET must never be treated as "auth disabled".
    it('rejects everything when JWT_SECRET is not configured', async () => {
        const token = await issueSessionToken({ sub: 'a', clinicId: 'c', email: 'e' }, 'irrelevant');
        const res = await buildApp().request(
            '/protected', { headers: { Authorization: `Bearer ${token}` } }, { JWT_SECRET: '' }
        );
        expect(res.status).toBe(401);
    });

    it('allows a valid token through and sets c.get("user")', async () => {
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret');
        const res = await buildApp().request(
            '/protected', { headers: { Authorization: `Bearer ${token}` } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ user: { accountId: 'acc1', clinicId: 'clinic1', email: 'a@b.com' } });
    });
});

function buildTierApp() {
    const app = new Hono();
    app.use('*', requireUser());
    app.use('*', requirePaidTier());
    app.get('/ai-feature', (c) => c.json({ ok: true }));
    return app;
}

describe('requirePaidTier', () => {
    it('403s a free-tier clinic', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'free' });
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret');
        const res = await buildTierApp().request(
            '/ai-feature', { headers: { Authorization: `Bearer ${token}` } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(403);
    });

    it('allows a paid-tier clinic through', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue({ id: 'clinic1', tier: 'paid' });
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret');
        const res = await buildTierApp().request(
            '/ai-feature', { headers: { Authorization: `Bearer ${token}` } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(200);
    });

    it('fails closed (403, not 500) if the clinic row is missing', async () => {
        vi.spyOn(AccountsDb, 'getClinicById').mockResolvedValue(null);
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'ghost', email: 'a@b.com' }, 'secret');
        const res = await buildTierApp().request(
            '/ai-feature', { headers: { Authorization: `Bearer ${token}` } }, { JWT_SECRET: 'secret' }
        );
        expect(res.status).toBe(403);
    });
});
