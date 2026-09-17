import { describe, it, expect } from 'vitest';
import { issueSessionToken, verifySessionToken } from './session.js';

describe('issueSessionToken / verifySessionToken', () => {
    it('round-trips a payload', async () => {
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret');
        const payload = await verifySessionToken(token, 'secret');
        expect(payload).toMatchObject({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' });
        expect(payload.iat).toBeTypeOf('number');
        expect(payload.exp).toBeTypeOf('number');
    });

    it('rejects an expired token', async () => {
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret', -10);
        await expect(verifySessionToken(token, 'secret')).rejects.toBeTruthy();
    });

    it('rejects a token verified with the wrong secret', async () => {
        const token = await issueSessionToken({ sub: 'acc1', clinicId: 'clinic1', email: 'a@b.com' }, 'secret');
        await expect(verifySessionToken(token, 'wrong-secret')).rejects.toBeTruthy();
    });

    it('rejects a garbage token', async () => {
        await expect(verifySessionToken('not.a.jwt', 'secret')).rejects.toBeTruthy();
    });
});
