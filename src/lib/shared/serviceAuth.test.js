import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { serviceKeyAuth } from './serviceAuth.js';

function buildApp() {
    const app = new Hono();
    app.use('*', serviceKeyAuth());
    app.get('/protected', (c) => c.text('secret'));
    return app;
}

describe('serviceKeyAuth', () => {
    it('rejects a request with no key header', async () => {
        const res = await buildApp().request('/protected', {}, { SERVICE_KEY: 'right-key' });
        expect(res.status).toBe(401);
    });

    it('rejects a request with the wrong key', async () => {
        const res = await buildApp().request(
            '/protected',
            { headers: { 'X-Service-Key': 'wrong-key' } },
            { SERVICE_KEY: 'right-key' }
        );
        expect(res.status).toBe(401);
    });

    it('allows a request through with the correct key', async () => {
        const res = await buildApp().request(
            '/protected',
            { headers: { 'X-Service-Key': 'right-key' } },
            { SERVICE_KEY: 'right-key' }
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('secret');
    });

    it('exempts a listed path even without a key', async () => {
        const app = new Hono();
        app.use('*', serviceKeyAuth({ exemptPaths: ['/open'] }));
        app.get('/open', (c) => c.text('open'));
        const res = await app.request('/open', {}, { SERVICE_KEY: 'right-key' });
        expect(res.status).toBe(200);
    });

    // Fails closed: an unset/empty SERVICE_KEY must never be treated as "auth disabled", even
    // if a caller happens to send a matching empty string.
    it('rejects everything when SERVICE_KEY is not configured, even a matching empty key', async () => {
        const res = await buildApp().request(
            '/protected',
            { headers: { 'X-Service-Key': '' } },
            { SERVICE_KEY: '' }
        );
        expect(res.status).toBe(401);
    });
});
