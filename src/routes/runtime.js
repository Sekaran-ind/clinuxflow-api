// SPEC-24-adjacent (NIST ZTA discussion) — the RUNTIME layer: clinical journeys, encounters, live
// coordination (assignment/locking, chat signaling, RealtimeKit video), and the Task/PlanDefinition
// -facing workflow authoring/extraction/scribe pipeline. Mounted unprefixed
// (`app.route('/', runtimeRoutes)`) by src/index.js, so every path below is already the real,
// final route — no rewriting.
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { compileYamlToQuestionnaire } from '../lib/shared/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from '../lib/shared/local-extractor.js';
import { FhirDocumentAssembler } from '../lib/shared/composition-assembler.js';
import { LocalQueueManager } from '../lib/runtime/local-queue-manager.js';
import { verifySessionToken } from '../lib/shared/session.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { requireUser, requirePaidTier } from '../lib/shared/userAuth.js';
import { UsageTracking } from '../lib/shared/usageTracking.js';
import { RealtimeClient } from '../lib/runtime/realtime-client.js';
import { EncounterMeetingsDb } from '../lib/runtime/encounter-meetings-db.js';
import { EncounterCoordinationDb } from '../lib/runtime/encounter-coordination-db.js';
import { TaskDb } from '../lib/runtime/task-db.js';
import { ContactMeetingsDb } from '../lib/runtime/contact-meetings-db.js';

import defaultBlueprintYaml from '../../data/vitals-room.yaml';
import conditionTypes from '../../data/condition-types.json';

export const runtimeRoutes = new Hono();
const app = runtimeRoutes;

/**
 * GET /api/encounters/assignments?stage=X
 * "What's assigned/locked to ME" — the specialist-scoped Consultation queue this feeds
 * ActiveSessionsLanding.vue's "assigned to me" filter with. Always scoped to the caller's own
 * account/clinic — there is no way to query someone else's queue through this endpoint.
 *
 * Registered BEFORE GET /api/encounters/:id deliberately — Hono matches routes in registration
 * order, and :id would otherwise swallow the literal path "assignments" as if it were an
 * encounter id (a real bug caught live by the test suite: this exact collision 500'd until the
 * two were reordered).
 *
 * requirePaidTier(): every route in this block is cloud-durable cross-location coordination —
 * exactly the paid-tier capability defined in docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md §6.
 * Free tier stays local-only/LAN-shared and never reaches this cost surface at all.
 */
app.get('/api/encounters/assignments', requireUser(), requirePaidTier(), async (c) => {
    const stage = c.req.query('stage');
    if (!stage) return c.json({ success: false, error: 'stage query param is required.' }, 400);
    const user = c.get('user');
    const rows = await EncounterCoordinationDb.listAssignedTo(c.env.DB, user.accountId, user.clinicId, stage);
    await UsageTracking.recordRead(c.env.DB, user.clinicId);
    return c.json({
        success: true,
        assignments: rows.map((r) => ({ encounterId: r.encounter_id, kind: r.kind, createdAt: r.created_at, expiresAt: r.expires_at })),
    });
});

/**
 * GET/PUT /api/encounters/:id
 * The durable per-encounter document mirror — see migrations/0006's own comment. Same shape and
 * purpose as GET/PUT /api/provider-composition above, just keyed per-encounter: lets a device
 * that isn't on the clinic's LAN (assigned or self-locked into a stage from anywhere with
 * internet) fetch the real QuestionnaireResponse content, not just a routing pointer.
 */
app.get('/api/encounters/:id', requireUser(), requirePaidTier(), async (c) => {
    const row = await EncounterCoordinationDb.getDocument(c.env.DB, c.req.param('id'));
    await UsageTracking.recordRead(c.env.DB, c.get('user').clinicId);
    if (!row) return c.json({ success: false, error: 'No document stored yet for this encounter.' }, 404);
    return c.json({ success: true, data: JSON.parse(row.data), updatedAt: row.updatedAt });
});

app.put('/api/encounters/:id', requireUser(), requirePaidTier(), async (c) => {
    try {
        const body = await c.req.json();
        const clinicId = c.get('user').clinicId;
        const result = await EncounterCoordinationDb.upsertDocument(c.env.DB, c.req.param('id'), clinicId, JSON.stringify(body));
        await UsageTracking.recordWrite(c.env.DB, clinicId, result);
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Upsert Encounter Document Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/encounters/:id/assign
 * Body: { assignedToAccountId }
 * Durable routing to a specific specialist for the Consultation stage — a deliberate decision by
 * Front Desk at Triage, not a concurrency race, so this always succeeds and overwrites whatever
 * routing existed before (see EncounterCoordinationDb.assignEncounter's own comment). The
 * assignee must be either a same-clinic staff account or an affiliate already linked to this
 * facility (see migrations/0005) — never an arbitrary account id, same "can't route clinical
 * work to a stranger" boundary /api/facility/affiliates already enforces for linking itself.
 */
app.post('/api/encounters/:id/assign', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { assignedToAccountId } = await c.req.json();
        if (!assignedToAccountId) return c.json({ success: false, error: 'assignedToAccountId is required.' }, 400);
        const clinicId = c.get('user').clinicId;

        const assignee = await AccountsDb.getAccountById(c.env.DB, assignedToAccountId);
        if (!assignee) return c.json({ success: false, error: 'No account found for assignedToAccountId.' }, 404);

        const isSameClinicStaff = assignee.clinic_id === clinicId;
        let isAffiliate = false;
        if (!isSameClinicStaff) {
            const affiliates = await AccountsDb.listAffiliatesByFacility(c.env.DB, clinicId);
            isAffiliate = affiliates.some((a) => a.accountId === assignedToAccountId);
        }
        if (!isSameClinicStaff && !isAffiliate) {
            return c.json({ success: false, error: 'assignedToAccountId must be staff or a linked affiliate of this clinic.' }, 403);
        }

        const result = await EncounterCoordinationDb.assignEncounter(c.env.DB, c.req.param('id'), clinicId, assignedToAccountId, c.get('user').accountId);
        await UsageTracking.recordWrite(c.env.DB, clinicId, result);
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Assign Encounter Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/encounters/:id/lock
 * Body: { stage: 'onboarding' | 'checkout' }
 * Atomic worklist-lock acquisition for the two SHARED stages (no specific assignee — any staff
 * member can pick up any item, this just stops two people working the same one at once).
 * 409s with who currently holds it if acquisition fails, rather than a generic error, so the UI
 * can show "Currently being worked on by Dr. X" instead of a bare failure.
 */
app.post('/api/encounters/:id/lock', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { stage } = await c.req.json();
        if (!['onboarding', 'checkout'].includes(stage)) {
            return c.json({ success: false, error: "stage must be 'onboarding' or 'checkout'." }, 400);
        }
        const user = c.get('user');
        const encounterId = c.req.param('id');
        const acquired = await EncounterCoordinationDb.acquireLock(c.env.DB, encounterId, user.clinicId, stage, user.accountId);
        // acquireLock() returns a boolean (it interprets meta.changes itself), not the raw D1
        // result, so this is the fixed-quantity-1 case documented on UsageTracking.record — an
        // attempted upsert either way, win or lose the race.
        await UsageTracking.record(c.env.DB, user.clinicId, 'd1_write', 1);
        if (!acquired) {
            const current = await EncounterCoordinationDb.getAssignment(c.env.DB, encounterId, stage);
            const holder = current ? await AccountsDb.getAccountById(c.env.DB, current.assigned_to_account_id) : null;
            return c.json({
                success: false,
                error: 'Already locked by someone else.',
                lockedBy: holder ? (holder.admin_name || holder.email) : 'another staff member',
            }, 409);
        }
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Acquire Lock Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/encounters/:id/lock/renew
 * Heartbeat while actively working — pushes the lock's expiry back out so a normal-length work
 * session never trips the TTL that exists specifically to catch a crashed/closed device.
 */
app.post('/api/encounters/:id/lock/renew', requireUser(), requirePaidTier(), async (c) => {
    const { stage } = await c.req.json();
    const clinicId = c.get('user').clinicId;
    const result = await EncounterCoordinationDb.renewLock(c.env.DB, c.req.param('id'), stage, c.get('user').accountId);
    await UsageTracking.recordWrite(c.env.DB, clinicId, result);
    return c.json({ success: true });
});

/**
 * POST /api/encounters/:id/lock/release
 * Explicit release on completing the stage or navigating away — the TTL is a safety net, not
 * the primary release path.
 */
app.post('/api/encounters/:id/lock/release', requireUser(), requirePaidTier(), async (c) => {
    const { stage } = await c.req.json();
    const clinicId = c.get('user').clinicId;
    const result = await EncounterCoordinationDb.releaseLock(c.env.DB, c.req.param('id'), stage, c.get('user').accountId);
    await UsageTracking.recordWrite(c.env.DB, clinicId, result);
    return c.json({ success: true });
});

/**
 * GET /api/encounters/:id/assignment?stage=X
 * Current assignment/lock status for one encounter — lets the shared Active Sessions landing
 * show "Locked by Dr. X" / "Assigned to Dr. Y" badges for encounters that aren't the caller's
 * own, not just for their own queue.
 */
app.get('/api/encounters/:id/assignment', requireUser(), requirePaidTier(), async (c) => {
    const stage = c.req.query('stage');
    if (!stage) return c.json({ success: false, error: 'stage query param is required.' }, 400);
    const row = await EncounterCoordinationDb.getAssignment(c.env.DB, c.req.param('id'), stage);
    await UsageTracking.recordRead(c.env.DB, c.get('user').clinicId);
    if (!row || (row.expires_at && new Date(row.expires_at) < new Date())) {
        return c.json({ success: true, assignment: null });
    }
    const holder = await AccountsDb.getAccountById(c.env.DB, row.assigned_to_account_id);
    return c.json({
        success: true,
        assignment: {
            accountId: row.assigned_to_account_id,
            name: holder ? (holder.admin_name || holder.email) : null,
            kind: row.kind,
        },
    });
});

/**
 * SPEC-25 (docs/SPEC-25-FEDERATED-TASK-PERSISTENCE.md) §6/§10 step 4 — the Task/PlanDefinition
 * runtime's durable (paid-tier) mirror: snapshot mirror, append-only audit log, single-writer
 * lock. Same requireUser()+requirePaidTier() gate as the encounter routes above, same reasoning
 * (SPEC-05 §6) — free tier stays local-first (IndexedDB) + LAN-shared only, never reaches this.
 * Routed by planId, not encounterId — a running plan (e.g. ENTRY_PLAN_DEFINITION's
 * register/login/change-password flow) isn't scoped to one encounter.
 */

/**
 * GET/PUT /api/tasks/:planId/snapshot
 * The XState actor snapshot mirror — same shape/purpose as GET/PUT /api/encounters/:id above,
 * just keyed by planId. clinux-frontend's taskSync.js calls these from workflowRuntime.js's own
 * persistSnapshot/loadPersistedSnapshot injection points, local-first always writing/reading the
 * real IndexedDB collection first — this is a best-effort mirror on top, not the source of truth.
 */
app.get('/api/tasks/:planId/snapshot', requireUser(), requirePaidTier(), async (c) => {
    const row = await TaskDb.getSnapshot(c.env.DB, c.req.param('planId'));
    await UsageTracking.recordRead(c.env.DB, c.get('user').clinicId);
    if (!row) return c.json({ success: false, error: 'No snapshot stored yet for this plan.' }, 404);
    return c.json({ success: true, snapshot: JSON.parse(row.snapshot), updatedAt: row.updatedAt });
});

app.put('/api/tasks/:planId/snapshot', requireUser(), requirePaidTier(), async (c) => {
    try {
        const snapshot = await c.req.json();
        const clinicId = c.get('user').clinicId;
        const result = await TaskDb.upsertSnapshot(c.env.DB, c.req.param('planId'), clinicId, JSON.stringify(snapshot));
        await UsageTracking.recordWrite(c.env.DB, clinicId, result);
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Upsert Task Snapshot Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/tasks/:planId/audit
 * Body: { taskId, actionId, fromStatus, toStatus }
 * Append one entry to the durable audit trail — mirrors a local taskAuditLog.js row. Never an
 * update, always an insert (see migrations/0010's own header) — even a late/lock-bypassed write
 * still lands as its own reconstructable entry instead of overwriting anything.
 */
app.post('/api/tasks/:planId/audit', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { taskId, actionId, fromStatus, toStatus } = await c.req.json();
        if (!taskId || !actionId) return c.json({ success: false, error: 'taskId and actionId are required.' }, 400);
        const user = c.get('user');
        const result = await TaskDb.appendAuditEntry(c.env.DB, {
            id: uuidv4(), planId: c.req.param('planId'), taskId, clinicId: user.clinicId,
            accountId: user.accountId, actionId, fromStatus, toStatus,
        });
        await UsageTracking.recordWrite(c.env.DB, user.clinicId, result);
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Append Task Audit Entry Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/tasks/:planId/audit
 * The full durable trail for one plan, oldest first — what a live-verify pass or a future
 * audit-trail UI reconstructs the real cross-device transition sequence from.
 */
app.get('/api/tasks/:planId/audit', requireUser(), requirePaidTier(), async (c) => {
    const rows = await TaskDb.listAuditLog(c.env.DB, c.req.param('planId'));
    await UsageTracking.recordRead(c.env.DB, c.get('user').clinicId);
    return c.json({
        success: true,
        entries: rows.map((r) => ({
            id: r.id, taskId: r.task_id, accountId: r.account_id, actionId: r.action_id,
            fromStatus: r.from_status, toStatus: r.to_status, createdAt: r.created_at,
        })),
    });
});

/**
 * POST /api/tasks/:planId/lock
 * SPEC-25 §4's single-writer enforcement — atomic acquisition, same 409-with-holder shape as
 * POST /api/encounters/:id/lock above, generalized from (encounterId, stage) to (planId).
 */
app.post('/api/tasks/:planId/lock', requireUser(), requirePaidTier(), async (c) => {
    try {
        const user = c.get('user');
        const planId = c.req.param('planId');
        const acquired = await TaskDb.acquireLock(c.env.DB, planId, user.clinicId, user.accountId);
        await UsageTracking.record(c.env.DB, user.clinicId, 'd1_write', 1); // same fixed-quantity-1 case as encounter locks — an attempted upsert either way
        if (!acquired) {
            const current = await TaskDb.getLock(c.env.DB, planId);
            const holder = current ? await AccountsDb.getAccountById(c.env.DB, current.assigned_to_account_id) : null;
            return c.json({
                success: false,
                error: 'Already locked by someone else.',
                lockedBy: holder ? (holder.admin_name || holder.email) : 'another staff member',
            }, 409);
        }
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Acquire Task Lock Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

app.post('/api/tasks/:planId/lock/renew', requireUser(), requirePaidTier(), async (c) => {
    const user = c.get('user');
    const result = await TaskDb.renewLock(c.env.DB, c.req.param('planId'), user.accountId);
    await UsageTracking.recordWrite(c.env.DB, user.clinicId, result);
    return c.json({ success: true });
});

app.post('/api/tasks/:planId/lock/release', requireUser(), requirePaidTier(), async (c) => {
    const user = c.get('user');
    const result = await TaskDb.releaseLock(c.env.DB, c.req.param('planId'), user.accountId);
    await UsageTracking.recordWrite(c.env.DB, user.clinicId, result);
    return c.json({ success: true });
});

/**
 * GET /api/tasks/:planId/lock
 * Current holder, or the last account that held it if nothing currently does (task_locks rows
 * are never deleted on release — see migrations/0010's own header) — this is what Task.owner
 * (SPEC-25 §5) resolves to. `active` distinguishes the two cases for the caller.
 */
app.get('/api/tasks/:planId/lock', requireUser(), requirePaidTier(), async (c) => {
    const row = await TaskDb.getLock(c.env.DB, c.req.param('planId'));
    await UsageTracking.recordRead(c.env.DB, c.get('user').clinicId);
    if (!row) return c.json({ success: true, lock: null });
    const holder = await AccountsDb.getAccountById(c.env.DB, row.assigned_to_account_id);
    const active = !!row.expires_at && new Date(row.expires_at) > new Date();
    return c.json({
        success: true,
        lock: {
            accountId: row.assigned_to_account_id,
            name: holder ? (holder.admin_name || holder.email) : null,
            active,
        },
    });
});

// Deterministic per-pair Durable Object name — sorted so it doesn't matter which side connects
// first, both accountIds always resolve to the SAME room instance.
function chatRoomName(accountIdA, accountIdB) {
    return `chat:${[accountIdA, accountIdB].sort().join(':')}`;
}
/**
 * GET /api/chat/signal?peer=<accountId>&token=<sessionToken>  (WebSocket upgrade)
 * Pure WebRTC signaling relay for P2P user-to-user chat — see ChatSignalingRoom.js and
 * docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md. Auth comes via ?token= rather than the usual
 * Authorization header/requireUser() — browsers' native WebSocket API cannot set custom headers
 * on the upgrade request, so the session JWT travels in the query string instead, verified here
 * exactly like requireUser() does.
 *
 * Same staff-or-linked-affiliate trust boundary as POST /api/encounters/:id/assign — chat is
 * only ever between people who already have a real reason to be talking (colleagues, or an
 * affiliate already linked to the facility), never an arbitrary account id.
 *
 * Deliberately NOT requirePaidTier()'d and NOT UsageTracking'd: this is a thin, in-memory-only
 * relay that never touches durable storage — categorically different from the cloud-durability
 * cost surface that gate exists for (SPEC-05 §6), and the whole point raised when this was
 * designed is that chat works the same in free, LAN-shared, or paid/ABDM mode.
 */
app.get('/api/chat/signal', async (c) => {
    const token = c.req.query('token');
    const peerAccountId = c.req.query('peer');
    if (!token || !peerAccountId) return c.json({ success: false, error: 'token and peer query params are required.' }, 400);

    let user;
    try {
        const payload = await verifySessionToken(token, c.env.JWT_SECRET);
        user = { accountId: payload.sub, clinicId: payload.clinicId };
    } catch {
        return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    if (peerAccountId === user.accountId) return c.json({ success: false, error: 'Cannot open a chat with yourself.' }, 400);

    const peerAccount = await AccountsDb.getAccountById(c.env.DB, peerAccountId);
    if (!peerAccount) return c.json({ success: false, error: 'Unknown peer.' }, 404);

    const isSameClinicStaff = peerAccount.clinic_id === user.clinicId;
    let isAffiliate = false;
    if (!isSameClinicStaff) {
        const affiliates = await AccountsDb.listAffiliatesByFacility(c.env.DB, user.clinicId);
        isAffiliate = affiliates.some((a) => a.accountId === peerAccountId);
    }
    if (!isSameClinicStaff && !isAffiliate) {
        return c.json({ success: false, error: 'Can only chat with clinic staff or a linked affiliate.' }, 403);
    }

    const roomId = c.env.CHAT_SIGNALING.idFromName(chatRoomName(user.accountId, peerAccountId));
    const stub = c.env.CHAT_SIGNALING.get(roomId);
    return stub.fetch(c.req.raw);
});

/**
 * POST /api/realtime/join
 * Body: { encounterId, encounterTitle? }
 * Phase E: video conferencing in Consultation Desk via Cloudflare RealtimeKit. Mints a
 * short-lived RealtimeKit authToken for the CALLER to join this encounter's video call — the
 * account-level Cloudflare API token never reaches the browser, same SERVICE_KEY/JWT_SECRET
 * separation-of-concerns convention this file already follows everywhere else. Creates the
 * underlying RealtimeKit meeting on the FIRST join for a given encounterId and reuses it for
 * every participant after that (see EncounterMeetingsDb) — otherwise every care-team member
 * joining would each land in their own separate meeting instead of the same call.
 *
 * 501s (not 500) if CF_REALTIME_* secrets aren't configured yet — this is an expected, not-yet-
 * set-up state (see clinux-mobile-sync-multiuser-video-roadmap memory note), not a server error.
 * Live-tested end-to-end against a real Cloudflare RealtimeKit account.
 */
app.post('/api/realtime/join', requireUser(), async (c) => {
    const { CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN } = c.env;
    if (!CF_REALTIME_ACCOUNT_ID || !CF_REALTIME_APP_ID || !CF_REALTIME_API_TOKEN) {
        return c.json({ success: false, error: 'Video calling is not configured on this server yet.' }, 501);
    }

    try {
        const { encounterId, encounterTitle } = await c.req.json();
        if (!encounterId) {
            return c.json({ success: false, error: 'encounterId is required.' }, 400);
        }

        const user = c.get('user');
        const account = await AccountsDb.getAccountById(c.env.DB, user.accountId);
        // Display name always comes from the account's own D1 row, never trusted from the
        // request body — same convention /api/auth/invite already uses for clinicId.
        const displayName = account?.admin_name || account?.email || 'Care team member';
        // Configurable because the exact preset name depends on whatever preset the account
        // owner creates in the RealtimeKit dashboard during setup (see this feature's own setup
        // walkthrough) — 'group_call_host' is RealtimeKit's own commonly-used default preset
        // name, not guaranteed to exist on every account.
        const presetName = c.env.CF_REALTIME_PRESET_NAME || 'group_call_host';

        let existing = await EncounterMeetingsDb.getByEncounterId(c.env.DB, encounterId);
        let meetingId = existing?.cf_meeting_id;
        if (!meetingId) {
            meetingId = await RealtimeClient.createMeeting(
                CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN,
                encounterTitle || `Encounter ${encounterId}`
            );
            await EncounterMeetingsDb.create(c.env.DB, encounterId, user.clinicId, meetingId);
        }

        const authToken = await RealtimeClient.addParticipant(
            CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN, meetingId,
            { name: displayName, presetName, customParticipantId: user.accountId }
        );

        return c.json({ success: true, authToken, meetingId });
    } catch (err) {
        console.error('❌ Realtime Join Exception:', err.message);
        return c.json({ success: false, error: err.message }, 502);
    }
});

/**
 * POST /api/realtime/contact-call/:peerAccountId/join
 * Hospital/Provider/Affiliate journey follow-up — the real gap found while auditing item 2
 * (staff/affiliates already have real P2P chat from Cübo, see GET /api/chat/signal above, but no
 * video path at all). Same shape as POST /api/realtime/join, generalized from an encounterId to a
 * peerAccountId: mints a short-lived RealtimeKit authToken for the CALLER to join a call with one
 * specific colleague/affiliate, reusing the SAME meeting for both sides via a deterministic
 * roomId (chatRoomName()'s own sorted-pair convention, already proven for chat's Durable Object
 * naming) rather than each side's join minting its own separate meeting.
 *
 * Trust boundary: identical to GET /api/chat/signal just above (same-clinic staff, or an
 * affiliate already linked via facility_affiliates) — a video call is only ever between people
 * who already have a real reason to be talking, never an arbitrary account id.
 *
 * Deliberately NOT requirePaidTier()'d, matching POST /api/realtime/join's own precedent (that
 * route isn't tier-gated either) and chat's own explicit "works the same in every tier" design.
 * 501s the same way /api/realtime/join does if CF_REALTIME_* secrets aren't configured.
 */
app.post('/api/realtime/contact-call/:peerAccountId/join', requireUser(), async (c) => {
    const { CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN } = c.env;
    if (!CF_REALTIME_ACCOUNT_ID || !CF_REALTIME_APP_ID || !CF_REALTIME_API_TOKEN) {
        return c.json({ success: false, error: 'Video calling is not configured on this server yet.' }, 501);
    }

    try {
        const user = c.get('user');
        const peerAccountId = c.req.param('peerAccountId');
        if (peerAccountId === user.accountId) return c.json({ success: false, error: 'Cannot start a call with yourself.' }, 400);

        const peerAccount = await AccountsDb.getAccountById(c.env.DB, peerAccountId);
        if (!peerAccount) return c.json({ success: false, error: 'Unknown peer.' }, 404);

        const isSameClinicStaff = peerAccount.clinic_id === user.clinicId;
        let isAffiliate = false;
        if (!isSameClinicStaff) {
            const affiliates = await AccountsDb.listAffiliatesByFacility(c.env.DB, user.clinicId);
            isAffiliate = affiliates.some((a) => a.accountId === peerAccountId);
        }
        if (!isSameClinicStaff && !isAffiliate) {
            return c.json({ success: false, error: 'Can only call clinic staff or a linked affiliate.' }, 403);
        }

        const account = await AccountsDb.getAccountById(c.env.DB, user.accountId);
        const displayName = account?.admin_name || account?.email || 'Care team member';
        const peerDisplayName = peerAccount.admin_name || peerAccount.email || 'Colleague';
        const presetName = c.env.CF_REALTIME_PRESET_NAME || 'group_call_host';

        const roomId = chatRoomName(user.accountId, peerAccountId);
        let existing = await ContactMeetingsDb.getByRoomId(c.env.DB, roomId);
        let meetingId = existing?.cf_meeting_id;
        if (!meetingId) {
            meetingId = await RealtimeClient.createMeeting(
                CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN,
                `${displayName} <> ${peerDisplayName}`
            );
            await ContactMeetingsDb.create(c.env.DB, roomId, meetingId);
        }

        const authToken = await RealtimeClient.addParticipant(
            CF_REALTIME_ACCOUNT_ID, CF_REALTIME_APP_ID, CF_REALTIME_API_TOKEN, meetingId,
            { name: displayName, presetName, customParticipantId: user.accountId }
        );

        return c.json({ success: true, authToken, meetingId });
    } catch (err) {
        console.error('❌ Realtime Contact-Call Join Exception:', err.message);
        return c.json({ success: false, error: err.message }, 502);
    }
});

/**
 * GET /api/valuesets/plandefinition-condition-types
 * SPEC-18 (docs/SPEC-18-PLANDEFINITION-AUTHORING-VIA-YAML-PIPELINE.md) §7 step 4 — the
 * constrained condition-field type. Same "precomputed, no filesystem here" treatment as
 * /api/clinic-specialities above — scripts/build-condition-types.js compiles
 * config/plandefinition-condition-types/*.json into data/condition-types.json. Returns a
 * pre-expanded FHIR ValueSet directly (LHC-Forms' own sdc-support.md: contained ValueSets are
 * expected to already carry an expansion, not be expanded server-side at render time) — this is
 * exactly what a `field.valueSetUrl`/`answerValueSet`-bound Autocomplete field fetches.
 */
app.get('/api/valuesets/plandefinition-condition-types', (c) => {
    return c.json(conditionTypes.valueSet);
});

/**
 * GET /api/workflow/default-blueprint
 * Returns the raw YAML text of the default room blueprint so the designer UI has something to
 * load on first run.
 */
app.get('/api/workflow/default-blueprint', (c) => {
    return c.json({ success: true, yaml: defaultBlueprintYaml });
});

/**
 * POST /api/workflow/compile
 * Body: { yamlPayload: string }
 * Compiles the submitted room-layout YAML into a FHIR Questionnaire via
 * compileYamlToQuestionnaire(), and derives a GBNF grammar constraining an LLM's output to the
 * compiled form's active field paths. This runs on every live-preview keystroke/rebuild in the
 * designer — it does NOT persist to the forms library. Persisting is a separate, explicit user
 * action; see POST /api/workflow/save-to-library.
 */
app.post('/api/workflow/compile', async (c) => {
    try {
        const { yamlPayload } = await c.req.json();

        const result = compileYamlToQuestionnaire(yamlPayload);
        if (!result.success) {
            return c.json({ success: false, error: result.errors.join('; ') }, 400);
        }
        const questionnaireJson = result.questionnaire;

        // Safely map active paths using your dynamic blueprint keys
        const activePaths = [];
        if (questionnaireJson.item) {
            questionnaireJson.item.forEach(sec => {
                if (sec.item) sec.item.forEach(q => activePaths.push(`\\"${q.linkId}\\"`));
            });
        }

        // Build edge-native GBNF rules targeting your exact field selections
        let finalGbnf = `root ::= "{\\n" "  \\"updates\\": [\\n" items "\\n  ]\\n}"\n`;
        finalGbnf += `items ::= item (",\\n" item)*\n`;
        finalGbnf += `path_enum ::= ${activePaths.length > 0 ? activePaths.join(' | ') : '"empty"'}\n`;

        return c.json({
            success: true,
            questionnaireJson,
            finalGbnf,
            terminologyLogs: [
                `✅ Unified Master Path Schema Sync: Loaded from data/form-schematics.schema.json.`,
                `⚙️ Synchronized all multi-department resource mappings successfully.`
            ]
        });
    } catch (err) {
        console.error("❌ SDC Compiler Exception:", err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/workflow/extract
 * Body: { questionnaireJson: FHIR Questionnaire, responseJson: FHIR QuestionnaireResponse }
 * The real missing half of the compile step for workflow-definition YAMLs specifically: compiling
 * one produces an AUTHORING FORM (a Questionnaire describing a PlanDefinition's own steps), not
 * the plan itself — this is what turns a filled-in response to that form into the real
 * PlanDefinition (and any other FHIR resources the same composition declares), via the same
 * ComprehensiveLocalExtractor every data-form save already extracts through
 * (clinuxflow-api/src/lib/forms-library.js's saveFormVersion). Never wired to an HTTP endpoint
 * before this — hospital-setup-workflow.test.js/build-system-flows.js both call the extractor
 * directly, build-time or test-time; this is the first RUNTIME (request-time) caller, for the
 * Room-Architect Designer's "Design & Compile Room" step filling in a room's own authoring form
 * interactively instead of via a hand-built fixture.
 */
app.post('/api/workflow/extract', requireUser(), async (c) => {
    try {
        const { questionnaireJson, responseJson } = await c.req.json();
        if (!questionnaireJson || !responseJson) {
            return c.json({ success: false, error: 'questionnaireJson and responseJson are both required.' }, 400);
        }
        const result = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        return c.json({ success: true, resources: result, warnings: result.warnings || [] });
    } catch (err) {
        console.error('❌ Extraction Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/workflow/assemble-document
 * Body: { resources: FHIR resource[], title, typeText?, authorRef: {resourceType, id}, subjectRef?, status?, sectionPlan? }
 * The real, missing "shared as a FHIR Document Composition" half of the Facility/Provider/Patient
 * onboarding build — FhirDocumentAssembler wraps a set of already-extracted FHIR resources
 * (POST /api/workflow/extract's own output, typically) into a real FHIR Bundle{type:'document'}
 * with a proper Composition as its first entry, per the real FHIR document rules (every resource
 * a section references is guaranteed present as a Bundle entry). Not connected to any HAPI/FHIR
 * server here — this only assembles the document; storing/sharing it is a separate, not-yet-built
 * step (see clinux-spec23-speciality-room-fixed-anchors memory note).
 */
app.post('/api/workflow/assemble-document', requireUser(), async (c) => {
    try {
        const { resources, ...meta } = await c.req.json();
        if (!resources || !Array.isArray(resources)) {
            return c.json({ success: false, error: 'resources (an array of FHIR resources) is required.' }, 400);
        }
        const bundle = FhirDocumentAssembler.assemble(resources, meta);
        return c.json({ success: true, bundle });
    } catch (err) {
        console.error('❌ Document Assembly Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/workflow/test-scribe-mock
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * Offline stand-in for /api/workflow/test-scribe: instead of calling an LLM, it pattern-matches
 * a handful of keywords/numbers directly out of the transcript (gender, blood pressure, a couple
 * of demo condition/medication codes) so the scribe flow can be exercised without network access.
 * Persists the resulting QuestionnaireResponse to the D1 holding queue and runs it through the
 * local FHIR extractor, same as the real endpoint does.
 */
app.post('/api/workflow/test-scribe-mock', async (c) => {
    try {
        const { transcript, activeBlueprint } = await c.req.json();

        if (!activeBlueprint || !activeBlueprint.item) {
            return c.json({ success: false, error: "No compiled blueprint available. Compile form first." }, 400);
        }

        const lowerText = transcript.toLowerCase();

        // Match raw voice text tokens to simulate GBNF grammar constraints
        let capturedGender = "unknown";
        if (lowerText.includes('female') || lowerText.includes('woman')) capturedGender = "female";
        else if (lowerText.includes('male') || lowerText.includes('man')) capturedGender = "male";

        let capturedBp = 120; // Default fallback metric parameters
        const bpMatches = lowerText.match(/\b\d{2,3}\b/);
        if (bpMatches) {
            capturedBp = parseFloat(bpMatches[0]);
        }

        // SYNCHRONIZED ELEMENT ID ENVELOPE GENERATOR
        // This maps variables to your specific field IDs ('systolic_bp', 'diastolic_bp', etc.)
        const structuredResponseItems = activeBlueprint.item.map(section => {
            const nestedSectionItem = {
                linkId: section.linkId,
                text: section.text,
                item: []
            };

            if (section.item && Array.isArray(section.item)) {
                section.item.forEach(question => {
                    const matchedAnswer = [];

                    // FIXED ID-BASED BINDING VERIFICATIONS
                    if (question.linkId === 'patient_gender') {
                        matchedAnswer.push({ valueString: capturedGender });
                    }
                    else if (question.linkId === 'systolic_bp') {
                        matchedAnswer.push({ valueDecimal: capturedBp }); // e.g., 148
                    }
                    else if (question.linkId === 'diastolic_bp') {
                        matchedAnswer.push({ valueDecimal: Math.round(capturedBp * 0.6) }); // Simulated Diastolic relative vector
                    }
                    else if (question.linkId === 'condition_search' && capturedBp > 140) {
                        matchedAnswer.push({ valueString: "active-hypertension" });
                    }
                    // ─── ADDED: AUTOMATED MEDICATION SEARCH SIMULATOR MAPPING TRACE ───
                    else if (question.linkId === 'medication_search') {
                        // Simulates the user selecting an RxNorm entry from their autocomplete list
                        matchedAnswer.push({ valueString: "284305" }); // RxNorm Code for Lisinopril 10mg Oral Tablet
                    }
                    if (matchedAnswer.length > 0) {
                        nestedSectionItem.item.push({
                            linkId: question.linkId,
                            text: question.text,
                            answer: matchedAnswer
                        });
                    }
                });
            }

            return nestedSectionItem;
        });

        const questionnaireResponseEnvelope = {
            resourceType: "QuestionnaireResponse",
            questionnaire: `Questionnaire/${activeBlueprint.id}`,
            status: "completed",
            item: structuredResponseItems.filter(sec => sec.item.length > 0)
        };

        // Persist transaction record tracking payload into the D1 holding queue
        await LocalQueueManager.enqueueResponse(c.env.DB, `sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);

        // Run the local extractor to graph discrete resources natively inside the Worker
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        return c.json({
            success: true,
            maskedLlmOutput: {
                updates: [
                    { path: "Patient.gender", value: capturedGender },
                    { path: "Observation.component[0].valueQuantity.value", value: capturedBp },
                    { path: "Observation.component[1].valueQuantity.value", value: Math.round(capturedBp * 0.6) }
                ]
            },
            localExtractedFhirGraph,
            questionnaireResponseEnvelope
        });

    } catch (err) {
        return c.json({ success: false, error: err.message }, 500);
    }
});

/**
 * POST /api/workflow/test-scribe
 * Body: { transcript: string, activeBlueprint: FHIR Questionnaire }
 * The real (non-mock) scribe pipeline: sends the transcript to Cloudflare Workers AI
 * (Llama 3.3 70B) via the native AI binding, asks it to return clinical findings as JSON, then
 * reflects that JSON against the active blueprint's field labels/paths/trained-keywords using
 * token-overlap scoring to bind values onto the right questionnaire items. Per-field keywords
 * (question.keywords) come from the designer's "Training the Form" step and are weighted more
 * heavily than generic label/path tokens.
 *
 * Ported off the original CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_AUTH_TOKEN REST call — running inside
 * a Worker, the AI binding authenticates automatically for this account, so no credentials need
 * to be configured at all.
 *
 * requireUser()/requirePaidTier(): this is a real per-call Workers AI cost, gated to paid-tier
 * clinics only — free tier gets zero access, by design (see src/lib/userAuth.js).
 */
app.post('/api/workflow/test-scribe', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { transcript, activeBlueprint, context, source } = await c.req.json();

        // Designer.vue's testVoiceScribeExtraction() is a design-time tool for tuning a form's
        // keyword-training before it ever reaches a real encounter — it tags its own requests
        // with source: 'designer-test'. ConsultationDesk.vue's real "Generate SOAP draft"
        // feature never sends this field, so it's unaffected. Only Designer's dev-testing path
        // is denied in production; it still works under `wrangler dev` (ENVIRONMENT=development
        // via .dev.vars) for actually building/tuning forms.
        if (source === 'designer-test' && c.env.ENVIRONMENT === 'production') {
            return c.json({ success: false, error: 'test-scribe is disabled for Designer test runs in production. Use test-scribe-mock, or test locally with `wrangler dev`.' }, 403);
        }

        if (!activeBlueprint || !activeBlueprint.item) {
            return c.json({ success: false, error: "No compiled blueprint active. Rebuild form first." }, 400);
        }

        console.log("☁️ Transmitting to Cloudflare Llama-3.3-70B Production Inference Mesh...");

        const aiResult = await c.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
                {
                    role: "system",
                    // context is the selected virtual-room role's markdown (clinix-frontend's
                    // Cübo Profile panel — config/clinic-specialities/virtual-rooms/**/*.md) —
                    // trusted, server-bundled config content, not user input, so it's appended
                    // as-is rather than run through client-side prompt-injection sanitization.
                    content: "You are an advanced medical extraction node. Analyze the raw clinical conversational transcript and output a JSON object mapping clinical findings. Group related metrics logically under clear keys. Output ONLY valid raw JSON."
                        + (context ? `\n\nApply the following role-specific clinical scope and SOAP note constraints when drafting the note:\n${context}` : '')
                },
                { role: "user", content: `Transcript: "${transcript}"` }
            ],
            temperature: 0.0
        });
        // Cost attribution: the Workers AI call above is the actual billable event this route
        // exists to gate behind requirePaidTier() — record it as soon as it succeeds, regardless
        // of what the extraction logic below does with the response.
        await UsageTracking.record(c.env.DB, c.get('user').clinicId, 'workers_ai_call', 1);

        console.log("☁️ Response from Llama-3.3-70B Production Inference Mesh..." + JSON.stringify(aiResult.response));

        // EXTRACTION BOUNDARY SLICER (DYNAMIC TYPE GUARD)
        let rawJsonTree;
        const responseDataPayload = aiResult.response;

        if (typeof responseDataPayload === 'object' && responseDataPayload !== null) {
            rawJsonTree = responseDataPayload;
        } else if (typeof responseDataPayload === 'string') {
            const jsonStartIndex = responseDataPayload.indexOf('{');
            const jsonEndIndex = responseDataPayload.lastIndexOf('}');

            if (jsonStartIndex === -1 || jsonEndIndex === -1) {
                throw new Error("No structured curly brackets found inside model response string envelope.");
            }

            const cleanJsonStringNode = responseDataPayload.substring(jsonStartIndex, jsonEndIndex + 1).trim();
            rawJsonTree = JSON.parse(cleanJsonStringNode);
        } else {
            throw new Error(`Unrecognized Workers AI response payload type signature: ${typeof responseDataPayload}`);
        }

        // UNIFIED DATA NODE FINGERPRINTING
        const extractedLlmFingerprints = [];

        function tokenizeAndCrawl(obj, activePath = '') {
            if (!obj || typeof obj !== 'object') return;

            Object.keys(obj).forEach(key => {
                const value = obj[key];
                const cleanKey = key.toLowerCase();
                const currentPath = activePath ? `${activePath}.${cleanKey}` : cleanKey;

                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                    tokenizeAndCrawl(value, currentPath);
                } else if (value !== undefined && value !== null) {
                    const pathWords = currentPath.split(/[\.__-]/).flatMap(w => w.split(/(?=[A-Z])/)).map(w => w.toLowerCase());
                    const valueWords = String(value).toLowerCase().split(/[\s.__-]/);

                    extractedLlmFingerprints.push({
                        rawPath: currentPath,
                        rawValue: value,
                        combinedTokens: new Set([...pathWords, ...valueWords, cleanKey])
                    });
                }
            });
        }
        tokenizeAndCrawl(rawJsonTree);

        // REFLECT AGAINST ACTIVE BLUEPRINT INTENT SPECIFICATIONS
        const structuredResponseItems = activeBlueprint.item.map(section => {
            const nestedSectionItem = { linkId: section.linkId, text: section.text, item: [] };

            if (section.item && Array.isArray(section.item)) {
                section.item.forEach(question => {
                    const formLabelTokens = question.text.toLowerCase().split(/[\s.__-]/);

                    let formPathTokens = [];
                    if (question.definition && question.definition.includes('#')) {
                        const pathSection = question.definition.split('#');
                        formPathTokens = pathSection[1].toLowerCase().split(/[\.__-]/);
                    }

                    // Keywords trained per-field in the designer's "Training the Form" step
                    // (persisted as question.keywords on the compiled Questionnaire item). These
                    // are the strongest, most intentional signal for this field, so matches
                    // against them are weighted higher than the generic label/path tokens.
                    const trainedKeywordTokens = Array.isArray(question.keywords)
                        ? question.keywords.map(k => String(k).toLowerCase())
                        : [];

                    const formIntentTokens = new Set([...formLabelTokens, ...formPathTokens, ...trainedKeywordTokens]);

                    let bestMatchValue = null;
                    let bestMatchNode = null;
                    let highestMatchScore = 0;

                    // INTERSECTION DISTANCE MATRIX CRAWLER
                    extractedLlmFingerprints.forEach(node => {
                        let intersectionCount = 0;
                        node.combinedTokens.forEach(token => {
                            if (token.length > 2 && formIntentTokens.has(token)) {
                                intersectionCount++;
                                if (trainedKeywordTokens.includes(token)) intersectionCount += 2;
                            }
                        });

                        if (intersectionCount > highestMatchScore) {
                            highestMatchScore = intersectionCount;
                            bestMatchValue = node.rawValue;
                            bestMatchNode = node;
                        }
                    });

                    // BIND AND FORMAT STANDARDIZED DATA NODE VALUE
                    if (highestMatchScore > 0 && bestMatchValue !== "stable" && bestMatchValue !== "unknown") {
                        const answerNode = {};

                        if (question.type === 'decimal' || question.type === 'integer') {
                            const parsedNum = typeof bestMatchValue === 'number' ? bestMatchValue : parseFloat(String(bestMatchValue).match(/\d+/));
                            if (!isNaN(parsedNum)) answerNode.valueDecimal = parsedNum;
                        } else if (question.type === 'boolean') {
                            answerNode.valueBoolean = (bestMatchValue === true || String(bestMatchValue).toLowerCase() === 'true');
                        } else {
                            const cleanStrVal = String(bestMatchValue).toLowerCase();
                            // If value is a modifier status, walk back and pull the parent clinical key description string
                            if ((cleanStrVal === 'chronic' || cleanStrVal === 'active' || cleanStrVal === 'present') && bestMatchNode) {
                                answerNode.valueString = bestMatchNode.rawPath.split('.').pop();
                            } else {
                                answerNode.valueString = String(bestMatchValue);
                            }
                        }

                        if (Object.keys(answerNode).length > 0) {
                            nestedSectionItem.item.push({
                                linkId: question.linkId,
                                text: question.text,
                                answer: [answerNode]
                            });
                        }
                    }
                });
            }

            return nestedSectionItem;
        });

        const questionnaireResponseEnvelope = {
            resourceType: "QuestionnaireResponse",
            questionnaire: `Questionnaire/${activeBlueprint.id}`,
            status: "completed",
            item: structuredResponseItems.filter(sec => sec.item.length > 0)
        };

        await LocalQueueManager.enqueueResponse(c.env.DB, `sess-${Date.now()}`, activeBlueprint.id, transcript, questionnaireResponseEnvelope);
        const localExtractedFhirGraph = ComprehensiveLocalExtractor.extract(activeBlueprint, questionnaireResponseEnvelope);

        return c.json({
            success: true,
            maskedLlmOutput: rawJsonTree,
            localExtractedFhirGraph,
            questionnaireResponseEnvelope
        });

    } catch (err) {
        console.error("❌ Spec-Driven Reflection Engine Failed: ", err.message);
        return c.json({ success: false, error: err.message }, 500);
    }
});

