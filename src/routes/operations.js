// Operations: the workspace's Activity log, ABDM transactions and Access & roles screens
// (clinux-frontend /operations/*). Available on every tier — an audit trail isn't a premium
// feature — and scoped by role: an account with activity:clinic sees the whole clinic, everyone
// else only what they did themselves (see src/lib/shared/permissions.js).
//
//   GET  /api/operations/access              the caller's role + permissions, and the full matrix
//   GET  /api/operations/audit               audit events, newest first   (?limit=&before=)
//   POST /api/operations/audit               record a client-side registry event (allow-listed)
//   GET  /api/operations/abdm-transactions   ABDM calls made via the gateway   (?limit=&before=)
import { Hono } from 'hono';
import { requireUser } from '../lib/shared/userAuth.js';
import { AccountsDb } from '../lib/shared/accounts-db.js';
import { AUDIT_ACTIONS, CLIENT_ACTIONS, listAbdmTransactions, listAuditEvents, recordAudit } from '../lib/shared/audit.js';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, can, permissionsFor } from '../lib/shared/permissions.js';

export const operationsRoutes = new Hono();
const app = operationsRoutes;

async function callerAccount(c) {
    const { accountId } = c.get('user');
    return AccountsDb.getAccountById(c.env.DB, accountId);
}

// Whole clinic for activity:clinic, otherwise only the caller's own rows.
async function activityScope(c) {
    const user = c.get('user');
    const account = await callerAccount(c);
    const clinicWide = can(account?.role, 'activity:clinic');
    return { clinicId: user.clinicId, ownOnly: clinicWide ? null : user.accountId, clinicWide };
}

app.get('/api/operations/access', requireUser(), async (c) => {
    const account = await callerAccount(c);
    if (!account) return c.json({ success: false, error: 'Account not found.' }, 404);
    const clinic = await AccountsDb.getClinicById(c.env.DB, account.clinic_id);
    return c.json({
        success: true,
        role: account.role,
        roleLabel: ROLES[account.role]?.label || account.role,
        clinicName: clinic?.name ?? '',
        permissions: permissionsFor(account.role),
        catalog: { roles: ROLES, permissions: PERMISSIONS, matrix: ROLE_PERMISSIONS },
    });
});

app.get('/api/operations/audit', requireUser(), async (c) => {
    const scope = await activityScope(c);
    const { limit, before } = c.req.query();
    const events = await listAuditEvents(c.env.DB, { clinicId: scope.clinicId, actorAccountId: scope.ownOnly, limit, before });
    return c.json({ success: true, scope: scope.clinicWide ? 'clinic' : 'own', events });
});

app.post('/api/operations/audit', requireUser(), async (c) => {
    let body;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ success: false, error: 'Body must be JSON.' }, 400);
    }
    const { action, objectId, metadata } = body || {};
    if (!CLIENT_ACTIONS.includes(action)) {
        return c.json({ success: false, error: `action must be one of: ${CLIENT_ACTIONS.join(', ')}.` }, 400);
    }
    const user = c.get('user');
    await recordAudit(c.env.DB, {
        clinicId: user.clinicId, actorAccountId: user.accountId, actorLabel: user.email, action,
        objectType: AUDIT_ACTIONS[action].object, objectId, metadata,
    });
    return c.json({ success: true }, 201);
});

app.get('/api/operations/abdm-transactions', requireUser(), async (c) => {
    const scope = await activityScope(c);
    const { limit, before } = c.req.query();
    const transactions = await listAbdmTransactions(c.env.DB, { clinicId: scope.clinicId, accountId: scope.ownOnly, limit, before });
    return c.json({ success: true, scope: scope.clinicWide ? 'clinic' : 'own', transactions });
});

