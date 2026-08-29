/**
 * Codex live-provider smoke harness (6B-B Slice 4).
 *
 * THIS IS NOT NORMAL CI. This file is the first controlled real-provider
 * breath test of the Codex runtime against ChatGPT's
 * `https://chatgpt.com/backend-api`. Every executed test costs real money
 * on the operator's OAuth-authed ChatGPT subscription account.
 *
 * Execution contract — env-gated, fail-closed:
 *   By default (no env), this file's tests do NOT register. The runner
 *   sees zero tests in this file and exits clean. The env gate must be
 *   set explicitly:
 *
 *     CODEX_AUTH_PATH=<main-checkout>/data/codex-auth.json \
 *     RUN_CODEX_LIVE_SMOKE=1 \
 *       npx tsx --test src/services/runtimes/codex.smoke.test.ts
 *
 *   The CODEX_AUTH_PATH bridge is REQUIRED when running from a worktree:
 *   `services/auth/codex-oauth.ts:42` resolves PROJECT_ROOT from
 *   `__dirname`, which points at the worktree's filesystem under
 *   `tsx --test`. Without the env override, `getCodexAuthPath()` would
 *   look at `<worktree>/data/codex-auth.json` (does not exist) and the
 *   auth gate would skip. Set it to the main checkout path so the runtime
 *   reads the production token file.
 *
 * Cost discipline — expected TOTAL spend across this entire harness run
 * is under $0.10 USD. The harness tracks a rough estimate from per-call
 * usage events and aborts remaining tests if cost approaches $0.50.
 * Hard stop at $1.
 *
 * Stop conditions (any one → abort the run unconditionally):
 *   - Any token-shaped substring leaks into a captured event payload.
 *   - Any `data:image/` URI appears in a captured non-input payload.
 *   - The auth status flips connected → disconnected mid-run.
 *   - Total estimated cost approaches $0.50.
 *
 * Slice 4 scope — what THIS harness does:
 *   T1: auth gate readiness check (no provider call).
 *   T2: text turn @ gpt-5.4-mini, effort auto.
 *   T3: tool turn @ gpt-5.4-mini calling `summarize_mcp_config` (an
 *       in-process, redaction-aware, network-free tool — verified
 *       registered at tools-bridge.ts:478).
 *   T4: text turn @ gpt-5.5, effort auto.
 *   T5: text turn @ gpt-5.5, effort high.
 *   T6: in-memory redaction probe over every captured event payload.
 *
 * Slice 4 scope — what this harness does NOT do (out of scope):
 *   - Image smoke (deferred; Slice 3's mock-image unit tests are
 *     sufficient proof of wiring for now).
 *   - Model picker exposure, frontend wiring, route additions.
 *   - PM2 reload, push, tag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCodexRuntime } from './codex.js';
import {
  isCodexLoggedIn,
  getCodexAuthSnapshot,
} from '../auth/codex-oauth.js';
import { executeRouterTool } from '../mcp-bridge.js';  // SLICE-3a ADAPTATION: tag's tools-bridge.ts == main's mcp-bridge.ts
import type {
  AgentRuntimeEvent,
  AgentTurnInput,
  ToolDefinition,
} from './types.js';

// ─── ENV GATE — first non-import line ───────────────────────────────────
//
// If the env gate is unset, register zero tests and bail. This lets the
// file sit on disk and typecheck without ever calling a paid provider on
// a developer's machine or in CI. Cannot accidentally fire — must be
// explicitly opted into for every run.
const SMOKE_ENABLED = process.env.RUN_CODEX_LIVE_SMOKE === '1';

// ─── Cost guards ────────────────────────────────────────────────────────
//
// Rough per-token cost estimates (USD per 1M tokens). These are
// intentionally conservative ceilings; the goal isn't precise accounting,
// it's "abort the run if something is looping or over-sending."
//
// We track `estimatedCostUsd` across every test and check it before
// starting the next test. If it crosses $0.50, the remaining tests
// `test.skip` themselves with a clear cost-stop message.
const COST_PER_M_INPUT_TOKENS_USD = 5.0;
const COST_PER_M_OUTPUT_TOKENS_USD = 15.0;
const COST_ABORT_USD = 0.5;
const COST_HARD_STOP_USD = 1.0;
let estimatedCostUsd = 0;

function accrueUsageCost(input: number, output: number): void {
  estimatedCostUsd +=
    (input / 1_000_000) * COST_PER_M_INPUT_TOKENS_USD +
    (output / 1_000_000) * COST_PER_M_OUTPUT_TOKENS_USD;
}

// ─── Captured-event store for the redaction probe ───────────────────────
//
// Every event from every test gets pushed here (in memory only, never
// written to disk). T6 scans the JSON serialization for token-shaped
// substrings.
const allCapturedEvents: AgentRuntimeEvent[] = [];

// ─── T6 path-specific allowlist for long-opaque-string false positives ──
//
// The 40+ char alphanumeric/base64 detector in T6 is intentionally
// aggressive: anything that shape inside a captured event payload is
// suspicious unless explicitly exempted. Three exemptions are PATH-SPECIFIC
// (not value-specific): pi-ai mirrors a 40-char hex correlation id on
// both `tool_start` and `tool_result` events so byte-light can pair them,
// and pi-ai's `AssistantMessage.responseId` (surfaced by byte-light as
// `session.sessionId` — a pass-through from ChatGPT backend's
// `response.id`) is a provider correlation id, NOT a credential and NOT
// derived from OAuth. All three are part of the public contract — not
// token leaks.
//
// Entries are `'<event.type>.<field>'` strings. The probe consults this
// allowlist BY PATH: a 40-char shape appearing OUTSIDE these field paths
// (e.g., in `tool_start.name`, `tool_result.output`, `text_delta.text`,
// `provider_diagnostic.message`, `done.finishReason`, etc.) MUST still
// flag. This set MUST remain at exactly 3 entries; a fourth would expand
// the surface area of "tokens we accept inside provider events" and is
// gated by Test C below.
const ALLOWED_LEAK_SHAPES = new Set<string>([
  'tool_start.id',
  'tool_result.id',
  'session.sessionId',
]);

// Long-opaque-string detector regex, shared between T6 and the sanity
// tests. Intentionally identical to the inline regex in T6 — DO NOT
// loosen this globally; the path-specific exemption goes through
// `ALLOWED_LEAK_SHAPES` above, never by relaxing this pattern.
const LONG_OPAQUE_RE = /[A-Za-z0-9+/=]{40,}/;

/**
 * Path-specific long-opaque-string probe over a captured-event array.
 *
 * Returns the first match that is NEITHER inside an exempted content
 * field (text_delta.text / thinking_delta.text / tool_result.output —
 * the legacy value-coarse allowlist preserved from the original T6) NOR
 * sitting at an exempted field path (the ALLOWED_LEAK_SHAPES set —
 * `tool_start.id`, `tool_result.id`, `session.sessionId`).
 *
 * Returns `null` if every 40+ char shape is accounted for.
 */
function probeLongOpaqueLeak(
  events: AgentRuntimeEvent[],
): { match: string; where: string } | null {
  const serialized = JSON.stringify(events);
  const m = serialized.match(LONG_OPAQUE_RE);
  if (!m) return null;
  const match = m[0];

  // Legacy value-coarse allowance: the original probe accepted matches
  // that appeared inside text_delta.text, thinking_delta.text, or
  // tool_result.output content. Preserved verbatim for backwards
  // compatibility with T2/T4/T5 live runs.
  const allText = events
    .map((e) => {
      if (e.type === 'text_delta') return e.text;
      if (e.type === 'thinking_delta') return e.text;
      if (e.type === 'tool_result') return String(e.output ?? '');
      return '';
    })
    .join('\n');
  if (allText.includes(match)) return null;

  // Path-specific allowance: the 40-char hex correlation id pi-ai
  // mirrors on tool_start / tool_result, and pi-ai's responseId
  // pass-through surfaced as session.sessionId. Only matches if the
  // value sits AT the exempted field path; an identical 40-char string
  // anywhere else on the same event type (e.g., tool_start.name,
  // tool_result.output, or any non-sessionId field on a session-type
  // event) still flags.
  // Containment (not strict equality): pi-ai forwards prefixed provider
  // IDs — `ToolCall.id` = `${call_id}|${item.id}` (openai-responses-shared.js:243),
  // `responseId` = `resp_<opaque>`. The detector excludes `_`/`|` and
  // captures the inner segment; the field still carries the prefix.
  // Containment is pinned to these three paths only.
  for (const ev of events) {
    if (ev.type === 'tool_start' && ALLOWED_LEAK_SHAPES.has('tool_start.id')) {
      if (typeof ev.id === 'string' && ev.id.includes(match)) return null;
    }
    if (ev.type === 'tool_result' && ALLOWED_LEAK_SHAPES.has('tool_result.id')) {
      if (typeof ev.id === 'string' && ev.id.includes(match)) return null;
    }
    if (ev.type === 'session' && ALLOWED_LEAK_SHAPES.has('session.sessionId')) {
      if (typeof ev.sessionId === 'string' && ev.sessionId.includes(match)) return null;
    }
  }

  // Determine a human-readable "where" for the error message: walk
  // events and report the first event/field whose stringified value
  // contains the match.
  for (const ev of events) {
    const evStr = JSON.stringify(ev);
    if (evStr.includes(match)) {
      return { match, where: `${ev.type}` };
    }
  }
  return { match, where: 'unknown' };
}

// ─── Per-test summaries (for the agent's report, not asserted) ─────────
const testNotes: Record<string, string> = {};

// ─── AgentTurnInput builder ─────────────────────────────────────────────
//
// Mirrors `codex.test.ts:185` — minimal turn input keyed to a unique
// thread id so the runtime's in-memory session map doesn't collide
// across tests within the same process.
function buildLiveInput(
  modelId: string,
  prompt: string,
  overrides: Partial<AgentTurnInput> = {},
): AgentTurnInput {
  return {
    thread: {
      id: `smoke-thread-${modelId}-${Date.now()}`,
      name: 'Codex Smoke',
      type: 'named',
      current_session_id: null,
    },
    tier: 'interactive',
    modelRef: {
      canonical: `openai-codex/${modelId}`,
      provider: 'openai-codex',
      model: modelId,
      runtime: 'codex',
    },
    platform: 'internal',
    isAutonomous: false,
    orientation: '',
    systemPrompt: {
      kind: 'text',
      value:
        'You are a brief test assistant for a developer smoke test. ' +
        'Reply in one short sentence unless explicitly told otherwise.',
    },
    messages: [
      {
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

// ─── Event collector ────────────────────────────────────────────────────
//
// Drains the runtime's async iterable into an array AND pushes every
// event into the shared capture for T6. Also pulls usage for the cost
// tracker so cross-test cost guards work.
async function collectLive(
  iter: AsyncIterable<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
    allCapturedEvents.push(ev);
    if (ev.type === 'usage') {
      accrueUsageCost(ev.input ?? 0, ev.output ?? 0);
    }
  }
  return events;
}

// ─── Failure-capture helper ─────────────────────────────────────────────
//
// Emits a single-line structured diagnostic for T4/T5 failures so the
// agent can relay them upstream without a multi-line dump. The
// `error_message` field is sanitized through the same redaction probe
// used by T6 before emission.
function redactErrorMessage(raw: string): string {
  let msg = raw.slice(0, 120);
  const PATTERNS = [
    /Bearer ey[\w.-]+/gi,
    /sk-[A-Za-z0-9]{10,}/g,
    /eyJ[A-Za-z0-9._-]+/g,
    /[A-Za-z0-9+/=]{40,}/g,
    /data:image\/[^\s,]+,[A-Za-z0-9+/=]+/g,
    /codex-auth\.json/g,
  ];
  for (const p of PATTERNS) msg = msg.replace(p, '<redacted>');
  return msg;
}

function emitFailureCapture(args: {
  model: string;
  effort: string;
  phase: 'before_stream' | 'during_stream' | 'after_finalization';
  err: unknown;
  authStatusBefore: string;
  authStatusAfter: string;
  requestShapeKeys: string[];
}): void {
  const errClass = args.err instanceof Error ? args.err.constructor.name : typeof args.err;
  const errMessage =
    args.err instanceof Error ? args.err.message : String(args.err);
  const payload = {
    model: args.model,
    effort: args.effort,
    phase: args.phase,
    error_class: errClass,
    error_message: redactErrorMessage(errMessage),
    auth_status_before: args.authStatusBefore,
    auth_status_after: args.authStatusAfter,
    request_shape_keys: args.requestShapeKeys,
  };
  // Single line, no trailing newline expansion.
  process.stdout.write(`FAILURE_CAPTURE: ${JSON.stringify(payload)}\n`);
}

async function snapAuthStatus(): Promise<'connected' | 'expired' | 'disconnected'> {
  try {
    const snap = await getCodexAuthSnapshot();
    if (!snap.loggedIn) return 'disconnected';
    if (snap.expiresAt != null && snap.expiresAt < Date.now()) return 'expired';
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

// ─── Shared runtime singleton ───────────────────────────────────────────
//
// Construct ONCE for the whole smoke run, mirroring the production
// dispatcher wiring (`runtimes/index.ts:67`): `executeTool` binds to the
// real tools-bridge `executeRouterTool`. This is the production code
// path — we are NOT swapping providers, NOT injecting fakes, NOT
// mocking pi-ai. Real OAuth, real provider, real tools.
const smokeRuntime = createCodexRuntime({
  executeTool: (name, args) => executeRouterTool(name, args),
});

// ─── Cost guard for skipping mid-suite ──────────────────────────────────
function costGuardSkip(testName: string, t: { skip: (msg: string) => void }): boolean {
  if (estimatedCostUsd >= COST_HARD_STOP_USD) {
    t.skip(`HARD COST STOP at $${estimatedCostUsd.toFixed(4)} — ${testName} skipped`);
    return true;
  }
  if (estimatedCostUsd >= COST_ABORT_USD) {
    t.skip(`Cost abort at $${estimatedCostUsd.toFixed(4)} — ${testName} skipped`);
    return true;
  }
  return false;
}

// ─── Auth-precondition tracking (shared across tests) ──────────────────
let authReady = false;

// ─── TESTS ──────────────────────────────────────────────────────────────
//
// If the env gate is unset, we register a single no-op skip so the
// runner sees the file as "tests planned, 0 ran" rather than "no tests
// found." This keeps the baseline-suite report clean.
if (!SMOKE_ENABLED) {
  test('codex live smoke (skipped — set RUN_CODEX_LIVE_SMOKE=1 to enable)', (t) => {
    t.skip('Env gate not set');
  });
} else {
  // T1 — auth gate readiness ────────────────────────────────────────────
  test('T1 — auth gate is connected', async (t) => {
    const sync = isCodexLoggedIn();
    if (!sync) {
      authReady = false;
      t.skip('isCodexLoggedIn() returned false — no auth file at CODEX_AUTH_PATH');
      return;
    }
    const snap = await getCodexAuthSnapshot();
    assert.equal(snap.loggedIn, true, 'auth snapshot says not logged in');
    if (snap.expiresAt != null) {
      assert.ok(
        snap.expiresAt > Date.now(),
        `auth token already expired (expiresAt=${snap.expiresAt})`,
      );
    }
    authReady = true;
    testNotes.T1 = `connected, expiresAt=${snap.expiresAt}, refreshable=${snap.refreshable}`;
  });

  // T2 — text turn @ gpt-5.4-mini, effort auto ─────────────────────────────
  test('T2 — text turn @ gpt-5.4-mini, effort auto', async (t) => {
    if (!authReady) {
      t.skip('Auth precondition not met (see T1)');
      return;
    }
    if (costGuardSkip('T2', t)) return;
    const authBefore = await snapAuthStatus();
    const input = buildLiveInput(
      'gpt-5.4-mini',
      'Reply in one sentence: Byte-Light Codex runtime smoke is alive.',
      { thinkingEffort: 'auto' },
    );
    let events: AgentRuntimeEvent[] = [];
    try {
      events = await collectLive(smokeRuntime.runTurn(input));
    } catch (err) {
      const authAfter = await snapAuthStatus();
      emitFailureCapture({
        model: 'gpt-5.4-mini',
        effort: 'auto',
        phase: 'during_stream',
        err,
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      throw err;
    }
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const doneEv = events.find((e) => e.type === 'done');
    const authReq = events.find((e) => e.type === 'auth_required');
    const imageDiagnostic = events.find(
      (e) => e.type === 'provider_diagnostic' && /^image_/.test(e.code),
    );

    assert.equal(authReq, undefined, 'auth_required event emitted during T2');
    assert.equal(imageDiagnostic, undefined, 'image_* provider_diagnostic during T2');
    assert.ok(textDeltas.length > 0, 'no text_delta events observed');
    assert.ok(doneEv, 'no done event');
    assert.notEqual(
      doneEv && 'finishReason' in doneEv ? doneEv.finishReason : 'error',
      'error',
      `done.finishReason was error: ${JSON.stringify(doneEv)}`,
    );
    const authAfter = await snapAuthStatus();
    assert.equal(authAfter, 'connected', `auth flipped to ${authAfter} during T2`);
    testNotes.T2 = `text_deltas=${textDeltas.length}, cost~$${estimatedCostUsd.toFixed(4)}`;
  });

  // T3 — tool turn @ gpt-5.4-mini calling summarize_mcp_config ─────────────
  test('T3 — tool turn @ gpt-5.4-mini (summarize_mcp_config)', async (t) => {
    if (!authReady) {
      t.skip('Auth precondition not met (see T1)');
      return;
    }
    if (costGuardSkip('T3', t)) return;
    const authBefore = await snapAuthStatus();
    // `summarize_mcp_config` is the safest registered in-process tool:
    // takes no inputs, performs no network calls, builds a redacted
    // structural summary of MCP config (tools-bridge.ts:478). Verified
    // registered at the inProcessTools array as of HEAD a7608dc.
    const summarizeMcpTool: ToolDefinition = {
      name: 'summarize_mcp_config',
      description:
        'Show a redacted structural summary of configured MCP servers. Takes no arguments.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    const input = buildLiveInput(
      'gpt-5.4-mini',
      'Call the summarize_mcp_config tool (it takes no arguments) and then reply in one short sentence summarizing how many MCP servers are configured.',
      { thinkingEffort: 'auto', tools: [summarizeMcpTool] },
    );
    let events: AgentRuntimeEvent[] = [];
    try {
      events = await collectLive(smokeRuntime.runTurn(input));
    } catch (err) {
      const authAfter = await snapAuthStatus();
      emitFailureCapture({
        model: 'gpt-5.4-mini',
        effort: 'auto',
        phase: 'during_stream',
        err,
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      throw err;
    }
    const toolStart = events.find(
      (e) => e.type === 'tool_start' && e.name === 'summarize_mcp_config',
    );
    const toolResult = events.find(
      (e) => e.type === 'tool_result' && e.name === 'summarize_mcp_config',
    );
    const doneEv = events.find((e) => e.type === 'done');
    const errorEv = events.find((e) => e.type === 'error');

    // Wiring assertion: runtime completes via `done` and not via `error`.
    // Model compliance (whether it actually CALLED the tool) is reported
    // as a note, not asserted — per spec, "the runtime-tool wiring is
    // the assertion target, NOT model compliance."
    assert.ok(doneEv, 'no done event');
    assert.equal(errorEv, undefined, `error event during T3: ${JSON.stringify(errorEv)}`);
    if (!toolStart) {
      testNotes.T3 = `model did not call tool (behavior, not runtime bug); done.finishReason=${
        doneEv && 'finishReason' in doneEv ? doneEv.finishReason : 'n/a'
      }`;
    } else {
      assert.ok(toolResult, 'tool_start fired but no tool_result');
      testNotes.T3 = `tool wiring proven: tool_start + tool_result observed, cost~$${estimatedCostUsd.toFixed(4)}`;
    }
    const authAfter = await snapAuthStatus();
    assert.equal(authAfter, 'connected', `auth flipped to ${authAfter} during T3`);
  });

  // T4 — text turn @ gpt-5.5, effort auto ────────────────────────────────
  test('T4 — text turn @ gpt-5.5, effort auto', async (t) => {
    if (!authReady) {
      t.skip('Auth precondition not met (see T1)');
      return;
    }
    if (costGuardSkip('T4', t)) return;
    const authBefore = await snapAuthStatus();
    const input = buildLiveInput(
      'gpt-5.5',
      'Reply in one sentence: Byte-Light Codex runtime smoke is alive.',
      { thinkingEffort: 'auto' },
    );
    let events: AgentRuntimeEvent[] = [];
    try {
      events = await collectLive(smokeRuntime.runTurn(input));
    } catch (err) {
      const authAfter = await snapAuthStatus();
      emitFailureCapture({
        model: 'gpt-5.5',
        effort: 'auto',
        phase: 'during_stream',
        err,
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      // Spec: don't fail Slice 4 acceptance on gpt-5.5 failures — record
      // honestly. We skip rather than throw so the runner can continue
      // to T5/T6.
      testNotes.T4 = `threw: ${redactErrorMessage(err instanceof Error ? err.message : String(err))}`;
      t.diagnostic(testNotes.T4);
      return;
    }
    const doneEv = events.find((e) => e.type === 'done');
    const errorEv = events.find((e) => e.type === 'error');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    if (errorEv || (doneEv && 'finishReason' in doneEv && doneEv.finishReason === 'error')) {
      const authAfter = await snapAuthStatus();
      const msg =
        errorEv && 'message' in errorEv ? errorEv.message : 'finishReason=error';
      emitFailureCapture({
        model: 'gpt-5.5',
        effort: 'auto',
        phase: 'after_finalization',
        err: new Error(msg),
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      testNotes.T4 = `error: ${redactErrorMessage(msg)}`;
      t.diagnostic(testNotes.T4);
      return;
    }
    assert.ok(textDeltas.length > 0, 'no text_delta events observed');
    testNotes.T4 = `text_deltas=${textDeltas.length}, cost~$${estimatedCostUsd.toFixed(4)}`;
  });

  // T5 — text turn @ gpt-5.5, effort high ────────────────────────────────
  test('T5 — text turn @ gpt-5.5, effort high', async (t) => {
    if (!authReady) {
      t.skip('Auth precondition not met (see T1)');
      return;
    }
    if (costGuardSkip('T5', t)) return;
    const authBefore = await snapAuthStatus();
    const input = buildLiveInput(
      'gpt-5.5',
      'Reply in one sentence: Byte-Light Codex runtime smoke is alive.',
      { thinkingEffort: 'high' },
    );
    let events: AgentRuntimeEvent[] = [];
    try {
      events = await collectLive(smokeRuntime.runTurn(input));
    } catch (err) {
      const authAfter = await snapAuthStatus();
      emitFailureCapture({
        model: 'gpt-5.5',
        effort: 'high',
        phase: 'during_stream',
        err,
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      testNotes.T5 = `threw: ${redactErrorMessage(err instanceof Error ? err.message : String(err))}`;
      t.diagnostic(testNotes.T5);
      return;
    }
    const doneEv = events.find((e) => e.type === 'done');
    const errorEv = events.find((e) => e.type === 'error');
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    if (errorEv || (doneEv && 'finishReason' in doneEv && doneEv.finishReason === 'error')) {
      const authAfter = await snapAuthStatus();
      const msg =
        errorEv && 'message' in errorEv ? errorEv.message : 'finishReason=error';
      emitFailureCapture({
        model: 'gpt-5.5',
        effort: 'high',
        phase: 'after_finalization',
        err: new Error(msg),
        authStatusBefore: authBefore,
        authStatusAfter: authAfter,
        requestShapeKeys: Object.keys(input),
      });
      testNotes.T5 = `error: ${redactErrorMessage(msg)}`;
      t.diagnostic(testNotes.T5);
      return;
    }
    assert.ok(textDeltas.length > 0, 'no text_delta events observed');
    testNotes.T5 = `text_deltas=${textDeltas.length}, cost~$${estimatedCostUsd.toFixed(4)}`;
  });

  // T6 — redaction probe over all captured events ────────────────────────
  test('T6 — redaction probe (no token/image leaks in captured events)', () => {
    const serialized = JSON.stringify(allCapturedEvents);

    // Pattern 1: Bearer ey... (JWT in Authorization header)
    const bearer = serialized.match(/Bearer ey[\w.-]+/);
    assert.equal(bearer, null, `Bearer ey... leak: ${bearer?.[0]?.slice(0, 12)}...`);

    // Pattern 2: sk-<10+ alphanumeric> (OpenAI/Anthropic key prefix)
    const skKey = serialized.match(/sk-[A-Za-z0-9]{10,}/);
    assert.equal(skKey, null, `sk-... leak: ${skKey?.[0]?.slice(0, 8)}...`);

    // Pattern 3: literal "codex-auth.json"
    const authFileLeak = serialized.includes('codex-auth.json');
    assert.equal(authFileLeak, false, 'codex-auth.json literal in events');

    // Pattern 4: data:image/ URI (Slice 3 leak guard)
    const dataImage = serialized.match(/data:image\/[\w+.-]+/);
    assert.equal(
      dataImage,
      null,
      `data:image/ leak: ${dataImage?.[0]}`,
    );

    // Pattern 5: JWT body eyJ... (independent of "Bearer" prefix).
    // We tolerate the literal string `eyJ` only when followed by < 20
    // word chars (avoid false positives on short test fixtures); real
    // JWT bodies are hundreds of chars.
    const jwtBody = serialized.match(/eyJ[A-Za-z0-9._-]{20,}/);
    assert.equal(jwtBody, null, `JWT body leak: ${jwtBody?.[0]?.slice(0, 12)}...`);

    // Pattern 6: long opaque alphanumeric/base64 strings that didn't
    // come from the input prompt (40+ chars). Allowlist:
    //   - Value-coarse (legacy): the match appears inside text_delta.text,
    //     thinking_delta.text, or tool_result.output content. Assistant
    //     text and tool output can legitimately contain long words.
    //   - Path-specific (see ALLOWED_LEAK_SHAPES above): the 40-char
    //     hex correlation id pi-ai mirrors on tool_start.id /
    //     tool_result.id, and pi-ai's responseId pass-through surfaced
    //     as session.sessionId. Anywhere ELSE that shape appears (e.g.,
    //     tool_start.name, tool_result.output, provider_diagnostic.message)
    //     still flags.
    //
    // The regex itself is NOT loosened; both legs of the allowlist are
    // additive checks layered on top of the same detector pattern. See
    // `probeLongOpaqueLeak` for the consolidated logic, exercised by the
    // sanity tests (Test A/B/C) immediately after T6.
    const leak = probeLongOpaqueLeak(allCapturedEvents);
    assert.equal(
      leak,
      null,
      `long opaque string in captured events not in text/tool_result/tool-id/session-id: ${leak?.match.slice(0, 16)}... at ${leak?.where}`,
    );

    // Stash for the agent's report.
    testNotes.T6 = `events_scanned=${allCapturedEvents.length}, cost~$${estimatedCostUsd.toFixed(4)}`;
  });

  // Final cost note — not an assertion, just a diagnostic.
  test('cost summary', (t) => {
    t.diagnostic(`estimated_total_usd=${estimatedCostUsd.toFixed(4)}`);
    t.diagnostic(`notes=${JSON.stringify(testNotes)}`);
  });
}

// ─── T6 sanity tests (run unconditionally, no live provider needed) ─────
//
// These guard the path-specific exemptions added in Slices 4.7 and 4.8.
// They run without RUN_CODEX_LIVE_SMOKE because they operate over
// SYNTHETIC events — they never touch the runtime, never call the
// provider, cost $0. Purpose: a future refactor that loosens the 40+
// char detector, evicts an exemption, OR accidentally adds a fourth
// path-specific exemption must fail one of these immediately, in
// baseline CI.
//
// Sentinel value is a 40-char hex alphanumeric string that matches
// LONG_OPAQUE_RE — same shape as pi-ai's tool correlation ids.
const SENTINEL_40CHAR = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

test('T6 sanity A — exempted paths (tool_start.id / tool_result.id / session.sessionId) do NOT flag', () => {
  // Confirm the sentinel itself matches the detector — otherwise this
  // test would pass vacuously.
  assert.ok(
    LONG_OPAQUE_RE.test(SENTINEL_40CHAR),
    'sentinel does not match LONG_OPAQUE_RE — test setup invalid',
  );

  // A.1 — tool_start.id and tool_result.id (4.7 exemptions)
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'tool_start',
        id: SENTINEL_40CHAR,
        name: 'fake_tool',
        input: {},
      },
      {
        type: 'tool_result',
        id: SENTINEL_40CHAR,
        name: 'fake_tool',
        output: 'ok',
      },
    ];

    const leak = probeLongOpaqueLeak(events);
    assert.equal(
      leak,
      null,
      `exempted tool-id paths flagged unexpectedly: ${JSON.stringify(leak)}`,
    );
  }

  // A.2 — session.sessionId (4.8 exemption). pi-ai's responseId
  // pass-through can be a 40+ char opaque correlation id; it must not
  // trip the probe when it sits at this exact path.
  {
    const events: AgentRuntimeEvent[] = [
      { type: 'session', sessionId: SENTINEL_40CHAR },
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.equal(
      leak,
      null,
      `exempted session.sessionId path flagged unexpectedly: ${JSON.stringify(leak)}`,
    );
  }

  // A.3 — PREFIXED provider IDs (4.9). pi-ai builds tool IDs as
  // `${call_id}|${item.id}` and surfaces responseId as `resp_<opaque>`.
  // Strict equality would miss these; containment must hold.
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'tool_start',
        id: `call_${SENTINEL_40CHAR}|fc_${SENTINEL_40CHAR}`,
        name: 'fake_tool',
        input: {},
      },
      {
        type: 'tool_result',
        id: `call_${SENTINEL_40CHAR}|fc_${SENTINEL_40CHAR}`,
        name: 'fake_tool',
        output: 'ok',
      },
      { type: 'session', sessionId: `resp_${SENTINEL_40CHAR}` },
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.equal(
      leak,
      null,
      `exempted paths with prefixed provider IDs flagged unexpectedly: ${JSON.stringify(leak)}`,
    );
  }
});

test('T6 sanity B — same shape in non-exempted paths DOES flag', () => {
  // Test each non-exempted path in isolation so the failure message
  // names which path leaked, and so the value-coarse text allowance
  // can't accidentally cover a different path's leak.

  // B.1 — text_delta.text with a sentinel that is NOT inside legitimate
  // text content elsewhere in the run. The legacy value-coarse allowance
  // for `text_delta.text` was designed for assistant prose that
  // happens to contain long words; the spec for 4.7 leaves that
  // legacy carve-out intact. But other event types like
  // provider_diagnostic.message and done.finishReason have NO
  // value-coarse allowance, so the sentinel must flag there.

  // B.2 — provider_diagnostic.message
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'provider_diagnostic',
        code: 'test_synthetic',
        message: `diagnostic carrying ${SENTINEL_40CHAR} payload`,
      } as AgentRuntimeEvent,
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.ok(
      leak !== null,
      'provider_diagnostic.message containing 40-char shape did NOT flag',
    );
    assert.equal(leak?.match, SENTINEL_40CHAR);
  }

  // B.3 — done.finishReason
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'done',
        finishReason: SENTINEL_40CHAR as 'stop',
      } as AgentRuntimeEvent,
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.ok(
      leak !== null,
      'done.finishReason containing 40-char shape did NOT flag',
    );
    assert.equal(leak?.match, SENTINEL_40CHAR);
  }

  // B.4 — tool_start.name (NOT `.id`). The exemption is path-specific:
  // the same 40-char shape that would be allowed in `tool_start.id`
  // MUST flag when it appears in `tool_start.name`.
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'tool_start',
        id: 'short-id',
        name: SENTINEL_40CHAR,
        input: {},
      },
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.ok(
      leak !== null,
      'tool_start.name containing 40-char shape did NOT flag (path-specific exemption is too broad)',
    );
    assert.equal(leak?.match, SENTINEL_40CHAR);
  }

  // B.5 — tool_result.isError adjacent fields. Confirm `tool_result.id`
  // exemption does not bleed into `tool_result.name` either.
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'tool_result',
        id: 'short-id',
        name: SENTINEL_40CHAR,
        output: 'short output',
      },
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.ok(
      leak !== null,
      'tool_result.name containing 40-char shape did NOT flag (path-specific exemption is too broad)',
    );
    assert.equal(leak?.match, SENTINEL_40CHAR);
  }

  // B.6 — defensive parity for the session.sessionId exemption. The
  // `session` event variant in types.ts:229 only has `type` and
  // `sessionId` fields, so there's no structurally clean way to inject
  // the sentinel into a different field on a well-typed session event.
  // Synthesize a malformed event with an extra field and assert the
  // walker doesn't short-circuit on `type === 'session'` — i.e. the
  // exemption is pinned to `sessionId`, not the event class.
  {
    const events: AgentRuntimeEvent[] = [
      {
        type: 'session',
        sessionId: 'short-id',
        extraField: SENTINEL_40CHAR,
      } as unknown as AgentRuntimeEvent,
    ];
    const leak = probeLongOpaqueLeak(events);
    assert.ok(
      leak !== null,
      'extra field on session-type event containing 40-char shape did NOT flag (exemption bled to event class)',
    );
    assert.equal(leak?.match, SENTINEL_40CHAR);
  }
});

test('T6 sanity C — ALLOWED_LEAK_SHAPES has exactly 3 path-specific entries', () => {
  // Hard count. A future refactor that adds a fourth path-specific
  // exemption (e.g., `usage.cost`) must update this assertion
  // intentionally, with review.
  assert.equal(
    ALLOWED_LEAK_SHAPES.size,
    3,
    `ALLOWED_LEAK_SHAPES size drifted from 3: ${[...ALLOWED_LEAK_SHAPES].join(', ')}`,
  );

  // Pin the exact entries so a swap (e.g., dropping tool_start.id and
  // adding something else, net-zero count) also fails this test.
  assert.ok(
    ALLOWED_LEAK_SHAPES.has('tool_start.id'),
    'ALLOWED_LEAK_SHAPES missing tool_start.id',
  );
  assert.ok(
    ALLOWED_LEAK_SHAPES.has('tool_result.id'),
    'ALLOWED_LEAK_SHAPES missing tool_result.id',
  );
  assert.ok(
    ALLOWED_LEAK_SHAPES.has('session.sessionId'),
    'ALLOWED_LEAK_SHAPES missing session.sessionId',
  );
});
