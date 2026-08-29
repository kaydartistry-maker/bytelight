// Tests for thread rule inheritance (Bug A) and read-only enforcement (Bug B).
//
// Threads carry their own channel id, not the parent's. Rule evaluation must
// inherit the parent channel's rules (ignore, readOnly, requireMention) while a
// rule keyed by the thread's own id still wins (most-specific-wins).
//
// Run with: npx tsx --test packages/backend/src/services/discord/rules.thread.test.ts

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'discord-rules-test-'));
const dbPath = join(tmpRoot, 'test.db');

const { initDb } = await import('../db.js');
const {
  saveRules,
  isChannelIgnored,
  isChannelReadOnly,
  requiresMention,
  getEffectiveChannelRule,
} = await import('./rules.js');

const PARENT = 'parent-channel-id';
const THREAD = 'thread-channel-id';
const GUILD = 'guild-id';
const PLAIN = 'plain-channel-id';

before(() => {
  initDb(dbPath);
  // saveRules persists to DB and reloads the in-memory maps.
  saveRules({
    servers: {
      [GUILD]: { id: GUILD, name: 'Test Server', context: '' },
    },
    channels: {
      // Parent channel is ignored + read-only, with mention required.
      [PARENT]: {
        id: PARENT,
        name: 'parent',
        serverId: GUILD,
        ignore: true,
        readOnly: true,
        requireMention: true,
      },
      // A plain channel with no special flags.
      [PLAIN]: { id: PLAIN, name: 'plain', serverId: GUILD },
    },
    users: {},
  });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('thread inherits parent rules (Bug A)', () => {
  it('thread inherits parent ignore', () => {
    // Thread has no own rule; parent is ignored → thread is ignored.
    assert.equal(isChannelIgnored(THREAD, GUILD, PARENT), true);
  });

  it('thread inherits parent readOnly', () => {
    assert.equal(isChannelReadOnly(THREAD, PARENT), true);
  });

  it('thread inherits parent requireMention', () => {
    assert.equal(requiresMention(THREAD, GUILD, false, PARENT), true);
  });

  it('thread with no parent rule falls through to server default (current behavior)', () => {
    // Thread under a parent that has no channel rule → not ignored, not readOnly,
    // and requireMention uses the passed default (server-level behavior).
    assert.equal(isChannelIgnored(THREAD, GUILD, 'unknown-parent'), false);
    assert.equal(isChannelReadOnly(THREAD, 'unknown-parent'), false);
    assert.equal(requiresMention(THREAD, GUILD, true, 'unknown-parent'), true);
    assert.equal(requiresMention(THREAD, GUILD, false, 'unknown-parent'), false);
  });

  it('thread-own rule wins over parent (most-specific-wins)', () => {
    // Give the thread its own rule that is NOT ignored/readOnly, under an
    // ignored+readOnly parent. The thread's own rule should win.
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'Test Server', context: '' } },
      channels: {
        [PARENT]: {
          id: PARENT,
          name: 'parent',
          serverId: GUILD,
          ignore: true,
          readOnly: true,
        },
        [THREAD]: {
          id: THREAD,
          name: 'thread',
          serverId: GUILD,
          ignore: false,
          readOnly: false,
        },
      },
      users: {},
    });

    assert.equal(getEffectiveChannelRule(THREAD, PARENT)?.id, THREAD);
    assert.equal(isChannelIgnored(THREAD, GUILD, PARENT), false);
    assert.equal(isChannelReadOnly(THREAD, PARENT), false);
  });
});

describe('non-thread channels unchanged', () => {
  before(() => {
    // Restore the baseline rule set (parent ignored+readOnly, plain channel).
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'Test Server', context: '' } },
      channels: {
        [PARENT]: {
          id: PARENT,
          name: 'parent',
          serverId: GUILD,
          ignore: true,
          readOnly: true,
          requireMention: true,
        },
        [PLAIN]: { id: PLAIN, name: 'plain', serverId: GUILD },
      },
      users: {},
    });
  });

  it('a plain channel (no parent) is not ignored or read-only', () => {
    assert.equal(isChannelIgnored(PLAIN, GUILD), false);
    assert.equal(isChannelReadOnly(PLAIN), false);
  });

  it('an ignored channel accessed directly (no parent) is still ignored', () => {
    assert.equal(isChannelIgnored(PARENT, GUILD), true);
    assert.equal(isChannelReadOnly(PARENT), true);
    assert.equal(requiresMention(PARENT, GUILD, false), true);
  });

  it('server-level ignoredChannels covers a thread whose parent is listed', () => {
    saveRules({
      servers: {
        [GUILD]: {
          id: GUILD,
          name: 'Test Server',
          context: '',
          ignoredChannels: [PARENT],
        },
      },
      channels: {},
      users: {},
    });
    // Thread with no channel rule, parent listed in server ignoredChannels.
    assert.equal(isChannelIgnored(THREAD, GUILD, PARENT), true);
    // Direct access to the listed channel still ignored.
    assert.equal(isChannelIgnored(PARENT, GUILD), true);
    // Unrelated channel not ignored.
    assert.equal(isChannelIgnored(PLAIN, GUILD, null), false);
  });
});
