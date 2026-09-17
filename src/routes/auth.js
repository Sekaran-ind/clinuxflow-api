// SPEC-24-adjacent (NIST ZTA discussion) — account/session lifecycle: register/login/me/
// clinic-name/change-password/security-question/forgot-password/invite/team, plus per-clinic
// usage-summary readback. Genuinely cross-cutting/platform in nature (every other route module
// depends on the identity this establishes) rather than "control" or "runtime" in the
// StructureDefinition/PlanDefinition sense — kept as its own file for size, not layer purity.
// Mounted unprefixed (`app.route('/', authRoutes)`) by src/index.js, so every path below is
// already the real, final route — no rewriting.
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { hashPassword, verifyPassword } from '../lib/shared/passwordHash.js';
import { issueSessionToken } from '../lib/shared/session.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { requireUser } from '../lib/shared/userAuth.js';
import { UsageTracking } from '../lib/shared/usageTracking.js';

export const authRoutes = new Hono();
const app = authRoutes;

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
        // SPEC-26 (migrations/0012) — a staff account created via facility-join-token redemption
        // starts 'pending' and cannot log in until the facility admin approves the request; a
        // rejected one never can again. Checked AFTER password verification (not before) so this
        // never leaks account-status information to a wrong-password guess.
        if (account.status === 'pending') {
            return c.json({ success: false, error: 'Your account is awaiting approval from the facility admin.' }, 403);
        }
        if (account.status === 'rejected') {
            return c.json({ success: false, error: 'This join request was not approved.' }, 403);
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

// Normalizes a security answer the same way on both the set and verify paths (trimmed +
// lowercased) so "Blue"/"blue "/" BLUE" all match -- a security answer isn't a password, users
// shouldn't be locked out by casing/whitespace they don't remember precisely.
function normalizeSecurityAnswer(answer) {
    return String(answer).trim().toLowerCase();
}

/**
 * PATCH /api/auth/security-question
 * Body: { securityQuestion, securityAnswer }
 * SPEC-20 §4's Forgot Password design. Deliberately separate from registration (see
 * accounts-db.js's updateSecurityQuestion comment) -- the new entry-flow UI calls this right
 * after register succeeds, using the token register already returned; also how a pre-existing
 * account (created before migrations/0009) sets one for the first time.
 */
app.patch('/api/auth/security-question', requireUser(), async (c) => {
    try {
        const { securityQuestion, securityAnswer } = await c.req.json();
        if (!securityQuestion || !String(securityQuestion).trim() || !securityAnswer || !String(securityAnswer).trim()) {
            return c.json({ success: false, error: 'securityQuestion and securityAnswer are required.' }, 400);
        }

        const accountId = c.get('user').accountId;
        const answerHash = await hashPassword(normalizeSecurityAnswer(securityAnswer));
        await AccountsDb.updateSecurityQuestion(c.env.DB, accountId, String(securityQuestion).trim(), answerHash);

        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Update Security Question Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/auth/forgot-password/question
 * Body: { email }
 * Public (X-Service-Key only, no session -- the whole point is the caller isn't logged in).
 * Returns the account's own security question so the reset step can ask it. Honest tradeoff, not
 * hidden: unlike login's deliberately generic "Invalid email or password" (which avoids leaking
 * WHICH part was wrong), this necessarily reveals whether an account exists for the email --
 * showing a real recovery question requires knowing there's an account to show one for. Accepted
 * for this app's real threat model (a small clinic's own accounts), not a production
 * enumeration-hardened flow.
 */
app.post('/api/auth/forgot-password/question', async (c) => {
    try {
        const { email } = await c.req.json();
        if (!email) return c.json({ success: false, error: 'email is required.' }, 400);

        const normalizedEmail = String(email).trim().toLowerCase();
        const account = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (!account || !account.security_question) {
            return c.json({ success: false, error: 'No recovery option is set up for this account yet.' }, 404);
        }

        return c.json({ success: true, securityQuestion: account.security_question });
    } catch (err) {
        console.error('❌ Forgot Password Question Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

/**
 * POST /api/auth/forgot-password/reset
 * Body: { email, securityAnswer, newPassword }
 * Public. Verifies the security answer and resets the password directly -- no separate
 * token/expiry step, since with no email delivery a token would just be shown straight back in
 * the same UI anyway, adding a click without adding real security. Deliberately does NOT return a
 * session token -- the user logs in fresh with the new password afterward, same as any other
 * password reset.
 */
app.post('/api/auth/forgot-password/reset', async (c) => {
    try {
        const { email, securityAnswer, newPassword } = await c.req.json();
        if (!email || !securityAnswer || !newPassword) {
            return c.json({ success: false, error: 'email, securityAnswer, and newPassword are required.' }, 400);
        }
        if (newPassword.length < 8) {
            return c.json({ success: false, error: 'New password must be at least 8 characters.' }, 400);
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const account = await AccountsDb.getAccountByEmail(c.env.DB, normalizedEmail);
        if (!account || !account.security_answer_hash) {
            return c.json({ success: false, error: 'No recovery option is set up for this account yet.' }, 404);
        }
        const answerCorrect = await verifyPassword(normalizeSecurityAnswer(securityAnswer), account.security_answer_hash);
        if (!answerCorrect) {
            return c.json({ success: false, error: 'That answer is incorrect.' }, 401);
        }

        const newHash = await hashPassword(newPassword);
        await AccountsDb.updatePasswordHash(c.env.DB, account.id, newHash);

        return c.json({ success: true });
    } catch (err) {
        console.error('❌ Forgot Password Reset Exception:', err.message);
        return c.json({ success: false, error: err.message }, 400);
    }
});

// "a clinic's 1-4 staff logins share one subscription" -- migrations/0003_add_accounts_and_
// clinics.sql's own stated design constraint for this table, not a new business rule invented
// here. Applies to every clinic regardless of tier -- multi-user itself isn't paid-gated, unlike
// requirePaidTier()'s other features.
// Exported (not module-local) — src/routes/control.js's POST .../redeem (SPEC-26, staff link_kind)
// enforces this exact same cap, so it has to be the same constant, not a second literal `4` that
// could drift.
export const MAX_ACCOUNTS_PER_CLINIC = 4;

// POST /api/auth/invite (admin invents+shares a new teammate's password) — RETIRED (SPEC-26).
// Replaced by src/routes/control.js's POST /api/facility/join-tokens/:token/redeem: the joining
// person now sets their own password there, and the account starts 'pending' until
// .../decide approves it, closing the real gap the old flow had (an invited account was
// immediately usable, with no admin decision point at all beyond having shared the password).

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
            id: a.id, email: a.email, adminName: a.admin_name, designation: a.designation, createdAt: a.created_at, status: a.status,
        })),
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
