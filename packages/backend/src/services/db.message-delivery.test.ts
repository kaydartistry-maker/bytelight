import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const tmpRoot = mkdtempSync(join(tmpdir(), 'message-delivery-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, createMessage, getMessageByClientId } = await import('./db.js');

before(() => {
  initDb(dbPath);
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO threads (id, name, type, created_at, last_activity_at)
    VALUES ('delivery-thread', 'delivery', 'named', ?, ?)
  `).run(now, now);
  db.close();
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('durable message delivery ids', () => {
  it('finds the original row after a retry using the same client id', () => {
    const created = createMessage({
      id: 'message-1', threadId: 'delivery-thread', role: 'user',
      content: 'only once', createdAt: new Date().toISOString(), clientId: 'client-1',
    });
    assert.equal(created.client_id, 'client-1');
    assert.equal(getMessageByClientId('client-1')?.id, created.id);
  });

  it('enforces one durable row per client id', () => {
    assert.throws(() => createMessage({
      id: 'message-2', threadId: 'delivery-thread', role: 'user',
      content: 'duplicate', createdAt: new Date().toISOString(), clientId: 'client-1',
    }), /UNIQUE constraint failed/);
  });

  it('can initialize the additive migration repeatedly', () => {
    assert.doesNotThrow(() => initDb(dbPath));
  });

  it('adds the column before indexing a legacy messages table', () => {
    const legacyPath = join(tmpRoot, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT DEFAULT 'text',
        platform TEXT DEFAULT 'web', metadata TEXT, reply_to_id TEXT, edited_at TEXT,
        deleted_at TEXT, original_content TEXT, created_at TEXT NOT NULL,
        delivered_at TEXT, read_at TEXT, companion_id TEXT
      );
    `);
    legacy.close();

    assert.doesNotThrow(() => initDb(legacyPath));
    const upgraded = new Database(legacyPath, { readonly: true });
    const columns = upgraded.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const indexes = upgraded.prepare('PRAGMA index_list(messages)').all() as Array<{ name: string }>;
    upgraded.close();
    assert.ok(columns.some(column => column.name === 'client_id'));
    assert.ok(indexes.some(index => index.name === 'idx_messages_client_id'));
  });
});
