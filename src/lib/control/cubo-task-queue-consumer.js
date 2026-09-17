// The consumer for CUBO_TASK_QUEUE (wrangler.toml) — named generically because the user's own
// framing for this queue is broader than one feature: Cübo should eventually dispatch P2P-chat-
// triggered actions off a real Task specification, not one hardcoded handler per action type
// wired into CuboContactConversation.vue. That generalization is real future work, not built yet
// — this file is deliberately structured as a small `type -> handler` dispatch table so a second
// action type can register here later without touching the queue binding, the producer route, or
// this function's own signature again.
//
// The one handler registered so far — docs/SPEC-26-FACILITY-JOIN-TOKEN-LINKING.md §6's durable
// fallback for offline delivery of a facility-join-request card when the admin wasn't live on the
// P2P chat session at redemption time. Deliberately does NOT try to "wait for the admin's
// browser" — no Queue product does that; what this buys is retried, at-least-once *ingestion*
// into durable storage (JoinTokensDb.setPendingPayload), so a transient D1 write failure doesn't
// silently drop the redeemer's only durable copy. The admin's own client pulls it on next
// load/reconnect (see clinux-frontend's Cübo contacts-sourcing fix, same spec §6).
import { JoinTokensDb } from './join-tokens-db.js';

const HANDLERS = {
  // { type: 'facility-join-request', token, ciphertext } — the SAME encodeSessionTransfer()
  // string the live P2P chat path also sends (see sessionShare.js's
  // buildJoinRequestSharePayload). Only ciphertext ever reaches this consumer; it never decrypts
  // or inspects the payload, just relays it to the token's own row.
  'facility-join-request': async (body, env) => {
    const { token, ciphertext } = body;
    if (!token || !ciphertext) throw new Error('facility-join-request message missing token/ciphertext.');
    await JoinTokensDb.setPendingPayload(env.DB, token, ciphertext);
  },
};

export async function handleCuboTaskQueue(batch, env) {
  for (const message of batch.messages) {
    try {
      const handler = HANDLERS[message.body?.type];
      if (!handler) throw new Error(`No handler registered for task queue message type "${message.body?.type}".`);
      await handler(message.body, env);
      message.ack();
    } catch (err) {
      console.error('❌ Cübo task queue consumer exception:', err.message);
      message.retry();
    }
  }
}
