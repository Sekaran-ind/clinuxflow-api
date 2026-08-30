import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { v4 as uuidv4 } from 'uuid';

import { compileYamlToQuestionnaire } from './lib/yaml-to-questionnaire.js';
import { ComprehensiveLocalExtractor } from './lib/local-extractor.js';
import { LocalQueueManager } from './lib/local-queue-manager.js';
import { saveFormVersion } from './lib/forms-library.js';
import { serviceKeyAuth } from './lib/serviceAuth.js';
import { hashPassword, verifyPassword } from './lib/passwordHash.js';
import { issueSessionToken, verifySessionToken } from './lib/session.js';
import { AccountsDb } from './lib/accounts-db.js';
import { requireUser, requirePaidTier } from './lib/userAuth.js';
import { UsageTracking } from './lib/usageTracking.js';
import { RealtimeClient } from './lib/realtime-client.js';
import { EncounterMeetingsDb } from './lib/encounter-meetings-db.js';
import { EncounterCoordinationDb } from './lib/encounter-coordination-db.js';
import { WikidataTagging, WikidataRateLimitError } from './lib/wikidataTagging.js';

import systemFormsLibrary from '../data/system-forms-library.json';
import defaultBlueprintYaml from '../data/vitals-room.yaml';
import clinicSpecialities from '../data/clinic-specialities.json';
import conditionTypes from '../data/condition-types.json';

export { ChatSignalingRoom } from './durable-objects/ChatSignalingRoom.js';

const app = new Hono();

// Locked down to clinux-frontend's real origins rather than wildcarded — this API fronts a
// paid Workers AI call (test-scribe) and a write endpoint (save-to-library), so an open CORS
// policy would let any webpage's JS call them on a visitor's behalf.
const ALLOWED_ORIGINS = [
    'https://clinux.yaxb.ai',
    'http://localhost:5173',
    // Capacitor's two platforms default to two DIFFERENT origins when no `server.androidScheme`
    // override is set in capacitor.config.json (confirmed against the actual config -- there is
    // none): iOS uses capacitor://localhost, Android uses https://localhost. Both are needed --
    // this isn't one scheme with two names, it's a real platform difference. http://localhost
    // (no port) is kept too for whatever local testing originally added it.
    'capacitor://localhost',
    'https://localhost',
    'http://localhost',
    // The Tauri desktop app's own shared LAN server (src-tauri/src/shared_server.rs) — pages it
    // serves call back into this API from that origin, not from clinux-frontend's normal dev/
    // prod origins above. Local dev port only; a production deployment would need whatever real
    // port the shared server binds to added here too.
    `http://localhost:47856`,
];
app.use('/api/*', cors({ origin: ALLOWED_ORIGINS }));

// See src/lib/serviceAuth.js for what/why — unit tested there.
// /api/chat/signal is exempt: it's a WebSocket upgrade, and browsers' native WebSocket
// constructor cannot set custom headers (no way to send X-Service-Key), unlike every other
// route here which clinux-frontend reaches via apiFetch(). That route isn't left unauthenticated
// though — the session JWT in its own ?token= query param (verified inside the handler, same
// verifySessionToken() requireUser() uses) plus the staff/affiliate trust-boundary check take
// over as its access control instead. It also isn't the kind of cost/abuse surface SERVICE_KEY
// exists for in the first place (see this middleware's own comment) — no paid AI call, no
// unauthenticated write to a shared resource, just a relay between two already-authenticated,
// already-linked accounts.
app.use('/api/*', serviceKeyAuth({ exemptPaths: ['/api/chat/signal'] }));

const VALID_ROLES = ['hospital_admin', 'health_professional', 'admin_and_health_professional'];

// clinics.name is still NOT NULL, but sign-up no longer collects it (see SPEC-11) -- a
// placeholder derived from the email/role stands in until the new Hospital/HFR journey captures
// a real hospital_name and calls PATCH /api/auth/clinic-name.
function deriveDefaultClinicName(email, role) {
    const localPart = String(email).split('@')[0] || 'My';
    const noun = (role === 'health_professional' || role === 'admin_and_health_professional') ? 'Practice' : 'Clinic';
    return `${localPart}'s ${noun}`;
}

/**
 * POST /api/auth/register
 * Body: { email, password, role, adminName?, designation? }
 * Creates a new clinic (tier defaults to 'free') and its first account atomically, and returns a
 * session token. Still gated by serviceKeyAuth() above — X-Service-Key is an independent
 * anti-abuse layer proving "this is clinux-frontend", not superseded by this account-level auth.
 *
 * role ('hospital_admin' | 'health_professional' | 'admin_and_health_professional', required) is
 * the simplified sign-up's only fork — it determines which self-service HFR (facility) and/or
 * HPR (professional) onboarding journeys ClinicHome offers afterward (see
 * docs/SPEC-11-ABDM-M1-M4-ALIGNMENT.md). clinicName is no longer collected here at all —
 * facilityType is always forced to 'facility' (an admin_and_health_professional still needs a
 * real facility record via the HFR journey, so no role means "never register a facility" under
 * the new model) and clinicName gets a placeholder (see deriveDefaultClinicName above) until the
 * Hospital journey replaces it with the real hospital_name.
 */
app.post('/api/auth/register', async (c) => {
    try {
        const { email, password, role, adminName, designation } = await c.req.json();
        if (!email || !password || !role) {
            return c.json({ success: false, error: 'email, password, and role are required.' }, 400);
        }
        if (password.length < 8) {
            return c.json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
        }
        if (!VALID_ROLES.includes(role)) {
            return c.json({ success: false, error: `role must be one of: ${VALID_ROLES.join(', ')}.` }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();

        const existing = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (existing) {
            return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
        }
        if (!c.env.JWT_SECRET) {
            return c.json({ success: false, error: 'Server auth is not configured.' }, 500);
        }

        const clinicId = uuidv4();
        const accountId = uuidv4();
        const passwordHash = await hashPassword(password);
        const facilityType = 'facility';
        const clinicName = deriveDefaultClinicName(normalizedEmail, role);

        try {
            await AccountsDb.createClinicAndAccount(
                c.env.DB, clinicId, clinicName, accountId, normalizedEmail, passwordHash, adminName, designation,
                facilityType, role
            );
        } catch (err) {
            // Narrow TOCTOU race: two concurrent registrations for the same email both pass the
            // getAccountByEmail check above; D1's UNIQUE(email) constraint rejects the second.
            if (String(err.message).includes('UNIQUE')) {
                return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
            }
            throw err;
        }

        const token = await issueSessionToken({ sub: accountId, clinicId, email: normalizedEmail }, c.env.JWT_SECRET);

        return c.json({
            success: true,
            token,
            account: {
                id: accountId, clinicId, email: normalizedEmail,
                adminName: adminName ?? null, designation: designation ?? null,
                clinicName, tier: 'free', facilityType, role,
            },
        }, 201);
    } catch (err) {
        console.error('❌ Register Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Generic "Invalid email or password" on any failure (unknown email or wrong password) — doesn't
 * leak which one was wrong.
 */
app.post('/api/auth/login', async (c) => {
    try {
        const { email, password } = await c.req.json();
        if (!email || !password) {
            return c.json({ success: false, error: 'email and password are required.' }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();

        const account = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (!account || !(await verifyPassword(password, account.password_hash))) {
            return c.json({ success: false, error: 'Invalid email or password.' }, 401);
        }
        if (!c.env.JWT_SECRET) {
            return c.json({ success: false, error: 'Server auth is not configured.' }, 500);
        }

        const clinic = await AccountsDb.getClinicById(c.env.DB, account.clinic_id);
        const token = await issueSessionToken(
            { sub: account.id, clinicId: account.clinic_id, email: account.email }, c.env.JWT_SECRET
        );

        return c.json({
            success: true,
            token,
            account: {
                id: account.id, clinicId: account.clinic_id, email: account.email,
                adminName: account.admin_name, designation: account.designation,
                clinicName: clinic?.name ?? '', tier: clinic?.tier ?? 'free',
                facilityType: clinic?.facility_type ?? 'facility', role: account.role,
            },
        });
    } catch (err) {
        console.error('❌ Login Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/auth/me
 * Re-fetches the caller's account + clinic (fresh tier included) — clinux-frontend calls this on
 * app boot when a session token exists, so a tier change since last login takes effect without a
 * fresh login.
 */
app.get('/api/auth/me', requireUser(), async (c) => {
    const user = c.get('user');
    const account = await AccountsDb.getAccountById(c.env.DB, user.accountId);
    if (!account) return c.json({ success: false, error: 'Account not found.' }, 404);

    const clinic = await AccountsDb.getClinicById(c.env.DB, account.clinic_id);
    return c.json({
        success: true,
        account: {
            id: account.id, clinicId: account.clinic_id, email: account.email,
            adminName: account.admin_name, designation: account.designation,
            clinicName: clinic?.name ?? '', tier: clinic?.tier ?? 'free',
            facilityType: clinic?.facility_type ?? 'facility', role: account.role,
        },
    });
});

/**
 * PATCH /api/auth/clinic-name
 * Body: { clinicName }
 * Replaces the placeholder clinics.name sign-up left behind (see deriveDefaultClinicName above)
 * with the real facility name — called by the new Hospital/HFR onboarding journey once it
 * captures hospital_name, not by registration itself.
 */
app.patch('/api/auth/clinic-name', requireUser(), async (c) => {
    try {
        const { clinicName } = await c.req.json();
        if (!clinicName || !String(clinicName).trim()) {
            return c.json({ success: false, error: 'clinicName is required.' }, 400);
        }
        const clinicId = c.get('user').clinicId;
        await AccountsDb.updateClinicName(c.env.DB, clinicId, String(clinicName).trim());
        return c.json({ success: true, clinicName: String(clinicName).trim() });
    } catch (err) {
        console.error('❌ Update Clinic Name Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * PATCH /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Real backend for the register/login/change-password small closed loop (the deliberately small
 * first test case for the new PlanDefinition/Task runtime — clinux-planDefinition-runtime-built
 * memory note) — didn't exist anywhere in this app before this pass, verified by grep, not
 * assumed missing. Mirrors PATCH /api/auth/clinic-name's exact shape above: requireUser()-gated,
 * accountId/clinicId only ever come from the caller's own JWT.
 */
app.patch('/api/auth/change-password', requireUser(), async (c) => {
    try {
        const { currentPassword, newPassword } = await c.req.json();
        if (!currentPassword || !newPassword) {
            return c.json({ success: false, error: 'currentPassword and newPassword are required.' }, 400);
        }
        if (newPassword.length < 8) {
            return c.json({ success: false, error: 'New password must be at least 8 characters.' }, 400);
        }

        const accountId = c.get('user').accountId;
        const account = await AccountsDb.getAccountById(c.env.DB, accountId);
        if (!account || !(await verifyPassword(currentPassword, account.password_hash))) {
            return c.json({ success: false, error: 'Current password is incorrect.' }, 401);
        }

        const newHash = await hashPassword(newPassword);
        await AccountsDb.updatePasswordHash(c.env.DB, accountId, newHash);

        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Change Password Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

// "a clinic's 1-4 staff logins share one subscription" -- migrations/0003_add_accounts_and_
// clinics.sql's own stated design constraint for this table, not a new business rule invented
// here. Applies to every clinic regardless of tier -- multi-user itself isn't paid-gated, unlike
// requirePaidTier()'s other features.
const MAX_ACCOUNTS_PER_CLINIC = 4;

/**
 * POST /api/auth/invite
 * Body: { email, password, adminName?, designation? }
 * Adds another login to the CALLER's OWN clinic — clinicId always comes from the caller's own
 * JWT (via requireUser()), never from the request body, so nobody can invite themselves into a
 * clinic they don't belong to. This app has no mail server, so there's no invite email/link:
 * the inviting admin sets the new teammate's email+password directly (same shape /register
 * already uses minus the "create a new clinic" half) and shares it with them out of band.
 */
app.post('/api/auth/invite', requireUser(), async (c) => {
    try {
        const { email, password, adminName, designation } = await c.req.json();
        if (!email || !password) {
            return c.json({ success: false, error: 'email and password are required.' }, 400);
        }
        if (password.length < 8) {
            return c.json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
        }
        const normalizedEmail = String(email).trim().toLowerCase();
        const clinicId = c.get('user').clinicId;

        const existing = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (existing) {
            return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
        }

        const { count } = await AccountsDb.countAccountsByClinicId(c.env.DB, clinicId);
        if (count >= MAX_ACCOUNTS_PER_CLINIC) {
            return c.json({ success: false, error: `This clinic already has the maximum of ${MAX_ACCOUNTS_PER_CLINIC} team accounts.` }, 403);
        }

        const accountId = uuidv4();
        const passwordHash = await hashPassword(password);

        try {
            await AccountsDb.createTeammateAccount(c.env.DB, clinicId, accountId, normalizedEmail, passwordHash, adminName, designation);
        } catch (err) {
            // Same narrow TOCTOU race as /register: two concurrent invites for the same email.
            if (String(err.message).includes('UNIQUE')) {
                return c.json({ success: false, error: 'An account with this email already exists.' }, 409);
            }
            throw err;
        }

        return c.json({
            success: true,
            account: {
                id: accountId, clinicId, email: normalizedEmail,
                adminName: adminName ?? null, designation: designation ?? null,
            },
        }, 201);
    } catch (err) {
        console.error('❌ Invite Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/auth/team
 * Every login on the caller's own clinic — id/email/adminName/designation/createdAt only, never
 * password hashes. Powers clinux-frontend's Team settings list.
 */
app.get('/api/auth/team', requireUser(), async (c) => {
    const clinicId = c.get('user').clinicId;
    const accounts = await AccountsDb.listAccountsByClinicId(c.env.DB, clinicId);
    return c.json({
        success: true,
        accounts: accounts.map((a) => ({
            id: a.id, email: a.email, adminName: a.admin_name, designation: a.designation, createdAt: a.created_at,
        })),
    });
});

/**
 * POST /api/facility/affiliates
 * Body: { practitionerEmail, role? }
 * Links an EXISTING independent practitioner's account to the caller's facility as an affiliate
 * — deliberately different from /api/auth/invite: this never creates a login, never touches
 * MAX_ACCOUNTS_PER_CLINIC, and the practitioner keeps their own separate account/clinic (their
 * own standalone practice, or staff of somewhere else). 404s if no account exists yet for that
 * email — an affiliate has to already be a ClinuxFlow user (their own individual-practitioner
 * registration, most likely) before a facility can reference them; there's no invite-by-email
 * flow for this relationship type, matching this app's existing "no mail server" constraint.
 */
app.post('/api/facility/affiliates', requireUser(), async (c) => {
    try {
        const { practitionerEmail, role } = await c.req.json();
        if (!practitionerEmail) {
            return c.json({ success: false, error: 'practitionerEmail is required.' }, 400);
        }
        const facilityClinicId = c.get('user').clinicId;
        const normalizedEmail = String(practitionerEmail).trim().toLowerCase();

        const practitioner = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (!practitioner) {
            return c.json({ success: false, error: 'No ClinuxFlow account found for that email yet — the practitioner needs their own account first.' }, 404);
        }
        if (practitioner.clinic_id === facilityClinicId) {
            return c.json({ success: false, error: 'This person is already a full staff account on this clinic, not an affiliate.' }, 400);
        }

        await AccountsDb.addAffiliate(c.env.DB, facilityClinicId, practitioner.id, role);

        return c.json({
            success: true,
            affiliate: {
                accountId: practitioner.id, email: practitioner.email,
                adminName: practitioner.admin_name, designation: practitioner.designation, role: role ?? null,
            },
        }, 201);
    } catch (err) {
        console.error('❌ Add Affiliate Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/facility/affiliates
 * Every active affiliate linked to the caller's own facility.
 */
app.get('/api/facility/affiliates', requireUser(), async (c) => {
    const facilityClinicId = c.get('user').clinicId;
    const affiliates = await AccountsDb.listAffiliatesByFacility(c.env.DB, facilityClinicId);
    return c.json({ success: true, affiliates });
});

/**
 * DELETE /api/facility/affiliates/:accountId
 * Revokes (not deletes — status flip, see migrations/0005) an affiliate link. The affiliate's own
 * account is completely untouched; this only removes the facility's reference to them.
 */
app.delete('/api/facility/affiliates/:accountId', requireUser(), async (c) => {
    const facilityClinicId = c.get('user').clinicId;
    const practitionerAccountId = c.req.param('accountId');
    await AccountsDb.revokeAffiliate(c.env.DB, facilityClinicId, practitionerAccountId);
    return c.json({ success: true });
});

/**
 * GET/PUT /api/provider-composition
 * The direct (non-QR) Provider-composition mirror — see migrations/0005's own comment. Lets a
 * freshly-invited teammate's device pull the clinic's Hospital Profile/Care Team/Services/Hours/
 * Consents document from anywhere (not just the clinic's own LAN, which sharedServerSync.js's
 * poll-and-merge already covers with zero server involvement). The owning clinic's own devices
 * keep pushing their local-first writes here via PUT on every save, same "eventually consistent,
 * best-effort" model as the rest of this app's sync — this is a mirror to pull from, not a new
 * authority competing with the local-first collection.
 */
app.get('/api/provider-composition', requireUser(), async (c) => {
    const clinicId = c.get('user').clinicId;
    const row = await AccountsDb.getProviderComposition(c.env.DB, clinicId);
    if (!row) return c.json({ success: false, error: 'No Provider composition stored yet for this clinic.' }, 404);
    return c.json({ success: true, data: JSON.parse(row.data), updatedAt: row.updatedAt });
});

app.put('/api/provider-composition', requireUser(), async (c) => {
    try {
        const body = await c.req.json();
        const clinicId = c.get('user').clinicId;
        await AccountsDb.upsertProviderComposition(c.env.DB, clinicId, JSON.stringify(body));
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Upsert Provider Composition Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

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
 * GET /api/admin/usage-summary?days=30
 * Per-clinic cloud-cost metering readback — see docs/SPEC-05-DATA-TIER-AND-ABDM-BOUNDARY.md and
 * src/lib/usageTracking.js. Always scoped to the CALLER's own clinic, same "no way to query
 * someone else's data" boundary as GET /api/encounters/assignments. Not itself paid-gated —
 * every clinic should be able to see its own usage regardless of tier, including a free-tier
 * clinic checking it's genuinely at zero on the paid-only components. Internal/admin use for
 * now: the seed for pricing-model analysis, not yet a user-facing dashboard.
 */
app.get('/api/admin/usage-summary', requireUser(), async (c) => {
    const days = Number(c.req.query('days')) || 30;
    const rows = await UsageTracking.summaryForClinic(c.env.DB, c.get('user').clinicId, days);
    return c.json({ success: true, usage: rows });
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
 * GET /api/workflow/system-forms
 * Returns the pre-compiled system-forms catalog (tools/build-system-forms.js's output, bundled
 * here as data/system-forms-library.json — regenerate via `npm run build:kernel`), shaped
 * identically to the browser's cf_forms_library localStorage so seedSystemForms() can merge it
 * straight in.
 */
app.get('/api/workflow/system-forms', (c) => {
    return c.json({ success: true, systemForms: systemFormsLibrary });
});

/**
 * GET /api/nlp/wikidata-search?term=...
 * SPEC-06 §6's design-time/onboarding semantic tagging — Designer.vue field-labeling and
 * onboarding role/specialty tagging both start here. Returns candidate Wikidata concepts for a
 * human to disambiguate/confirm — never auto-picks, since Wikidata is general-knowledge, not a
 * clinical terminology, and a "closest match" can be wrong for clinically-precise terms.
 * requireUser()-gated (not requirePaidTier()'d) — this is explicitly free/Cloud-tier-safe by
 * design, unlike the paid-tier cloud-durability surface.
 */
app.get('/api/nlp/wikidata-search', requireUser(), async (c) => {
    const term = c.req.query('term');
    if (!term) return c.json({ success: false, error: 'term query param is required.' }, 400);
    try {
        const candidates = await WikidataTagging.search(c.env.WIKIDATA_CACHE, term);
        return c.json({ success: true, candidates });
    } catch (err) {
        if (err instanceof WikidataRateLimitError) {
            return c.json({ success: false, error: err.message, retryAfterSeconds: err.retryAfterSeconds }, 429);
        }
        console.error('❌ Wikidata Search Exception:', err.message);
        return c.json({ success: false, error: 'Wikidata lookup failed — please try again.' }, 502);
    }
});

/**
 * GET /api/nlp/wikidata-concept?qid=...
 * Full alias/synonym detail for a CONFIRMED concept — a separate call from the search above by
 * design (wbsearchentities doesn't return aliases), fetched only once a human has picked the
 * right candidate. This is what actually gets appended to a field's keywords / stored on an
 * onboarding role tag.
 */
app.get('/api/nlp/wikidata-concept', requireUser(), async (c) => {
    const qid = c.req.query('qid');
    if (!qid) return c.json({ success: false, error: 'qid query param is required.' }, 400);
    try {
        const concept = await WikidataTagging.getConcept(c.env.WIKIDATA_CACHE, qid);
        return c.json({ success: true, concept });
    } catch (err) {
        if (err instanceof WikidataRateLimitError) {
            return c.json({ success: false, error: err.message, retryAfterSeconds: err.retryAfterSeconds }, 429);
        }
        console.error('❌ Wikidata Concept Exception:', err.message);
        return c.json({ success: false, error: 'Wikidata lookup failed — please try again.' }, 502);
    }
});

/**
 * GET /api/clinic-specialities
 * Ported from clinixflow's server.js, which computes this at request time via fs.readdirSync
 * over config/clinic-specialities/virtual-rooms/ — no filesystem here, so it's precomputed by
 * scripts/build-clinic-specialities.js into data/clinic-specialities.json and just served as-is.
 */
app.get('/api/clinic-specialities', (c) => {
    return c.json({ success: true, specialities: clinicSpecialities.specialities });
});

/**
 * GET /api/clinic-specialities/:folder/:file
 * Same data source as above; folder/file are validated against the bundled manifest's own keys
 * (not interpolated into a filesystem path), so there's no path-traversal surface to guard here
 * the way clinixflow's fs-based version needed to.
 */
app.get('/api/clinic-specialities/:folder/:file', (c) => {
    const { folder, file } = c.req.param();
    const markdown = clinicSpecialities.markdown[`${folder}/${file}`];
    if (!markdown) return c.json({ success: false, error: `Unknown role file: ${folder}/${file}` }, 404);
    return c.json({ success: true, folder, file, markdown });
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
 * POST /api/workflow/save-to-library
 * Body: { yamlPayload: string, questionnaireJson: FHIR Questionnaire }
 * Explicit "save" action for the designer's preview pane — called once the user is happy with
 * how a compiled form looks, not on every live-preview compile. Archives the YAML alongside its
 * already-compiled Questionnaire as a new version in the FORMS_LIBRARY KV namespace, so every
 * saved form always has a matching YAML + JSON pair for that version.
 *
 * Every clinic's forms library lives in the browser's localStorage by default (same as the
 * clinic profile / hospital data); the designer only calls this endpoint for clinics with an
 * active subscription, as a durable server-side backup on top of the local copy. That gating is
 * enforced client-side today since there's no server-side auth/session layer yet — if real
 * billing/auth is added later, this endpoint should verify entitlement itself rather than trust
 * the caller.
 */
app.post('/api/workflow/save-to-library', async (c) => {
    try {
        const { yamlPayload, questionnaireJson } = await c.req.json();

        if (!yamlPayload || !questionnaireJson) {
            return c.json({ success: false, error: "Both yamlPayload and questionnaireJson are required to save to the library." }, 400);
        }

        const savedVersion = await saveFormVersion(c.env.FORMS_LIBRARY, questionnaireJson, yamlPayload);

        return c.json({
            success: true,
            formId: savedVersion.formId,
            version: savedVersion.version,
            jsonKey: savedVersion.jsonKey,
            yamlKey: savedVersion.yamlKey
        });
    } catch (err) {
        console.error("❌ Forms Library Save Exception:", err.message);
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

app.get('/health', (c) => c.json({ ok: true }));

export default app;
