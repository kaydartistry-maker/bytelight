import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgePending, readOutbox, upsertPending, writeOutbox, type PendingMessage } from './message-outbox.js';

const first: PendingMessage = {
  type: 'message', clientId: 'client-1', threadId: 'thread-1', content: 'hello',
  contentType: 'text', metadata: { attachments: [{ fileId: 'file-1' }] },
};

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('message outbox', () => {
  it('persists the complete message until its client id is acknowledged', () => {
    const storage = fakeStorage();
    const pending = upsertPending([], first);
    writeOutbox(pending, storage);
    assert.deepEqual(readOutbox(storage), [first]);
    assert.deepEqual(acknowledgePending(pending, first.clientId), []);
  });

  it('deduplicates reconnect retries by client id', () => {
    assert.deepEqual(upsertPending([first], { ...first, content: 'updated' }), [{ ...first, content: 'updated' }]);
  });

  it('ignores corrupt persisted state', () => {
    assert.deepEqual(readOutbox({ getItem: () => '{broken' }), []);
  });
});
