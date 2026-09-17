import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleCuboTaskQueue } from './cubo-task-queue-consumer.js';
import { JoinTokensDb } from './join-tokens-db.js';

function fakeMessage(body) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe('handleCuboTaskQueue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatches a facility-join-request message to JoinTokensDb.setPendingPayload and acks it', async () => {
    const setSpy = vi.spyOn(JoinTokensDb, 'setPendingPayload').mockResolvedValue(undefined);
    const message = fakeMessage({ type: 'facility-join-request', token: 'ABC12345', ciphertext: 'cfx1.xxx' });
    const env = { DB: {} };
    await handleCuboTaskQueue({ messages: [message] }, env);
    expect(setSpy).toHaveBeenCalledWith(env.DB, 'ABC12345', 'cfx1.xxx');
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries (does not ack) a facility-join-request message missing token/ciphertext', async () => {
    const message = fakeMessage({ type: 'facility-join-request', token: null, ciphertext: null });
    await handleCuboTaskQueue({ messages: [message] }, { DB: {} });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('retries (does not throw / crash the batch) a message of an unregistered type', async () => {
    const message = fakeMessage({ type: 'some-future-action', foo: 'bar' });
    await expect(handleCuboTaskQueue({ messages: [message] }, { DB: {} })).resolves.toBeUndefined();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('processes every message in the batch independently — one failure does not block another message being acked', async () => {
    vi.spyOn(JoinTokensDb, 'setPendingPayload').mockResolvedValue(undefined);
    const bad = fakeMessage({ type: 'unknown-type' });
    const good = fakeMessage({ type: 'facility-join-request', token: 'X', ciphertext: 'y' });
    await handleCuboTaskQueue({ messages: [bad, good] }, { DB: {} });
    expect(bad.retry).toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalled();
  });
});
