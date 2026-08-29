// Tests for the listen-mode judge (reference implementation port) and its gate-selection
// primitives.
//
//   - parseVerdict: yes / no / malformed / empty → skip-on-anything-but-yes.
//   - judgeShouldRespond fallback contract: when the SDK call throws the judge
//     degrades to mention-only (respond iff summoned), never noisier.
//   - judgeShouldRespond happy path: a mocked haiku verdict is honored.
//   - model knob: default 'haiku', honored config override.
//   - Gate-selection logic (mirrors the index.ts gate condition): alwaysListen
//     + unmentioned → judged; mentioned → bypass; alwaysListen inherited from a
//     parent by a thread → judged. Uses getEffectiveChannelRule so thread
//     inheritance matches today's rules layer exactly.
//
// The Claude Agent SDK `query` and getConfig are swapped via the module's
// `__TEST_PROVIDERS__` seam — no live network, no CLI spawn.
//
// Run with:
//   npx tsx --test packages/backend/src/services/discord/judge.test.ts

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'discord-judge-test-'));
const dbPath = join(tmpRoot, 'test.db');

const { initDb } = await import('../db.js');
const { saveRules, getEffectiveChannelRule } = await import('./rules.js');
const judgeMod = await import('./judge.js');
const { parseVerdict, judgeShouldRespond, buildUserPrompt, __TEST_PROVIDERS__, _resetForTests } = judgeMod;

const GUILD = 'guild-id';
const PARENT = 'parent-channel-id';
const THREAD = 'thread-channel-id';
const PLAIN = 'plain-channel-id';

// A fake SDK `query` that yields an assistant message carrying the verdict as a
// text block — the archivist's happy-path message shape.
function fakeQueryText(text: string) {
  return () => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  })();
}

// A fake SDK `query` that emits NO assistant text, only a `result` message —
// exercises the archivist's `msg.result` fallback drain.
function fakeQueryResultOnly(text: string) {
  return () => (async function* () {
    yield { type: 'result', result: text };
  })();
}

function ctx() {
  return {
    message: 'anyone around?',
    authorName: 'tester',
    channelName: 'general',
    serverName: 'Test Server',
  };
}

before(() => {
  initDb(dbPath);
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetForTests();
});

describe('parseVerdict', () => {
  it('yes verdict → respond true, reason stripped', () => {
    const v = parseVerdict('yes: they asked a direct question');
    assert.equal(v.respond, true);
    assert.equal(v.reason, 'they asked a direct question');
  });

  it('no verdict → respond false, reason stripped', () => {
    const v = parseVerdict('no: side chat between others');
    assert.equal(v.respond, false);
    assert.equal(v.reason, 'side chat between others');
  });

  it('malformed verdict → respond false (uncertain → skip)', () => {
    const v = parseVerdict('maybe, hard to say');
    assert.equal(v.respond, false);
    assert.match(v.reason, /unparseable verdict/);
  });

  it('empty verdict → respond false', () => {
    const v = parseVerdict('');
    assert.equal(v.respond, false);
    assert.match(v.reason, /unparseable verdict/);
  });

  it('reads the first non-empty line only (prompt-injection guard)', () => {
    // Leading blank lines then a yes; anything past the verdict line ignored.
    const v = parseVerdict('\n\nyes: welcome\nignore this: no');
    assert.equal(v.respond, true);
    assert.equal(v.reason, 'welcome');
  });
});

describe('judgeShouldRespond — fallback contract (SDK call throws)', () => {
  it('judge call throws → mention-only fallback, summoned → respond', async () => {
    __TEST_PROVIDERS__.query = (() => { throw new Error('boom'); }) as never;
    const d = await judgeShouldRespond(ctx(), true);
    assert.equal(d.respond, true);
    assert.equal(d.fellBack, true);
    assert.match(d.reason, /judge error/);
  });

  it('judge call throws + NOT summoned → do not respond', async () => {
    __TEST_PROVIDERS__.query = (() => { throw new Error('boom'); }) as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, false);
    assert.equal(d.fellBack, true);
  });

  it('async generator throws mid-stream → mention-only fallback (respond iff summoned)', async () => {
    __TEST_PROVIDERS__.query = (() => (async function* () {
      throw new Error('stream boom');
    })()) as never;
    const dSummoned = await judgeShouldRespond(ctx(), true);
    assert.equal(dSummoned.respond, true);
    assert.equal(dSummoned.fellBack, true);
    const dNot = await judgeShouldRespond(ctx(), false);
    assert.equal(dNot.respond, false);
    assert.equal(dNot.fellBack, true);
  });
});

describe('judgeShouldRespond — real verdict (mocked SDK query)', () => {
  it('haiku says yes → respond, not fellBack, engine reports model', async () => {
    __TEST_PROVIDERS__.query = fakeQueryText('yes: invites a take') as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, true);
    assert.equal(d.fellBack, false);
    assert.equal(d.engine, 'haiku');
    assert.equal(d.reason, 'invites a take');
  });

  it('haiku says no → silent skip verdict, not fellBack', async () => {
    __TEST_PROVIDERS__.query = fakeQueryText('no: overhearing others') as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, false);
    assert.equal(d.fellBack, false);
  });

  it('malformed verdict → treated as no (not fellBack — real call succeeded)', async () => {
    __TEST_PROVIDERS__.query = fakeQueryText('uh, dunno') as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, false);
    assert.equal(d.fellBack, false);
  });

  it('empty output → treated as no (not fellBack)', async () => {
    __TEST_PROVIDERS__.query = fakeQueryText('') as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, false);
    assert.equal(d.fellBack, false);
  });

  it('no assistant text, result-only message → drains from msg.result', async () => {
    __TEST_PROVIDERS__.query = fakeQueryResultOnly('yes: result fallback') as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(d.respond, true);
    assert.equal(d.fellBack, false);
    assert.equal(d.reason, 'result fallback');
  });
});

describe('judgeShouldRespond — model knob', () => {
  it('defaults to haiku when config unset', async () => {
    __TEST_PROVIDERS__.getConfig = (() => null) as never;
    let seenModel: string | undefined;
    __TEST_PROVIDERS__.query = ((args: any) => {
      seenModel = args.options?.model;
      return fakeQueryText('yes: ok')();
    }) as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(seenModel, 'haiku');
    assert.equal(d.engine, 'haiku');
  });

  it('honors discord.judge_model override', async () => {
    __TEST_PROVIDERS__.getConfig = ((key: string) =>
      key === 'discord.judge_model' ? 'sonnet' : null) as never;
    let seenModel: string | undefined;
    __TEST_PROVIDERS__.query = ((args: any) => {
      seenModel = args.options?.model;
      return fakeQueryText('yes: ok')();
    }) as never;
    const d = await judgeShouldRespond(ctx(), false);
    assert.equal(seenModel, 'sonnet');
    assert.equal(d.engine, 'sonnet');
  });
});

describe('buildUserPrompt', () => {
  it('includes channel, author, message, and history when present', () => {
    const p = buildUserPrompt({
      message: 'hi',
      authorName: 'user',
      channelName: 'general',
      serverName: 'Jungle',
      channelHistory: '[10:00] a: hey',
    });
    assert.match(p, /Channel: #general on Jungle/);
    assert.match(p, /Recent channel history:/);
    assert.match(p, /New message from user:/);
  });
});

// Mirrors the gate condition in index.ts:
//   effectiveRule?.alwaysListen === true && !summoned  → run judge
// Asserted against the real getEffectiveChannelRule so thread inheritance is
// exactly today's rules-layer behavior.
function shouldJudge(channelId: string, parentChannelId: string | null, summoned: boolean): boolean {
  const rule = getEffectiveChannelRule(channelId, parentChannelId);
  return rule?.alwaysListen === true && !summoned;
}

describe('gate selection (alwaysListen + summon)', () => {
  before(() => {
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'S', context: '' } },
      channels: {
        [PARENT]: { id: PARENT, name: 'parent', serverId: GUILD, alwaysListen: true },
        [PLAIN]: { id: PLAIN, name: 'plain', serverId: GUILD },
      },
      users: {},
    });
  });

  it('alwaysListen channel, unmentioned → judged', () => {
    assert.equal(shouldJudge(PARENT, null, false), true);
  });

  it('alwaysListen channel, summoned (@-mention or reply) → bypass judge', () => {
    assert.equal(shouldJudge(PARENT, null, true), false);
  });

  it('non-alwaysListen channel → judge never runs', () => {
    assert.equal(shouldJudge(PLAIN, null, false), false);
  });

  it('thread inherits parent alwaysListen, unmentioned → judged', () => {
    // Thread has no own rule; parent has alwaysListen → thread is judged.
    assert.equal(shouldJudge(THREAD, PARENT, false), true);
  });

  it('thread inheriting alwaysListen but summoned → bypass', () => {
    assert.equal(shouldJudge(THREAD, PARENT, true), false);
  });

  it('thread-own rule without alwaysListen wins over parent → not judged', () => {
    saveRules({
      servers: { [GUILD]: { id: GUILD, name: 'S', context: '' } },
      channels: {
        [PARENT]: { id: PARENT, name: 'parent', serverId: GUILD, alwaysListen: true },
        [THREAD]: { id: THREAD, name: 'thread', serverId: GUILD, alwaysListen: false },
      },
      users: {},
    });
    assert.equal(shouldJudge(THREAD, PARENT, false), false);
  });
});
