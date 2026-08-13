// Thin wrapper around Cloudflare's RealtimeKit REST API (https://api.cloudflare.com/client/v4/
// accounts/{account_id}/realtime/kit/...). Structured as an object of methods (not standalone
// exported functions) so tests can vi.spyOn() individual calls, same convention AccountsDb
// already uses.
//
// Response shape CONFIRMED live against a real account (curl, not guessed from docs): the
// envelope key is `data`, not the `result` key most other Cloudflare v4 API endpoints use — this
// RealtimeKit sub-API is the exception. The add-participant response's token field is literally
// `token` (not `authToken`/`auth_token`, both of which were reasonable guesses from Cloudflare's
// own prose-only docs and turned out wrong). Fixed after the first live test call.
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function cfRequest(apiToken, path, body) {
    const res = await fetch(`${CF_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
        const detail = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
        throw new Error(`Cloudflare RealtimeKit request failed: ${detail}`);
    }
    return json.data;
}

export const RealtimeClient = {
    // Creates a new meeting inside the given RealtimeKit app. Returns Cloudflare's own generated
    // meeting id.
    createMeeting: async (accountId, appId, apiToken, title) => {
        const data = await cfRequest(apiToken, `/accounts/${accountId}/realtime/kit/${appId}/meetings`, { title });
        return data.id;
    },

    // Adds one participant to an existing meeting and returns the short-lived token the CLIENT
    // uses to join -- this is the one thing the browser is ever handed; the account-level API
    // token (apiToken here) never leaves this Worker.
    addParticipant: async (accountId, appId, apiToken, meetingId, { name, presetName, customParticipantId }) => {
        const data = await cfRequest(
            apiToken,
            `/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/participants`,
            { name, preset_name: presetName, custom_participant_id: customParticipantId }
        );
        return data.token;
    },
};
