import { describe, it, expect, vi, afterEach } from 'vitest';
import { RealtimeClient } from './realtime-client.js';

function fakeFetch(status, body) {
    return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    });
}

afterEach(() => vi.unstubAllGlobals());

describe('RealtimeClient.createMeeting', () => {
    it('POSTs to the meetings endpoint with the Bearer token and returns the created meeting id', async () => {
        // Envelope shape (`data`, not `result`) confirmed live against a real Cloudflare
        // RealtimeKit account, not guessed from docs -- see realtime-client.js's own comment.
        const fetchSpy = fakeFetch(201, { success: true, data: { id: 'cf-meeting-1' } });
        vi.stubGlobal('fetch', fetchSpy);

        const id = await RealtimeClient.createMeeting('acct1', 'app1', 'tok', 'My Meeting');
        expect(id).toBe('cf-meeting-1');

        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/realtime/kit/app1/meetings');
        expect(options.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(options.body)).toEqual({ title: 'My Meeting' });
    });

    it('throws when Cloudflare responds with success: false', async () => {
        vi.stubGlobal('fetch', fakeFetch(200, { success: false, errors: [{ message: 'bad token' }] }));
        await expect(RealtimeClient.createMeeting('acct1', 'app1', 'tok', 'x')).rejects.toThrow(/bad token/);
    });

    it('throws on a non-2xx HTTP status even without a parseable success flag', async () => {
        vi.stubGlobal('fetch', fakeFetch(401, null));
        await expect(RealtimeClient.createMeeting('acct1', 'app1', 'tok', 'x')).rejects.toThrow(/401/);
    });
});

describe('RealtimeClient.addParticipant', () => {
    it('POSTs to the participants endpoint and returns the token', async () => {
        // Field name (`token`, not `authToken`/`auth_token`) confirmed live against a real
        // Cloudflare RealtimeKit account -- both those earlier guesses turned out wrong.
        const fetchSpy = fakeFetch(201, { success: true, data: { token: 'cf-token-abc' } });
        vi.stubGlobal('fetch', fetchSpy);

        const token = await RealtimeClient.addParticipant('acct1', 'app1', 'tok', 'meeting1', {
            name: 'Dr A', presetName: 'group_call_host', customParticipantId: 'acc1',
        });
        expect(token).toBe('cf-token-abc');

        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/realtime/kit/app1/meetings/meeting1/participants');
        expect(JSON.parse(options.body)).toEqual({ name: 'Dr A', preset_name: 'group_call_host', custom_participant_id: 'acc1' });
    });
});
