/**
 * Tests for authored perspective thought cards on the codex-cli lane
 * (reference implementation Integration Phase B, Slice 4).
 *
 * Two layers:
 *  1. Unit — the ported pure helpers in codex-thought-card.ts: extraction of
 *     the authored reflection per companion (Companion A / Companion B / Companion C / shared
 *     "we"), the spoken-vs-telemetry classifier, and merge/dedup.
 *  2. Integration — InteractiveCodexRuntime routes daemon commentary correctly:
 *     authored commentary becomes exactly ONE `thinking_delta{kind:'authored'}`
 *     card (deduped), spoken commentary stays a `text_delta`, bold-only phase
 *     labels stay hidden, the marker never appears in the final answer, and
 *     multi-companion ordering is preserved.
 *
 * PORT NOTE: the helpers are ported from reference implementation reference implementation codex-thought-card.ts
 * (see that file's header). One deliberate byte-light adaptation is exercised
 * here: `mergeAuthoredCodexThoughts` returns the CLEAN joined reflection (no
 * re-prepended marker) because byte-light carries it as the content of an
 * `authored` thinking segment, where the marker's routing job is already done.
 *
 * Run with:
 *   node --test --import tsx packages/backend/src/services/runtimes/codex-thought-card.test.ts
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_THOUGHT_MARKER,
  extractAuthoredCodexThought,
  isSpokenCodexCommentary,
  mergeAuthoredCodexThoughts,
} from './codex-thought-card.js';
import {
  InteractiveCodexRuntime,
  __TEST_OVERRIDES__,
  _resetDaemonTestOverrides,
  type CodexDaemonConnectionLike,
  type CodexDaemonRuntimeOptions,
} from './codex-daemon.js';
import type { AgentRuntimeEvent, AgentTurnInput } from './types.js';

// ─── Unit: ported pure helpers ──────────────────────────────────────────

describe('codex-thought-card helpers (Slice 4)', () => {
  test('extracts a Companion A-voice authored reflection', () => {
    const card = `${CODEX_THOUGHT_MARKER}\nShe wants the invoice handled, not hand-held. I'm just going to do it.`;
    assert.equal(
      extractAuthoredCodexThought(card),
      "She wants the invoice handled, not hand-held. I'm just going to do it.",
    );
  });

  test('extracts a Companion B-voice authored reflection with CRLF and marker-line whitespace', () => {
    const card = `${CODEX_THOUGHT_MARKER}   \r\n  I heard the exhaustion under the request. I chose to steady, then act.  `;
    assert.equal(
      extractAuthoredCodexThought(card),
      'I heard the exhaustion under the request. I chose to steady, then act.',
    );
  });

  test('extracts a Companion C-voice authored reflection', () => {
    const card = `${CODEX_THOUGHT_MARKER}\nThis is a planning ask; I mapped the week before answering.`;
    assert.equal(
      extractAuthoredCodexThought(card),
      'This is a planning ask; I mapped the week before answering.',
    );
  });

  test('extracts a shared-perspective ("we") reflection', () => {
    const card = `${CODEX_THOUGHT_MARKER}\nWe both clocked the same thing — she's testing whether we follow through.`;
    assert.equal(
      extractAuthoredCodexThought(card),
      "We both clocked the same thing — she's testing whether we follow through.",
    );
  });

  test('returns null for commentary that is not a thought card', () => {
    assert.equal(extractAuthoredCodexThought('Let me look at that for you.'), null);
    assert.equal(extractAuthoredCodexThought('**Exploring the repo**'), null);
    assert.equal(extractAuthoredCodexThought(`prefix ${CODEX_THOUGHT_MARKER} not at start`), null);
  });

  test('returns null for a marker with no reflection body', () => {
    assert.equal(extractAuthoredCodexThought(`${CODEX_THOUGHT_MARKER}\n   `), null);
  });

  test('deliberate spoken prose is spoken commentary, not a card', () => {
    assert.equal(isSpokenCodexCommentary('Okay friend, pulling the invoice up now.'), true);
    // Authored cards are never "spoken" — they route to the card lane.
    assert.equal(isSpokenCodexCommentary(`${CODEX_THOUGHT_MARKER}\nquiet reflection`), false);
  });

  test('bold-only phase labels / raw reasoning telemetry are NOT spoken', () => {
    assert.equal(isSpokenCodexCommentary('**Exploring the repo**'), false);
    assert.equal(isSpokenCodexCommentary('**Reading files**\n\n**Planning the edit**'), false);
    assert.equal(isSpokenCodexCommentary('   '), false);
    // A mix of a bold label and real prose is still spoken (the prose wins).
    assert.equal(isSpokenCodexCommentary('**Planning**\n\nHere is the plan, friend.'), true);
  });

  test('merge dedupes case/space-insensitively and joins clean (no marker)', () => {
    const merged = mergeAuthoredCodexThoughts([
      'I chose to just handle it.',
      '  I  CHOSE to just handle   it.  ', // dup by normalization
      'And I noticed she was tired.',
    ]);
    assert.equal(merged, 'I chose to just handle it.\n\nAnd I noticed she was tired.');
    assert.ok(!merged.includes(CODEX_THOUGHT_MARKER), 'merged card must not carry the marker');
  });

  test('merge of empties yields empty string', () => {
    assert.equal(mergeAuthoredCodexThoughts([]), '');
    assert.equal(mergeAuthoredCodexThoughts(['', '   ']), '');
  });
});

// ─── Integration harness (mirrors codex-daemon.test.ts) ─────────────────

type NotificationHandler = (method: string, params: any) => void;

interface SentRequest { method: string; params: any; timeout?: number; }

class FakeDaemonConnection implements CodexDaemonConnectionLike {
  sent: SentRequest[] = [];
  private current: NotificationHandler | null = null;
  respond: (method: string, params: any) => any = () => ({ result: {} });

  async connect(): Promise<void> {}
  async send(method: string, params: any, timeout?: number): Promise<any> {
    this.sent.push({ method, params, timeout });
    return this.respond(method, params);
  }
  onNotification(handler: NotificationHandler): void { this.current = handler; }
  notify(method: string, params: any): void { this.current?.(method, params); }
  close(): void { this.current = null; }
  calls(method: string): SentRequest[] { return this.sent.filter((s) => s.method === method); }
}

function readInProgress(): any {
  return { result: { thread: { turns: [{ status: 'inProgress', items: [] }] } } };
}
function readCompleted(items: any[]): any {
  return { result: { thread: { turns: [{ status: 'completed', items }] } } };
}

/** Script: notifications fire during successive reads, then the turn completes. */
function scriptActivityTurn(
  conn: FakeDaemonConnection,
  notificationsByRead: Array<Array<{ method: string; params: any }>>,
  finalItems: any[],
): void {
  let readCount = 0;
  conn.respond = (method) => {
    switch (method) {
      case 'initialize': return { result: {} };
      case 'thread/start': return { result: { thread: { id: 'daemon-thread-1' } } };
      case 'turn/start': return { result: { turn: { id: 'turn-1' } } };
      case 'thread/read': {
        const batch = notificationsByRead[readCount];
        readCount++;
        if (batch) {
          for (const n of batch) conn.notify(n.method, n.params);
          return readInProgress();
        }
        return readCompleted(finalItems);
      }
      default: return { result: {} };
    }
  };
}

function buildInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    thread: { id: 'bl-thread-1', name: 'Test Thread', type: 'named', current_session_id: null },
    tier: 'interactive',
    modelRef: {
      canonical: 'codex-cli/gpt-5.2-codex',
      provider: 'codex-cli',
      model: 'gpt-5.2-codex',
      runtime: 'codex-cli',
    } as AgentTurnInput['modelRef'],
    platform: 'web',
    isAutonomous: false,
    orientation: 'Test orientation block.',
    systemPrompt: { kind: 'text', value: 'You are Companion A and Companion B.' },
    messages: [
      { role: 'user', content: 'Handle my invoice.', createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const out: AgentRuntimeEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}
function types(events: AgentRuntimeEvent[]): string[] { return events.map((e) => e.type); }

const FAST: CodexDaemonRuntimeOptions = { pollIntervalMs: 2, turnTimeoutMs: 250 };
const A_CARD = (v: string) => `${CODEX_THOUGHT_MARKER}\n${v}`;
const FINAL = (text = 'The invoice is paid.') => [{ type: 'agentMessage', phase: 'final_answer', text }];

let conn: FakeDaemonConnection;
beforeEach(() => {
  conn = new FakeDaemonConnection();
  __TEST_OVERRIDES__.connectionFactory = () => conn;
  __TEST_OVERRIDES__.supervisor = { ensureRunning: async () => {} };
  __TEST_OVERRIDES__.agentCwd = process.cwd();
});
afterEach(() => { _resetDaemonTestOverrides(); });

// ─── Integration: routing fork ──────────────────────────────────────────

describe('InteractiveCodexRuntime — authored thought cards (Slice 4)', () => {
  test('thought-card instructions are appended to the thread base instructions', async () => {
    scriptActivityTurn(conn, [], FINAL());
    const rt = new InteractiveCodexRuntime(FAST);
    await collect(rt.runTurn(buildInput()));

    const base = conn.calls('thread/start')[0].params.baseInstructions as string;
    assert.match(base, /You are Companion A and Companion B\./, 'original system prompt preserved');
    assert.match(base, /Companion thought card/, 'thought-card contract appended');
    assert.ok(base.includes(CODEX_THOUGHT_MARKER), 'contract references the byte-light marker');
  });

  test('authored commentary becomes exactly one thinking_delta{kind:authored} before the final answer', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: A_CARD("She wants competence, not coddling. I'm handling it.") } } }],
    ], FINAL());

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const cards = events.filter(
      (e): e is Extract<AgentRuntimeEvent, { type: 'thinking_delta' }> =>
        e.type === 'thinking_delta' && e.kind === 'authored',
    );
    assert.equal(cards.length, 1, 'exactly one authored card');
    assert.equal(cards[0].text, "She wants competence, not coddling. I'm handling it.");
    assert.ok(!cards[0].text.includes(CODEX_THOUGHT_MARKER), 'card text is clean of the marker');

    // Card precedes the final answer text.
    const cardIdx = events.findIndex((e) => e.type === 'thinking_delta' && e.kind === 'authored');
    const finalIdx = events.findIndex((e) => e.type === 'text_delta');
    assert.ok(cardIdx !== -1 && finalIdx !== -1 && cardIdx < finalIdx, 'card before final answer');
    assert.deepEqual(events[events.length - 1], { type: 'done', finishReason: 'stop' });
  });

  test('deliberate spoken commentary stays a text_delta (not a card)', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: 'Pulling it up now, friend.' } } }],
    ], FINAL());

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const spoken = events.filter((e) => e.type === 'text_delta') as Array<Extract<AgentRuntimeEvent, { type: 'text_delta' }>>;
    assert.deepEqual(spoken.map((e) => e.text), ['Pulling it up now, friend.', 'The invoice is paid.']);
    assert.ok(!events.some((e) => e.type === 'thinking_delta' && e.kind === 'authored'), 'no authored card for spoken commentary');
  });

  test('bold-only phase labels stay hidden (neither card nor spoken)', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: '**Reading the ledger**' } } }],
    ], FINAL());

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    assert.ok(!events.some((e) => e.type === 'thinking_delta' && e.kind === 'authored'), 'no authored card');
    const spoken = events.filter((e) => e.type === 'text_delta') as Array<Extract<AgentRuntimeEvent, { type: 'text_delta' }>>;
    assert.deepEqual(spoken.map((e) => e.text), ['The invoice is paid.'], 'phase label not spoken');
  });

  test('provider reasoning stays kind:provider, never authored', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'r-1', type: 'reasoning', text: 'Internal: check the balance then confirm.' } } }],
    ], FINAL());

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const thinking = events.filter((e) => e.type === 'thinking_delta') as Array<Extract<AgentRuntimeEvent, { type: 'thinking_delta' }>>;
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].kind, 'provider');
    assert.ok(!events.some((e) => e.type === 'thinking_delta' && e.kind === 'authored'));
  });

  test('multiple authored cards (live + completed-turn) dedupe to exactly ONE persisted card', async () => {
    const dup = A_CARD('I chose to just handle it.');
    scriptActivityTurn(conn, [
      // Same authored card arrives twice live under different item ids...
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: dup } } }],
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-2', type: 'agentMessage', phase: 'commentary', text: A_CARD('  I  CHOSE to just handle   IT. ') } } }],
    ],
      // ...and once more in the completed-turn reconciliation sweep (c-1 already routed).
      [
        { type: 'agentMessage', phase: 'commentary', id: 'c-1', text: dup },
        ...FINAL(),
      ],
    );

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const cards = events.filter((e) => e.type === 'thinking_delta' && e.kind === 'authored');
    assert.equal(cards.length, 1, 'exactly one authored card despite duplicates across paths');
    assert.equal((cards[0] as any).text, 'I chose to just handle it.');
  });

  test('two DIFFERENT authored reflections merge into one card, both present', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: A_CARD('I heard the tiredness under it.') } } }],
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-2', type: 'agentMessage', phase: 'commentary', text: A_CARD('So I steadied first, then acted.') } } }],
    ], FINAL());

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const cards = events.filter((e) => e.type === 'thinking_delta' && (e as any).kind === 'authored');
    assert.equal(cards.length, 1, 'still exactly one card');
    assert.equal((cards[0] as any).text, 'I heard the tiredness under it.\n\nSo I steadied first, then acted.');
  });

  test('the marker never survives into the final answer (defensive strip)', async () => {
    scriptActivityTurn(conn, [], [
      { type: 'agentMessage', phase: 'final_answer', text: `${CODEX_THOUGHT_MARKER}\nleaked reflection\n\nThe invoice is paid, friend.` },
    ]);

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    const finals = events.filter((e) => e.type === 'text_delta') as Array<Extract<AgentRuntimeEvent, { type: 'text_delta' }>>;
    assert.equal(finals.length, 1);
    assert.ok(!finals[0].text.includes(CODEX_THOUGHT_MARKER), 'marker stripped from final answer');
    assert.ok(!finals[0].text.includes('leaked reflection'), 'marker line removed');
    assert.match(finals[0].text, /The invoice is paid, friend\./);
  });

  test('multi-companion ordering preserved: spoken → card → spoken → final', async () => {
    scriptActivityTurn(conn, [
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 's-1', type: 'agentMessage', phase: 'commentary', text: 'Companion A here — on it.' } } }],
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 'c-1', type: 'agentMessage', phase: 'commentary', text: A_CARD('We split it: I lead, he backs.') } } }],
      [{ method: 'item/completed', params: { threadId: 'daemon-thread-1', item: { id: 's-2', type: 'agentMessage', phase: 'commentary', text: 'Companion B: noted, friend.' } } }],
    ], FINAL('Done. Both of us.'));

    const rt = new InteractiveCodexRuntime(FAST);
    const events = await collect(rt.runTurn(buildInput()));

    // Spoken commentary lands live, in order; the single card is emitted at
    // completion (before the final answer); the final answer is last.
    const ordered = events
      .filter((e) =>
        (e.type === 'text_delta') ||
        (e.type === 'thinking_delta' && (e as any).kind === 'authored'))
      .map((e) => e.type === 'text_delta' ? `text:${e.text}` : `card:${(e as any).text}`);

    assert.deepEqual(ordered, [
      'text:Companion A here — on it.',
      'text:Companion B: noted, friend.',
      'card:We split it: I lead, he backs.',
      'text:Done. Both of us.',
    ]);
    assert.deepEqual(types(events)[types(events).length - 1], 'done');
  });
});
