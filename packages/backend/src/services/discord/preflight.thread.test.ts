// Preflight-level tests for thread inheritance (Bug A) and read-only denial
// (Bug B). Verifies the denial reasons/log strings emitted by the preflight
// pipeline: 'Channel is ignored' and 'Channel is read-only'. Read-only must
// deny even when the bot is @-mentioned.
//
// Run with: npx tsx --test packages/backend/src/services/discord/preflight.thread.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageBatch } from './types.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'discord-preflight-test-'));
const dbPath = join(tmpRoot, 'test.db');

const { initDb } = await import('../db.js');
const { saveRules } = await import('./rules.js');
const { preflight } = await import('./preflight.js');
const { PairingService } = await import('./pairing.js');

const PARENT = 'parent-channel-id';
const THREAD = 'thread-channel-id';
const GUILD = 'guild-id';
const BOT_ID = 'bot-user-id';
const USER_ID = 'human-user-id';

// Minimal stand-in for a discord.js Message. Preflight only reaches
// author.{bot,id,username} and (for mention checks) client/mentions/guild.
// The read-only and ignore denials fire before any mention logic.
function fakeMessage(opts: { mentionsBot?: boolean } = {}): any {
  return {
    author: { bot: false, id: USER_ID, username: 'tester' },
    client: { user: { id: BOT_ID } },
    guild: null,
    mentions: {
      users: { has: (id: string) => (opts.mentionsBot ? id === BOT_ID : false) },
      roles: { size: 0 },
    },
  };
}

function makeBatch(channelId: string, parentChannelId: string | null, opts: { mentionsBot?: boolean } = {}): MessageBatch {
  const msg = fakeMessage(opts);
  return {
    messages: [msg],
    channelId,
    parentChannelId,
    userId: USER_ID,
    guildId: GUILD,
    combinedContent: 'hi',
    firstMessage: msg,
    lastMessage: msg,
  };
}

before(() => {
  initDb(dbPath);
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('preflight thread + readOnly denials', () => {
  it('thread inherits parent ignore → denied "Channel is ignored"', async () => {
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'S', context: '' } },
      channels: { [PARENT]: { id: PARENT, name: 'parent', serverId: GUILD, ignore: true } },
      users: {},
    });
    const result = await preflight(makeBatch(THREAD, PARENT), new PairingService());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'Channel is ignored');
  });

  it('thread inherits parent readOnly → denied "Channel is read-only"', async () => {
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'S', context: '' } },
      channels: { [PARENT]: { id: PARENT, name: 'parent', serverId: GUILD, readOnly: true } },
      users: {},
    });
    const result = await preflight(makeBatch(THREAD, PARENT), new PairingService());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'Channel is read-only');
  });

  it('readOnly denies even when the bot is @-mentioned', async () => {
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'S', context: '' } },
      channels: { [PARENT]: { id: PARENT, name: 'parent', serverId: GUILD, readOnly: true } },
      users: {},
    });
    // Directly in the read-only channel, with a mention — still denied.
    const result = await preflight(makeBatch(PARENT, null, { mentionsBot: true }), new PairingService());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'Channel is read-only');
  });

  // Note: the "thread with no parent rule falls through to server default"
  // case is asserted at the rules layer in rules.thread.test.ts — reaching that
  // path through preflight would require loading full app config, which is out
  // of scope for a unit test of the denial paths.
});
