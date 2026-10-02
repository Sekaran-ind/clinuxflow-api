// What each ClinuxFlow account role may do — the policy itself is data, in data/entitlements.json
// (roles, permissions, and the HPR-role grants that take effect once accounts link to their
// PractitionerRole). This module only reads it. Shown in clinux-frontend's Operations → Access &
// roles; `enforced` per permission says honestly whether a server route checks it.
import entitlements from '../../../data/entitlements.json' with { type: 'json' };

export const ROLES = Object.fromEntries(Object.entries(entitlements.roles).map(([id, { label, summary }]) => [id, { label, summary }]));
export const PERMISSIONS = entitlements.permissions;
export const ROLE_PERMISSIONS = Object.fromEntries(Object.entries(entitlements.roles).map(([id, r]) => [id, r.grants]));
export const HPR_ROLE_GRANTS = Object.fromEntries(Object.entries(entitlements.hprRoles).filter(([k]) => !k.startsWith('$')));
export const DEFAULT_ROLE = entitlements.defaultRole;

export function permissionsFor(role) {
    return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[DEFAULT_ROLE];
}

export function can(role, permission) {
    return permissionsFor(role).includes(permission);
}
