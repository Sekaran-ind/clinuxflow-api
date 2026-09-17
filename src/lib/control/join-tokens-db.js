// docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md §8/§9 — D1 persistence for facility_join_tokens
// (migrations/0012). One table, existence-and-decision only (see that migration's own comment
// for why there's no separate request-content table).
const TOKEN_TTL_HOURS = 72; // "expires and can be renewed periodically" (SPEC-26 §3) — a few
// days is long enough for a real hire to actually receive and use it out of band, short enough
// that a forgotten/stale token isn't a standing liability. Renewable, not fixed — see renew below.

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — human-typeable, SPEC-26 §8
export function generateJoinToken() {
  let token = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) token += TOKEN_CHARS[b % TOKEN_CHARS.length];
  return token;
}

export const JoinTokensDb = {
  issue: (db, { token, facilityClinicId, linkKind, issuedByAccountId }) => {
    return db.prepare(
      `INSERT INTO facility_join_tokens (token, facility_clinic_id, link_kind, issued_by_account_id, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'issued', datetime('now', '+${TOKEN_TTL_HOURS} hours'), datetime('now'))`
    ).bind(token, facilityClinicId, linkKind, issuedByAccountId).run();
  },

  getByToken: (db, token) => {
    return db.prepare("SELECT * FROM facility_join_tokens WHERE token = ?").bind(token).first();
  },

  // Only extends a still-`issued`, not-yet-redeemed token — SPEC-26 §7's "periodically renewed,
  // not resurrecting an expired/consumed one" (an admin renewing a dead token instead issues a
  // fresh one — the recovery path stays explicit, matching this schema's existing discipline).
  renew: (db, token, issuedByAccountId) => {
    return db.prepare(
      `UPDATE facility_join_tokens SET expires_at = datetime('now', '+${TOKEN_TTL_HOURS} hours')
       WHERE token = ? AND issued_by_account_id = ? AND status = 'issued'`
    ).bind(token, issuedByAccountId).run();
  },

  // Atomic: only a still-`issued`, unexpired token can be redeemed — the WHERE clause is the
  // actual gate (same conditional-UPDATE idea task-db.js's acquireLock already proves), so a
  // second concurrent redemption attempt on the same token loses (changes === 0), same
  // single-writer reasoning locks elsewhere in this schema already use.
  redeem: async (db, token, redeemedByAccountId) => {
    const result = await db.prepare(
      `UPDATE facility_join_tokens SET status = 'redeemed', redeemed_by_account_id = ?
       WHERE token = ? AND status = 'issued' AND expires_at > datetime('now')`
    ).bind(redeemedByAccountId, token).run();
    return result.meta.changes > 0;
  },

  // The durable fallback write for offline delivery (SPEC-26 §6's Cloudflare Queues revision) —
  // called from the queue consumer, not directly from the redeem route. Only ciphertext, never
  // plaintext (see migrations/0012's own comment).
  setPendingPayload: (db, token, ciphertext) => {
    return db.prepare("UPDATE facility_join_tokens SET pending_payload = ? WHERE token = ?").bind(ciphertext, token).run();
  },

  // Cleared once the admin's client has pulled + decrypted it — no reason to keep ciphertext at
  // rest longer than needed once it's served its one purpose.
  clearPendingPayload: (db, token) => {
    return db.prepare("UPDATE facility_join_tokens SET pending_payload = NULL WHERE token = ?").bind(token).run();
  },

  // The real mutation point (SPEC-26 §9) — admin-only, only on a `redeemed` token they issued.
  // Real bug found live (curl-verified against wrangler dev): the WHERE clause's
  // issued_by_account_id = ? needs its own bind value too — decidedByAccountId is the SAME
  // account (only the original issuer may decide), but D1 still needs it bound once per `?`.
  decide: (db, token, decidedByAccountId, decision) => {
    return db.prepare(
      `UPDATE facility_join_tokens SET status = ?, decided_by_account_id = ?, decided_at = datetime('now'), pending_payload = NULL
       WHERE token = ? AND issued_by_account_id = ? AND status = 'redeemed'`
    ).bind(decision, decidedByAccountId, token, decidedByAccountId).run();
  },

  // The admin's own pending-review list — SPEC-26 §6's "discovery" fix: a redeemed token with no
  // decision yet is exactly the set Cübo's contacts pane needs to surface as "pending join
  // request from X", sourced independently of fetchTeam()/fetchAffiliates(). Joins the
  // redeemer's own account details (same reasoning listAffiliatesByFacility's own join uses) —
  // Cübo's contacts list needs a real name/email to show, not just a bare accountId.
  listPendingByIssuer: async (db, issuedByAccountId) => {
    const { results } = await db.prepare(
      `SELECT t.token, t.link_kind AS linkKind, t.redeemed_by_account_id AS accountId, t.created_at AS createdAt,
              acc.email, acc.admin_name AS adminName
       FROM facility_join_tokens t
       JOIN accounts acc ON acc.id = t.redeemed_by_account_id
       WHERE t.issued_by_account_id = ? AND t.status = 'redeemed'
       ORDER BY t.created_at ASC`
    ).bind(issuedByAccountId).all();
    return results;
  },

  // Every token a facility admin has issued, any status — the "Join Links" management list.
  listByClinic: async (db, facilityClinicId) => {
    const { results } = await db.prepare(
      `SELECT * FROM facility_join_tokens WHERE facility_clinic_id = ? ORDER BY created_at DESC`
    ).bind(facilityClinicId).all();
    return results;
  },
};
