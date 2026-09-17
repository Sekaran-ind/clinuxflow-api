import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './passwordHash.js';

describe('hashPassword / verifyPassword', () => {
    it('round-trips: verifyPassword succeeds against the hash of the same plaintext', async () => {
        const hash = await hashPassword('correct-horse-battery-staple');
        await expect(verifyPassword('correct-horse-battery-staple', hash)).resolves.toBe(true);
    });

    it('rejects the wrong password', async () => {
        const hash = await hashPassword('correct-horse-battery-staple');
        await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
    });

    it('produces a different hash each time (random salt), even for the same password', async () => {
        const a = await hashPassword('same-password');
        const b = await hashPassword('same-password');
        expect(a).not.toBe(b);
        await expect(verifyPassword('same-password', a)).resolves.toBe(true);
        await expect(verifyPassword('same-password', b)).resolves.toBe(true);
    });

    it('stores a self-describing pbkdf2-sha256$<iterations>$<salt>$<hash> format', async () => {
        const hash = await hashPassword('x');
        expect(hash).toMatch(/^pbkdf2-sha256\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    });

    it('returns false (never throws) for malformed/garbage stored hashes', async () => {
        await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
        await expect(verifyPassword('x', 'pbkdf2-sha256$abc$salt$hash')).resolves.toBe(false); // non-numeric iterations
        await expect(verifyPassword('x', 'pbkdf2-sha256$100000$not-base64!!!$hash')).resolves.toBe(false);
        await expect(verifyPassword('x', '')).resolves.toBe(false);
        await expect(verifyPassword('x', 'wrong-scheme$100000$c2FsdA==$aGFzaA==')).resolves.toBe(false);
    });
});
