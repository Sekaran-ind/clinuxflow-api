// SPEC-24-adjacent (NIST ZTA discussion) — the CONTROL layer: registry/identity + StructureDefinition
// /GraphDefinition-anchored conformance for Facility/Provider/Affiliate Practitioner/Affiliate
// Organization/Patient (SPEC-24), plus the registration-time catalogs (Wikidata specialty tagging,
// clinic-specialities) those onboarding flows consult. Mounted unprefixed
// (`app.route('/', controlRoutes)`) by src/index.js, so every path below is already the real,
// final route — no rewriting.
import { Hono } from 'hono';
import { ComprehensiveLocalExtractor } from '../lib/shared/local-extractor.js';
import { validate } from '../lib/control/conformance-validator.js';
import { nextBestActions } from '../lib/control/next-best-action.js';
import { WikidataTagging, WikidataRateLimitError } from '../lib/control/wikidataTagging.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { requireUser, requirePaidTier } from '../lib/shared/userAuth.js';
import { resourceConfig } from '../lib/control/resource-registry.js';
import { ResourceRecordsDb } from '../lib/control/resource-records-db.js';
import { JoinTokensDb, generateJoinToken } from '../lib/control/join-tokens-db.js';
import { deriveStageFromCompositionRow, canAcceptFacilityJoinToken } from '../lib/control/facility-setup-stage.js';
import { hashPassword } from '../lib/shared/passwordHash.js';
import { v4 as uuidv4 } from 'uuid';
import { MAX_ACCOUNTS_PER_CLINIC } from './auth.js';

import systemFormsLibrary from '../../data/system-forms-library.json';
import clinicSpecialities from '../../data/clinic-specialities.json';
import hfrMasterValueSets from '../../data/hfr-master-valuesets.json';
import clinuxFlowFacilitySd from '../../data/structure-definitions/ClinuxFlowFacility.json';
import clinuxFlowProviderSd from '../../data/structure-definitions/ClinuxFlowProvider.json';
import clinuxFlowProviderRoleSd from '../../data/structure-definitions/ClinuxFlowProviderRole.json';
import clinuxFlowAffiliatePractitionerRoleSd from '../../data/structure-definitions/ClinuxFlowAffiliatePractitionerRole.json';
import clinuxFlowAffiliateOrganizationSd from '../../data/structure-definitions/ClinuxFlowAffiliateOrganization.json';
import clinuxFlowOnboardingGraph from '../../data/graph-definitions/ClinuxFlowOnboardingGraph.json';

export const controlRoutes = new Hono();
const app = controlRoutes;

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
 * GET /api/practitioner/affiliations
 * The reverse of GET /api/facility/affiliates — every facility the CALLER (as a practitioner) is
 * actively affiliated with. Real gap found live: an independent practitioner who redeemed a
 * facility's join link and got approved had no way to see that anywhere — .../decide (below)
 * wrote the relationship, but nothing ever read it back on the practitioner's own side. Powers
 * PractitionerHome.vue's "Clinic Association" card.
 */
app.get('/api/practitioner/affiliations', requireUser(), async (c) => {
    const affiliations = await AccountsDb.listAffiliationsByAccount(c.env.DB, c.get('user').accountId);
    return c.json({ success: true, affiliations });
});

// ============================================================================================
// Organization Affiliates (migrations/0015) — the org-to-org counterpart to the practitioner
// affiliate routes just above. Same consistent shape: a GET (facility's own list), a DELETE
// (revoke), and a reverse GET (which OTHER facilities has my own organization been linked to as
// a partner) — mirroring GET /api/facility/affiliates, DELETE .../affiliates/:accountId, and
// GET /api/practitioner/affiliations one-for-one. Linking itself goes through the SAME join-token
// issue/redeem/deliver/decide pipeline (linkKind: 'organization'), not a separate mechanism.
// ============================================================================================

/**
 * GET /api/facility/organization-affiliates
 * Every active partner organization linked to the caller's own facility.
 */
app.get('/api/facility/organization-affiliates', requireUser(), async (c) => {
    const facilityClinicId = c.get('user').clinicId;
    const affiliates = await AccountsDb.listOrganizationAffiliatesByFacility(c.env.DB, facilityClinicId);
    return c.json({ success: true, affiliates });
});

/**
 * DELETE /api/facility/organization-affiliates/:clinicId
 * Revokes (status flip, not delete) an organization affiliate link. The OTHER organization's own
 * clinic/account is completely untouched; this only removes the facility's reference to them.
 */
app.delete('/api/facility/organization-affiliates/:clinicId', requireUser(), async (c) => {
    const facilityClinicId = c.get('user').clinicId;
    const affiliateClinicId = c.req.param('clinicId');
    await AccountsDb.revokeOrganizationAffiliate(c.env.DB, facilityClinicId, affiliateClinicId);
    return c.json({ success: true });
});

/**
 * GET /api/facility/organization-affiliations
 * The reverse of GET /api/facility/organization-affiliates — every facility the CALLER's own
 * organization is affiliated WITH, as a partner. Powers ClinicHome.vue's/TeamSettingsModal.vue's
 * "Partner Organizations" surfaces on the organization that redeemed someone else's join link.
 */
app.get('/api/facility/organization-affiliations', requireUser(), async (c) => {
    const clinicId = c.get('user').clinicId;
    const affiliations = await AccountsDb.listOrganizationAffiliationsByClinic(c.env.DB, clinicId);
    return c.json({ success: true, affiliations });
});

/**
 * GET /api/facility/affiliates/conformance
 * SPEC-24 §7 step 6's "follow the proven pattern," adapted honestly for an entity that was never
 * YAML/QuestionnaireResponse-driven to begin with — see docs/SPEC-24-...md and the
 * clinux-spec24-... memory note. An affiliate practitioner's own Practitioner record lives on
 * THEIR OWN separate account/clinic (facility_affiliates only cross-references an accountId, see
 * migrations/0005) — it is never captured inside this facility's Provider-composition document,
 * so running it through local-extractor.js's generic PractitionerRole<->Practitioner auto-link
 * (which zips by SAME-document repetition order) would be actively wrong here. Instead: read this
 * clinic's own Organization straight off its durable provider_composition mirror (the same row
 * StaffOnboarding.vue's direct-fetch path already relies on — see that row's own comment), and
 * build one real PractitionerRole per already-linked affiliate directly from
 * AccountsDb.listAffiliatesByFacility's own columns, rather than expecting the caller to submit a
 * questionnaireJson/responseJson pair that doesn't exist for this entity.
 */
app.get('/api/facility/affiliates/conformance', requireUser(), async (c) => {
    try {
        const facilityClinicId = c.get('user').clinicId;

        const compositionRow = await AccountsDb.getProviderComposition(c.env.DB, facilityClinicId);
        let organization = null;
        if (compositionRow) {
            // system-provider-composition-v1's own compiled Questionnaire — the same formId
            // onboarding.PROVIDER_FORM_ID names client-side (data/system-forms-library.json is
            // the server-side mirror of the exact same forms library the frontend reads).
            const formEntry = systemFormsLibrary['system-provider-composition-v1'];
            const version = formEntry?.versions.find((v) => v.version === formEntry.activeVersion);
            if (version?.questionnaire) {
                const resources = ComprehensiveLocalExtractor.extract(version.questionnaire, JSON.parse(compositionRow.data));
                organization = resources.find((r) => r.resourceType === 'Organization') || null;
            }
        }

        const affiliateRows = await AccountsDb.listAffiliatesByFacility(c.env.DB, facilityClinicId);

        const validationResults = {};
        if (organization) validationResults[organization.id] = validate(clinuxFlowFacilitySd, organization);

        const affiliates = affiliateRows.map((row) => {
            const role = {
                resourceType: 'PractitionerRole',
                id: `affiliate-role-${row.accountId}`,
                active: row.status === 'active',
                practitioner: { reference: `Practitioner/${row.accountId}`, display: row.adminName || row.email },
                ...(organization ? { organization: { reference: `Organization/${organization.id}` } } : {}),
                ...(row.role ? { code: [{ text: row.role }] } : {}),
            };
            const result = validate(clinuxFlowAffiliatePractitionerRoleSd, role);
            validationResults[role.id] = result;
            return { affiliate: row, role, valid: result.valid, errors: result.errors };
        });

        const bundle = [organization, ...affiliates.map((a) => a.role)].filter(Boolean);
        const nextActions = nextBestActions(clinuxFlowOnboardingGraph, bundle, validationResults);

        return c.json({ success: true, hasOrganization: Boolean(organization), affiliates, nextActions });
    } catch (err) {
        console.error('❌ Affiliate Practitioner Conformance Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
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
    return c.json({ success: true, data: JSON.parse(row.data), updatedAt: row.updatedAt, publishedAt: row.publishedAt ?? null });
});

// Body is now { data, published } (was the raw document itself) — `published` (SPEC-26 §4,
// migrations/0012) is what lets facilitySetupMachine's server-side mirror (facility-setup-
// stage.js) tell "published" from "basics_saved" without trusting client-only state. Safe to
// widen: nothing in clinux-frontend actually calls this route yet (onboarding.js's publish()
// wires it up as part of this same change), so there's no existing caller sending the old shape.
app.put('/api/provider-composition', requireUser(), async (c) => {
    try {
        const body = await c.req.json();
        const clinicId = c.get('user').clinicId;
        await AccountsDb.upsertProviderComposition(c.env.DB, clinicId, JSON.stringify(body.data ?? body), !!body.published);
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Upsert Provider Composition Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

// ============================================================================================
// Facility join-token linking — docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md. Replaces
// POST /api/auth/invite's admin-invents-a-password flow and POST /api/facility/affiliates'
// email-lookup-only flow with one self-service mechanism for ALL THREE relationship types: Staff,
// Practitioner Affiliate, and (migrations/0015) Organization Affiliate — a facility-to-facility
// link (partner lab, imaging centre, ...), the real/resolvable counterpart to the Provider
// composition's own free-text-only section_affiliate_organization group. Product direction: keep
// all three "managed in a similar way" through this one token issue/redeem/decide pipeline rather
// than inventing a separate mechanism per relationship kind.
// ============================================================================================

/**
 * POST /api/facility/join-tokens
 * Issue a token for the CALLER's own facility. Gated on facilitySetupMachine's server-side
 * mirror (SPEC-26 §8) — fail fast at issue time, don't let a token exist that can never legally
 * be redeemed later.
 */
app.post('/api/facility/join-tokens', requireUser(), async (c) => {
    try {
        const { linkKind } = await c.req.json();
        if (!['staff', 'affiliate', 'organization'].includes(linkKind)) {
            return c.json({ success: false, error: "linkKind must be 'staff', 'affiliate', or 'organization'." }, 400);
        }
        const clinicId = c.get('user').clinicId;
        const compositionRow = await AccountsDb.getProviderComposition(c.env.DB, clinicId);
        const stage = deriveStageFromCompositionRow(compositionRow);
        if (!canAcceptFacilityJoinToken(stage)) {
            return c.json({ success: false, error: 'Publish your clinic page before generating join links.', stage }, 409);
        }
        const token = generateJoinToken();
        await JoinTokensDb.issue(c.env.DB, { token, facilityClinicId: clinicId, linkKind, issuedByAccountId: c.get('user').accountId });
        const row = await JoinTokensDb.getByToken(c.env.DB, token);
        return c.json({ success: true, token, expiresAt: row.expires_at });
    } catch (err) {
        console.error('❌ Issue Join Token Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/facility/join-tokens/pending
 * SPEC-26 §6's "discovery" fix — every `redeemed`, not-yet-decided token this admin issued, WITH
 * the redeemer's own name/email joined in. This is what lets Cübo's contacts pane show "pending
 * join request from X" for someone who isn't a real contact (fetchTeam/fetchAffiliates) yet.
 */
app.get('/api/facility/join-tokens/pending', requireUser(), async (c) => {
    const pending = await JoinTokensDb.listPendingByIssuer(c.env.DB, c.get('user').accountId);
    return c.json({ success: true, pending });
});

/** GET /api/facility/join-tokens — every token the caller's facility has issued, any status. */
app.get('/api/facility/join-tokens', requireUser(), async (c) => {
    const tokens = await JoinTokensDb.listByClinic(c.env.DB, c.get('user').clinicId);
    return c.json({ success: true, tokens });
});

/**
 * POST /api/facility/join-tokens/:token/renew
 * SPEC-26 §7 — extends expires_at, only while still `issued` (not redeemed/expired/revoked); an
 * admin renewing a dead token issues a fresh one instead (explicit recovery, not resurrection).
 */
app.post('/api/facility/join-tokens/:token/renew', requireUser(), async (c) => {
    const token = c.req.param('token');
    const result = await JoinTokensDb.renew(c.env.DB, token, c.get('user').accountId);
    if (result.meta.changes === 0) {
        return c.json({ success: false, error: 'Token not found, not yours, or already redeemed/expired.' }, 409);
    }
    const row = await JoinTokensDb.getByToken(c.env.DB, token);
    return c.json({ success: true, expiresAt: row.expires_at });
});

/**
 * POST /api/facility/join-tokens/:token/redeem
 * Deliberately NOT requireUser()-gated — a brand-new staff candidate has no account yet (mirrors
 * why POST /api/auth/register isn't gated either). An Authorization header, if present and
 * valid, is honored (an existing account — the only path 'affiliate' can take, and the path an
 * already-registered person redeeming a 'staff' token would also take); otherwise a NEW account
 * is created inline from the body ('staff' only — see below).
 *
 * Real correctness point (see migrations/0012's own comment): a staff account created here is
 * NOT immediately usable — status starts 'pending', so POST /api/auth/login refuses it until
 * .../decide actually approves the request. Redeeming does not equal being let in.
 */
app.post('/api/facility/join-tokens/:token/redeem', async (c) => {
    try {
        const token = c.req.param('token');
        const row = await JoinTokensDb.getByToken(c.env.DB, token);
        if (!row) return c.json({ success: false, error: 'Invalid token.' }, 404);
        if (row.status !== 'issued') {
            return c.json({ success: false, error: 'This token has already been used, or is no longer valid.' }, 409);
        }
        if (new Date(row.expires_at) <= new Date()) {
            return c.json({ success: false, error: 'This token has expired — ask the facility admin to renew or reissue it.' }, 410);
        }

        const compositionRow = await AccountsDb.getProviderComposition(c.env.DB, row.facility_clinic_id);
        const stage = deriveStageFromCompositionRow(compositionRow);
        if (!canAcceptFacilityJoinToken(stage)) {
            // Belt-and-suspenders (SPEC-26 §8) — not reachable today since everPublished/
            // published_at is one-way, but this route trusts nothing client-supplied.
            return c.json({ success: false, error: 'This facility has not completed setup and cannot accept join requests right now.' }, 409);
        }

        let accountId = null;
        const authHeader = c.req.header('Authorization') || '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (bearer && c.env.JWT_SECRET) {
            try {
                const { verifySessionToken } = await import('../lib/shared/session.js');
                const payload = await verifySessionToken(bearer, c.env.JWT_SECRET);
                accountId = payload.sub;
            } catch {
                // Invalid/expired token — fall through to the anonymous (staff-only) path below.
            }
        }

        // Real gap found while wiring this: requireUser() only validates a JWT's signature/expiry,
        // never re-checks account status against D1 on every request — so a session token handed
        // to a brand-new 'pending' account here would still pass requireUser() on every OTHER
        // authenticated route (fetchTeam, provider-composition, ...) even though
        // POST /api/auth/login correctly refuses to issue a NEW one for it. Fixed by never
        // minting a session for the newly-created account at all — it stays genuinely unusable
        // until .../decide approves it and the person logs in for the first time normally, not
        // just "can't re-login" while an already-issued token still works everywhere else.
        let personEmail = null;
        if (!accountId) {
            if (row.link_kind !== 'staff') {
                return c.json({ success: false, error: 'Log in to your existing account first, then redeem this token.' }, 401);
            }
            const { email, password, adminName, designation } = await c.req.json().catch(() => ({}));
            if (!email || !password) return c.json({ success: false, error: 'email and password are required.' }, 400);
            if (password.length < 8) return c.json({ success: false, error: 'Password must be at least 8 characters.' }, 400);
            const normalizedEmail = String(email).trim().toLowerCase();
            const existing = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
            if (existing) {
                return c.json({ success: false, error: 'An account with this email already exists — log in and redeem the token from your own account instead.' }, 409);
            }
            const { count } = await AccountsDb.countAccountsByClinicId(c.env.DB, row.facility_clinic_id);
            if (count >= MAX_ACCOUNTS_PER_CLINIC) {
                return c.json({ success: false, error: `This clinic already has the maximum of ${MAX_ACCOUNTS_PER_CLINIC} team accounts.` }, 403);
            }
            accountId = uuidv4();
            const passwordHash = await hashPassword(password);
            await AccountsDb.createTeammateAccount(c.env.DB, row.facility_clinic_id, accountId, normalizedEmail, passwordHash, adminName, designation, 'pending');
            personEmail = normalizedEmail;
        }

        const redeemed = await JoinTokensDb.redeem(c.env.DB, token, accountId);
        if (!redeemed) {
            return c.json({ success: false, error: 'This token has already been used, or is no longer valid.' }, 409);
        }

        const admin = await AccountsDb.getAccountById(c.env.DB, row.issued_by_account_id);
        const facility = await AccountsDb.getClinicById(c.env.DB, row.facility_clinic_id);
        return c.json({
            success: true,
            linkKind: row.link_kind,
            accountId,
            personEmail, // set only for a brand-new staff account — no sessionToken; see the
                         // comment above on why one is never issued for a still-pending account.
            admin: admin ? { accountId: admin.id, name: admin.admin_name || admin.email } : null,
            facilityName: facility?.name || null,
        });
    } catch (err) {
        console.error('❌ Redeem Join Token Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/facility/join-tokens/:token/deliver
 * SPEC-26 §6/§9's Cloudflare Queues revision — durable fallback delivery of the SAME ciphertext
 * string the live P2P chat path also sends, for when the admin wasn't online at redemption time.
 * Called unconditionally by the redeemer's client right after building the payload, whether or
 * not the live chat send also succeeded.
 */
app.post('/api/facility/join-tokens/:token/deliver', requireUser(), async (c) => {
    try {
        const token = c.req.param('token');
        const { ciphertext } = await c.req.json();
        if (!ciphertext) return c.json({ success: false, error: 'ciphertext is required.' }, 400);
        const row = await JoinTokensDb.getByToken(c.env.DB, token);
        if (!row) return c.json({ success: false, error: 'Invalid token.' }, 404);
        if (row.redeemed_by_account_id !== c.get('user').accountId) {
            return c.json({ success: false, error: 'Only the account that redeemed this token may deliver its request payload.' }, 403);
        }
        // `type` discriminates this message on a queue named generically for every future
        // P2P-chat-triggered action, not just this one (wrangler.toml's own comment) — the
        // consumer switches on it, so a second action type can land later without this route
        // changing at all.
        if (c.env.CUBO_TASK_QUEUE) {
            await c.env.CUBO_TASK_QUEUE.send({ type: 'facility-join-request', token, ciphertext });
        } else {
            // Queue binding not configured (e.g. local dev without it in .dev.vars) — degrade to
            // a direct durable write rather than 500ing. Functionally correct either way; only
            // Cloudflare's own retry/backoff on the write itself is what's missing.
            await JoinTokensDb.setPendingPayload(c.env.DB, token, ciphertext);
        }
        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Deliver Join Request Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/facility/join-tokens/:token/decide
 * The real authorization write (SPEC-26 §6/§9) — fired from the admin's chat-card Approve/Reject
 * buttons, only on a token this admin's own facility issued and that's actually `redeemed`.
 * `role` (affiliate/organization only) travels here as a small explicit field since SPEC-26 §6
 * deliberately keeps the full request content out of D1 — the admin's own UI reads it off the
 * decrypted chat card and passes just this one field along at decision time.
 */
app.post('/api/facility/join-tokens/:token/decide', requireUser(), async (c) => {
    try {
        const token = c.req.param('token');
        const { decision, role } = await c.req.json();
        if (!['approved', 'rejected'].includes(decision)) {
            return c.json({ success: false, error: "decision must be 'approved' or 'rejected'." }, 400);
        }
        const row = await JoinTokensDb.getByToken(c.env.DB, token);
        if (!row) return c.json({ success: false, error: 'Invalid token.' }, 404);
        if (row.facility_clinic_id !== c.get('user').clinicId) {
            return c.json({ success: false, error: "Not your facility's token." }, 403);
        }
        const result = await JoinTokensDb.decide(c.env.DB, token, c.get('user').accountId, decision);
        if (result.meta.changes === 0) {
            return c.json({ success: false, error: 'This token is not awaiting a decision (already decided, or not yet redeemed).' }, 409);
        }

        // Real bug found live (kept, unchanged, for 'staff'): an already-registered, independent
        // practitioner (their own account, own clinic_id from individual registration) CAN
        // redeem a 'staff' token via the bearer path — .../redeem's own comment explicitly
        // anticipates this. Blindly flipping accounts.status for every 'staff'-kind decision was
        // a no-op for that account: its clinic_id was never this facility's, and by this app's
        // immutable-clinic_id identity model never gets corrected by flipping `status`.
        // Distinguish a GENUINELY fresh account created inline at redeem time (its clinic_id
        // already IS this facility's — the only case setAccountStatus is meaningful for) from
        // any pre-existing account, which gets a facility_affiliates cross-reference instead —
        // the one relationship table an independent practitioner's own client can actually query
        // back (GET /api/practitioner/affiliations above).
        //
        // 'organization' (migrations/0015) is a genuinely 3rd case, not a variant of the above:
        // the redeeming ACCOUNT belongs to another facility's admin, but what actually gets
        // linked is that admin's own CLINIC (facility-to-facility), not their account — so it
        // goes to facility_organization_affiliates, keyed by clinic ids, not accounts.
        let isFreshStaffAccount = false;
        let redeemerAccount = null;
        if (row.link_kind !== 'affiliate') {
            // 'staff' needs this to tell fresh-account-vs-pre-existing apart (above); 'organization'
            // needs it to resolve the redeeming admin's OWN clinic_id (below) — 'affiliate' never
            // needed this lookup and still doesn't, no reason to add a DB round-trip there.
            redeemerAccount = await AccountsDb.getAccountById(c.env.DB, row.redeemed_by_account_id);
            isFreshStaffAccount = row.link_kind === 'staff' && redeemerAccount?.clinic_id === row.facility_clinic_id;
        }

        if (isFreshStaffAccount) {
            // The account was created 'pending' at redeem time (see that route's own comment) —
            // this is the one place that ever flips it.
            await AccountsDb.setAccountStatus(c.env.DB, row.redeemed_by_account_id, decision === 'approved' ? 'active' : 'rejected');
        } else if (decision === 'approved' && row.link_kind === 'organization') {
            await AccountsDb.addOrganizationAffiliate(c.env.DB, row.facility_clinic_id, redeemerAccount.clinic_id, role || null);
        } else if (decision === 'approved') {
            // Affiliates (practitioners) keep their own separate account/login always
            // (migrations/0005's own rule) — approval only ever adds the cross-reference row,
            // never touches clinic_id. A rejected decision against a pre-existing independent
            // account/organization intentionally does nothing further here — their own
            // account/clinic is unrelated to this facility's decision; calling
            // setAccountStatus('rejected') on it would have locked them out of their OWN account
            // over a different facility's rejection, a second real bug the 'staff' fix above
            // already closes, and the same reasoning is why 'organization' rejections never
            // touch anything either.
            await AccountsDb.addAffiliate(c.env.DB, row.facility_clinic_id, row.redeemed_by_account_id, role || null);
        }

        return c.json({ success: true, decision });
    } catch (err) {
        console.error('❌ Decide Join Token Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/facility/join-tokens/:token/payload
 * SPEC-26 §6's durable-delivery fallback, read side — the admin's own client calls this (from
 * the "pending join request" contact in Cübo) to fetch the SAME ciphertext the redeemer's
 * .../deliver call wrote (via the Queue consumer). Admin-only, only for a token their own
 * facility issued. Never decrypts server-side — only the redeemer's/admin's own clients ever hold
 * the key (see sessionTransfer.js's own header on why).
 */
app.get('/api/facility/join-tokens/:token/payload', requireUser(), async (c) => {
    const token = c.req.param('token');
    const row = await JoinTokensDb.getByToken(c.env.DB, token);
    if (!row) return c.json({ success: false, error: 'Invalid token.' }, 404);
    if (row.facility_clinic_id !== c.get('user').clinicId) {
        return c.json({ success: false, error: "Not your facility's token." }, 403);
    }
    return c.json({ success: true, ciphertext: row.pending_payload || null });
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
 * GET /api/valuesets/hfr-master/:type
 * Real FHIR ValueSet resources for ClinuxFlowFacility.json's HFR-bound coded extension fields
 * (Organization.extension:ownershipCode etc. — see that profile's own `binding` elements) —
 * :type is ABDM's own master-data type code (OWNER, FAC-STATUS, TYPE-SERVICE, MEDICINE,
 * PROFIT-TYPE, NON-PROFIT-TYPE, SPECIALITY-TYPE, FACILITY-REGION), matched 1:1 against a
 * ValueSet.url so a caller resolving a StructureDefinition's own binding.valueSet can fetch this
 * directly. Precomputed by scripts/build-hfr-master-valuesets.js from clinuxflow-abdm-gateway's
 * live GET /hfr/master/data?type=X (the real ABDM sandbox) — bundled, not live-proxied on every
 * request, same reasoning /api/clinic-specialities above already uses (no live-network-call
 * budget on every dropdown render), and the right call specifically because these particular
 * types are confirmed small/stable (2-9 concepts each). LGD state/district/subdistrict and the
 * currently-sandbox-broken facility-type/facility-sub-type/ownership-sub-type endpoints are
 * deliberately NOT here — see the build script's own header for why each is excluded.
 */
app.get('/api/valuesets/hfr-master/:type', (c) => {
    const { type } = c.req.param();
    const entry = hfrMasterValueSets[type];
    if (!entry) return c.json({ success: false, error: `No bundled ValueSet for HFR master-data type "${type}".` }, 404);
    return c.json(entry.valueSet);
});

/**
 * POST /api/facility/conformance
 * Body: { questionnaireJson, responseJson } — same shape as POST /api/workflow/extract.
 * SPEC-24 (docs/SPEC-24-...md) §7 step 5's "prove the whole chain end to end": runs the SAME
 * extraction POST /api/workflow/extract exposes, picks out the Organization it produced, checks
 * it against the real ClinuxFlowFacility StructureDefinition (conformance-validator.js) — the
 * "done = passes validation" replacement for the old ad-hoc `getAnswer(...,'hospital_name')`
 * check (SPEC-23's own "no PlanDefinition/workflow for onboarding" correction stays true, nothing
 * here is a tracked status) — and, once valid, walks ClinuxFlowOnboardingGraph from it
 * (next-best-action.js) for what to capture next. Deliberately Facility-only for now: Provider/
 * Affiliate/Patient don't have a real Profile-anchored capture UI yet (spec §7 step 6), so there's
 * no second bundle member for next-best-action to reason about beyond the reverse (open-ended)
 * candidates a lone, valid Facility already produces.
 */
app.post('/api/facility/conformance', requireUser(), async (c) => {
    try {
        const { questionnaireJson, responseJson } = await c.req.json();
        if (!questionnaireJson || !responseJson) {
            return c.json({ success: false, error: 'questionnaireJson and responseJson are both required.' }, 400);
        }
        const resources = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        const organization = resources.find((r) => r.resourceType === 'Organization');
        if (!organization) {
            return c.json({ success: true, valid: false, errors: [{ path: 'Organization', message: 'No facility data captured yet.' }], organization: null, nextActions: [] });
        }
        const { valid, errors } = validate(clinuxFlowFacilitySd, organization);
        const nextActions = valid
            ? nextBestActions(clinuxFlowOnboardingGraph, [organization], { [organization.id]: { valid: true } })
            : [];
        return c.json({ success: true, valid, errors, organization, nextActions });
    } catch (err) {
        console.error('❌ Facility Conformance Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/provider/conformance
 * Body: { questionnaireJson, responseJson } — same shape as POST /api/facility/conformance.
 * SPEC-24 §7 step 6's own "follow the proven pattern" — the same extract -> validate ->
 * next-best-action chain, extended for Provider's real multiplicity: unlike a Facility (always
 * exactly one Organization), there can be many Practitioner+PractitionerRole pairs, one per real
 * staff member. Paired by their relative order WITHIN each resourceType (both derive their own
 * "#N" repetition index from the same left-to-right scan of the response — see
 * local-extractor.js's own separate-instances fix — so filtering by resourceType and zipping by
 * that filtered position is correct regardless of whether the caller interleaves the two groups
 * or submits all of one then all of the other; ProviderBasicsHost.vue does the latter). A missing
 * PractitionerRole for a given Practitioner (not possible via that component's own lockstep
 * add/remove, but not assumed here) is reported as its own real error, not silently skipped.
 */
app.post('/api/provider/conformance', requireUser(), async (c) => {
    try {
        const { questionnaireJson, responseJson } = await c.req.json();
        if (!questionnaireJson || !responseJson) {
            return c.json({ success: false, error: 'questionnaireJson and responseJson are both required.' }, 400);
        }
        const resources = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        const organization = resources.find((r) => r.resourceType === 'Organization');
        const practitioners = resources.filter((r) => r.resourceType === 'Practitioner');
        const roles = resources.filter((r) => r.resourceType === 'PractitionerRole');

        const validationResults = {};
        if (organization) validationResults[organization.id] = validate(clinuxFlowFacilitySd, organization);

        const providers = practitioners.map((practitioner, i) => {
            const role = roles[i] ?? null;
            const practitionerResult = validate(clinuxFlowProviderSd, practitioner);
            const roleResult = role
                ? validate(clinuxFlowProviderRoleSd, role)
                : { valid: false, errors: [{ path: 'PractitionerRole', message: 'No role captured for this staff member yet.' }] };
            validationResults[practitioner.id] = practitionerResult;
            if (role) validationResults[role.id] = roleResult;
            return {
                practitioner, practitionerValid: practitionerResult.valid, practitionerErrors: practitionerResult.errors,
                role, roleValid: roleResult.valid, roleErrors: roleResult.errors,
            };
        });

        const bundle = [organization, ...practitioners, ...roles].filter(Boolean);
        const nextActions = nextBestActions(clinuxFlowOnboardingGraph, bundle, validationResults);

        return c.json({ success: true, providers, nextActions });
    } catch (err) {
        console.error('❌ Provider Conformance Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/affiliate-organization/conformance
 * Body: { questionnaireJson, responseJson } — same shape as POST /api/facility/conformance.
 * SPEC-24 §7 step 6's "follow the proven pattern" for Affiliate Organization: unlike Affiliate
 * Practitioner Role (never YAML-driven — see GET /api/facility/affiliates/conformance's own
 * header), this entity IS a real repeating group in the Provider-composition YAML
 * (section_affiliate_organization), so this endpoint is a straight repeating-resource sibling of
 * POST /api/provider/conformance — one OrganizationAffiliation per saved entry, each validated
 * against ClinuxFlowAffiliateOrganization, `.organization` auto-linked to this facility's own
 * Organization by local-extractor.js (never a form field — see that file's own comment).
 */
app.post('/api/affiliate-organization/conformance', requireUser(), async (c) => {
    try {
        const { questionnaireJson, responseJson } = await c.req.json();
        if (!questionnaireJson || !responseJson) {
            return c.json({ success: false, error: 'questionnaireJson and responseJson are both required.' }, 400);
        }
        const resources = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        const organization = resources.find((r) => r.resourceType === 'Organization');
        const affiliateOrgs = resources.filter((r) => r.resourceType === 'OrganizationAffiliation');

        const validationResults = {};
        if (organization) validationResults[organization.id] = validate(clinuxFlowFacilitySd, organization);

        const affiliations = affiliateOrgs.map((org) => {
            const result = validate(clinuxFlowAffiliateOrganizationSd, org);
            validationResults[org.id] = result;
            return { organizationAffiliation: org, valid: result.valid, errors: result.errors };
        });

        const bundle = [organization, ...affiliateOrgs].filter(Boolean);
        const nextActions = nextBestActions(clinuxFlowOnboardingGraph, bundle, validationResults);

        return c.json({ success: true, affiliations, nextActions });
    } catch (err) {
        console.error('❌ Affiliate Organization Conformance Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

// RETIRED — POST /api/patient/conformance (SPEC-24 §7 step 6's Patient-specific hand-copy of the
// facility/provider/affiliate-organization conformance skeleton above). Cutover to the generic
// POST /api/resources/Patient/conformance below (resource-registry.js) once that path was proven
// behaviorally equivalent and live-verified end to end (clinux-frontend's FrontDesk.vue/
// PatientHome.vue both repointed) — this is the actual "stop hand-copying" payoff the generic
// layer exists for. Deleted outright, not left dead: grep-confirmed zero remaining frontend
// callers first, same discipline CustomFormHost.vue's own retirement used.

// ============================================================================================
// Generic StructureDefinition-anchored conformance/search/save — the real fix for the 5 hand-
// copied conformance endpoints above (facility/provider/affiliate-organization/affiliates/
// patient all repeat the same extract -> validate -> next-best-action skeleton by hand). Driven
// by resource-registry.js's static map instead: Patient is the only entry today, but a future
// entity is onboarded by adding a registry entry, not a new route file. migrations/0013's
// resource_records table (via resource-records-db.js) is the generic, paid-tier, cross-device
// mirror this layer persists/searches against — local-first (formData.js) stays the primary,
// always-available store for every tier; this is additive, not a replacement.
// ============================================================================================

/**
 * POST /api/resources/:resourceType/conformance
 * Body: { questionnaireJson, responseJson } — identical contract to every conformance route
 * above. 404s on an unregistered resourceType (honest, not a silent no-op). Unlike
 * POST /api/patient/conformance, this DOES run next-best-action once valid — Patient now has its
 * own real graph (ClinuxFlowPatientGraph.json, resource-registry.js), so the reason the old route
 * skipped it ("no real structural dependency here") no longer applies.
 */
app.post('/api/resources/:resourceType/conformance', requireUser(), async (c) => {
    try {
        const { resourceType } = c.req.param();
        const config = resourceConfig(resourceType);
        if (!config) return c.json({ success: false, error: `"${resourceType}" is not a registered resource type.` }, 404);

        const { questionnaireJson, responseJson } = await c.req.json();
        if (!questionnaireJson || !responseJson) {
            return c.json({ success: false, error: 'questionnaireJson and responseJson are both required.' }, 400);
        }
        const resources = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        const resource = resources.find((r) => r.resourceType === config.extractResourceType);
        if (!resource) {
            return c.json({ success: true, valid: false, errors: [{ path: resourceType, message: `No ${resourceType.toLowerCase()} data captured yet.` }], resource: null, nextActions: [] });
        }
        const { valid, errors } = validate(config.structureDefinition, resource);
        const nextActions = valid
            ? nextBestActions(config.graphDefinition, [resource], { [resource.id]: { valid: true } })
            : [];
        return c.json({ success: true, valid, errors, resource, nextActions });
    } catch (err) {
        console.error('❌ Generic Resource Conformance Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * GET /api/resources/:resourceType/search?q=...
 * requirePaidTier() — cross-device reach is the real cost surface (matches runtime.js's own
 * "cloud-durable cross-location coordination" convention exactly). Always scoped to the caller's
 * own clinicId; q is optional (empty = most-recently-updated first, same as an unfiltered list).
 */
app.get('/api/resources/:resourceType/search', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { resourceType } = c.req.param();
        const config = resourceConfig(resourceType);
        if (!config) return c.json({ success: false, error: `"${resourceType}" is not a registered resource type.` }, 404);

        const q = c.req.query('q') || '';
        const clinicId = c.get('user').clinicId;
        const results = await ResourceRecordsDb.search(c.env.DB, resourceType, clinicId, q);
        const records = results.map((row) => ({ id: row.id, resource: JSON.parse(row.data), updatedAt: row.updatedAt }));
        return c.json({ success: true, records });
    } catch (err) {
        console.error('❌ Generic Resource Search Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/resources/:resourceType/save
 * Body: { questionnaireJson, responseJson, recordId } — recordId is the caller's own STABLE
 * local record id (formData.js's own row id, already used as the record identity everywhere
 * client-side). Required, and deliberately overrides whatever id ComprehensiveLocalExtractor.
 * extract() generates: that extractor mints a FRESH local-<type>-<uuid> on every single call
 * (confirmed by reading local-extractor.js's own getOrCreateCacheEntry) — with no recordId
 * override, saving the same patient twice would silently create two resource_records rows
 * instead of updating one, defeating "save" entirely.
 *
 * Deliberately does NOT gate persistence on valid:true (a real, considered choice, not an
 * oversight): Patient.telecom:mobile/identifier:abhaNumber's own known-deferred slicing gap
 * (system-patient-profile-v1.yaml's own comment, confirmed live by this app's existing
 * POST /api/patient/conformance test suite) makes full valid:true currently UNREACHABLE for
 * every real patient regardless of how completely they're filled in — gating save on it would
 * make this route unusable for its only registered consumer. This also matches this codebase's
 * own existing precedent: PUT /api/provider-composition (accounts-db.js's
 * upsertProviderComposition) persists unconditionally too, with conformance kept as a separate,
 * parallel, advisory check (POST /api/provider/conformance) — not a save-time gate. valid/errors
 * are still returned so a caller can show real conformance status without it blocking the save.
 */
app.post('/api/resources/:resourceType/save', requireUser(), requirePaidTier(), async (c) => {
    try {
        const { resourceType } = c.req.param();
        const config = resourceConfig(resourceType);
        if (!config) return c.json({ success: false, error: `"${resourceType}" is not a registered resource type.` }, 404);

        const { questionnaireJson, responseJson, recordId } = await c.req.json();
        if (!questionnaireJson || !responseJson || !recordId) {
            return c.json({ success: false, error: 'questionnaireJson, responseJson and recordId are all required.' }, 400);
        }
        const resources = ComprehensiveLocalExtractor.extract(questionnaireJson, responseJson);
        const resource = resources.find((r) => r.resourceType === config.extractResourceType);
        if (!resource) {
            return c.json({ success: false, error: `No ${resourceType.toLowerCase()} data captured yet.` }, 400);
        }
        resource.id = recordId; // stable identity — see this route's own header comment above

        const { valid, errors } = validate(config.structureDefinition, resource);
        const clinicId = c.get('user').clinicId;
        const searchFields = config.searchFieldExtractor(resource);
        await ResourceRecordsDb.upsert(c.env.DB, resourceType, recordId, clinicId, JSON.stringify(resource), searchFields);
        return c.json({ success: true, valid, errors, resource });
    } catch (err) {
        console.error('❌ Generic Resource Save Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

