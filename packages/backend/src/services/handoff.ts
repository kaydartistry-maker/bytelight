/**
 * ProviderHandoff — cross-provider conversation continuity (Step 5A).
 *
 * When a turn lands on a (thread, runtime, provider, model_ref) combo
 * with no sidecar row AND the thread has prior assistant messages, the
 * handoff packet bridges the gap: a short summary of the conversation
 * so far + the last N raw exchanges. Step 5A BUILDS the packet and
 * LOGS the decision but does NOT attach it to dispatch — Step 5B is the
 * clean "attach it" branch.
 *
 * Two summary sources, in order of preference:
 *
 *  1. **memory-tier** — runs the injected `summarize` callback (wired
 *     to `runOneShotQuery` at the call site in agent.ts) with the
 *     configured memory-tier model. Pure Claude SDK call; no MCP,
 *     no tools, no session resume. Caller wraps the summarizer so any
 *     SDK throw turns into an empty string return — the contract is
 *     "never throws."
 *  2. **extractive-fallback** — assembles the summary from the first
 *     sentence of each early user turn and the first sentence of each
 *     late assistant turn. No model call. Triggered when the
 *     memory-tier returns empty / blank.
 *
 * **Divergences from reference implementation Fork `services/handoff.ts`** (cherry-pick
 * protocol — document the deltas BEFORE behavior changes):
 *
 *  - `recentMessages` is provided BY THE CALLER (`agent.ts` already has
 *    `bridgePrior` in hand from the bridge decision; passing it in
 *    avoids a second `getMessages` round-trip and keeps this module
 *    pure / non-DB-bound). reference implementation version called `getMessages`
 *    internally.
 *  - Return shape is `{ handoff, diagnostics }` (always populated, no
 *    null) instead of `ProviderHandoff | null`. The "no prior assistant"
 *    skip is the caller's responsibility in Step 5A's brief (the
 *    bridge-decision path that calls us has already filtered for
 *    `bridgePrior !== null`). Builder still applies defensively if
 *    given a thread with no companion messages — extractive fallback
 *    will produce a degenerate but valid string.
 *  - `SummarizeFn` includes `maxTurns?` and `signal?` to match
 *    byte-light's `runOneShotQuery` shape (reference implementation `SummarizeFn` only
 *    has `prompt | model | systemPrompt`). The injected wrapper passes
 *    through both additively.
 *
 * **What's preserved verbatim from reference implementation Fork:**
 *  - Char→token ratio of 4:1 for budget approximation
 *  - 32-char per-message overhead
 *  - Truncation suffix + tail-preserving truncation algorithm
 *  - Two-pass budget enforcement (summary clamp + total-cap end-to-end)
 *  - Extractive cascade (first 2 user turns + last 2 assistant turns,
 *    first-sentence-each)
 *  - `renderProviderHandoffAsPrompt` shape, including the
 *    "Do not acknowledge this context note" instruction
 */

import type { Message, Thread } from '@bytelight/shared';
import type { ProviderHandoff, NormalizedMessage } from './runtimes/types.js';

/**
 * Summarizer function injected by the caller. AgentService passes
 * `runOneShotQuery` here at the call site — dependency-injected so
 * this module doesn't import `agent.ts` directly (avoids a circular
 * import: agent.ts → handoff.ts → agent.ts) and so tests can pass a
 * mock summarizer without needing the full SDK plumbing.
 *
 * Contract: returns the summary text (may be empty on failure;
 * empty triggers the extractive fallback inside `generateSummary`).
 * The function is expected to NEVER THROW — failures should surface
 * as empty strings. The wrap is done at the call site, not here.
 */
export type SummarizeFn = (opts: {
  prompt: string;
  model: string;
  systemPrompt: string;
  maxTurns?: number;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * Token budget for a handoff packet. Defaults match reference implementation Fork spec
 * D5 — 400 tokens of summary + 1600 tokens of recent messages = 2000
 * total. Rough char→token ratio of 4:1 is used for budgeting
 * (deliberately loose; the goal is bounding cost, not exact token
 * accounting).
 */
export interface HandoffBudget {
  summaryTokens: number;
  recentTokens: number;
  totalCap: number;
}

export const DEFAULT_HANDOFF_BUDGET: HandoffBudget = {
  summaryTokens: 400,
  recentTokens: 1600,
  totalCap: 2000,
};

/** Chars per token, rough — used for budget enforcement only. */
const CHARS_PER_TOKEN = 4;

/** Per-message overhead approximation: role label + separators + JSON quoting. */
const PER_MESSAGE_OVERHEAD_CHARS = 32;

/** Suffix appended to a message whose content was truncated to fit the
 *  recent-message budget. Obvious + searchable so a reader who sees a
 *  weird mid-sentence cutoff knows to look here for the cause. */
const TRUNCATION_SUFFIX = ' [...truncated for handoff budget]';

// ---------------------------------------------------------------------------
// Public input/output shapes
// ---------------------------------------------------------------------------

export interface BuildProviderHandoffInput {
  thread: Thread;
  targetRuntime: string;
  targetProvider: string;
  targetModelRef: string;
  fromModelRef?: string;
  memoryTierModel: string;
  summarize: SummarizeFn;
  identityCompanionName: string;
  identityUserName: string;
  /** Prior conversation messages, chronological order, caller-provided.
   *  byte-light's `bridgePrior` (Message[] from getMessages) is the
   *  expected source. The builder filters internally to text-typed
   *  user/companion roles and normalizes to NormalizedMessage. */
  recentMessages: Message[];
  /** Optional abort signal — forwarded to the summarizer so a hung
   *  memory-tier call can be cancelled by the caller (e.g. when the
   *  primary turn finishes first). */
  signal?: AbortSignal;
  /** Optional budget override. Defaults to `DEFAULT_HANDOFF_BUDGET`. */
  budget?: HandoffBudget;
}

export interface BuildProviderHandoffResult {
  handoff: ProviderHandoff;
  diagnostics: {
    messageCount: number;
    summaryChars: number;
    recentChars: number;
    approxTokens: number;
    summarySource: 'memory-tier' | 'extractive-fallback';
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a handoff packet for the destination combo. Always returns a
 * `BuildProviderHandoffResult`; caller decides whether to attach it.
 *
 * **Caller responsibilities** — `_processQuery` in agent.ts should
 * skip the build call entirely when:
 *  - The turn is autonomous (no human-perceived continuity break).
 *  - A session was resumed (no actual provider switch happened).
 *  - The thread has no prior conversational messages (nothing to bridge).
 *  - The bridge decision is not `bridge` (resume / pristine paths
 *    don't need a handoff packet).
 *  - The turn is `/clear` (deliberate fresh start).
 */
export async function buildProviderHandoff(
  input: BuildProviderHandoffInput,
): Promise<BuildProviderHandoffResult> {
  const budget = input.budget ?? DEFAULT_HANDOFF_BUDGET;

  // Filter to conversational, text-only messages and normalize. Map
  // 'companion' → 'assistant' to match NormalizedMessage's
  // OpenAI-conventional union.
  const conversational = input.recentMessages.filter(
    (m) => (m.role === 'user' || m.role === 'companion') && m.content_type === 'text',
  );
  const normalized: NormalizedMessage[] = conversational.map((m) => ({
    role: m.role === 'companion' ? ('assistant' as const) : ('user' as const),
    content: m.content,
    createdAt: m.created_at,
  }));

  // Generate the summary — memory-tier first, extractive-fallback on
  // empty result. The memory-tier call is one-shot and read-only when
  // the caller uses `runOneShotQuery` (plan permission mode, no tools,
  // no session persist) so it cannot mutate state.
  //
  // Summary maxChars is clamped by totalCap (reference implementation Fork PR D Codex
  // catch — without this, a custom budget where `summaryTokens >
  // totalCap` lets the generated summary exceed the full packet cap
  // before recent-message trimming even runs).
  const summaryMaxTokens = Math.min(budget.summaryTokens, budget.totalCap);
  const { summary, summarySource } = await generateSummary({
    messages: normalized,
    summarize: input.summarize,
    memoryTierModel: input.memoryTierModel,
    companionName: input.identityCompanionName,
    userName: input.identityUserName,
    maxChars: summaryMaxTokens * CHARS_PER_TOKEN,
    signal: input.signal,
    thread: input.thread,
    targetRuntime: input.targetRuntime,
    targetProvider: input.targetProvider,
    targetModelRef: input.targetModelRef,
    fromModelRef: input.fromModelRef,
  });

  // Trim the recent-messages list to fit `budget.recentTokens`. Take
  // from the tail (most-recent first), keep adding earlier messages
  // until the char budget is exhausted, then reverse to chronological.
  // If a single newest message is bigger than the entire budget,
  // truncate its tail with an obvious suffix (preserves continuity over
  // blank).
  const recentBudgetChars = budget.recentTokens * CHARS_PER_TOKEN;
  const recentMessages: NormalizedMessage[] = [];
  let recentCharsUsed = 0;
  for (let i = normalized.length - 1; i >= 0; i--) {
    const msg = normalized[i];
    const cost = msg.content.length + PER_MESSAGE_OVERHEAD_CHARS;

    if (recentCharsUsed + cost <= recentBudgetChars) {
      recentMessages.unshift(msg);
      recentCharsUsed += cost;
      continue;
    }

    // Doesn't fit. If we already have at least one message in the
    // window, stop adding older ones (we have a usable tail).
    if (recentMessages.length > 0) break;

    // Otherwise this is the newest message AND it's bigger than the
    // entire recent budget. Truncate its content to fit, preserve the
    // tail, mark with an obvious suffix.
    const availableForContent =
      recentBudgetChars - PER_MESSAGE_OVERHEAD_CHARS - TRUNCATION_SUFFIX.length;
    if (availableForContent > 0) {
      const truncatedContent = msg.content.slice(-availableForContent) + TRUNCATION_SUFFIX;
      recentMessages.unshift({ ...msg, content: truncatedContent });
      recentCharsUsed = truncatedContent.length + PER_MESSAGE_OVERHEAD_CHARS;
    }
    break;
  }

  // Enforce `budget.totalCap` end-to-end. Drop oldest first; truncate
  // the sole remaining message if still oversized.
  const totalCapChars = budget.totalCap * CHARS_PER_TOKEN;
  while (
    recentMessages.length > 1 &&
    summary.length + recentCharsUsed > totalCapChars
  ) {
    const dropped = recentMessages.shift()!;
    recentCharsUsed -= dropped.content.length + PER_MESSAGE_OVERHEAD_CHARS;
  }
  if (
    recentMessages.length === 1 &&
    summary.length + recentCharsUsed > totalCapChars
  ) {
    const newest = recentMessages[0];
    const availableForContent =
      totalCapChars - summary.length - PER_MESSAGE_OVERHEAD_CHARS - TRUNCATION_SUFFIX.length;
    if (availableForContent > 0) {
      const truncatedContent = newest.content.slice(-availableForContent) + TRUNCATION_SUFFIX;
      recentMessages[0] = { ...newest, content: truncatedContent };
      recentCharsUsed = truncatedContent.length + PER_MESSAGE_OVERHEAD_CHARS;
    } else {
      recentMessages.length = 0;
      recentCharsUsed = 0;
    }
  }

  const summaryChars = summary.length;
  const totalCharsApprox = summaryChars + recentCharsUsed;
  const approxTokens = Math.ceil(totalCharsApprox / CHARS_PER_TOKEN);

  const handoff: ProviderHandoff = {
    handoffVersion: 1,
    toRuntime: input.targetRuntime,
    toProvider: input.targetProvider,
    toModelRef: input.targetModelRef,
    fromModelRef: input.fromModelRef,
    threadTitle: input.thread.name,
    summary,
    summarySource,
    recentMessages,
    budget,
    totalTokensApprox: approxTokens,
  };

  return {
    handoff,
    diagnostics: {
      messageCount: recentMessages.length,
      summaryChars,
      recentChars: recentCharsUsed,
      approxTokens,
      summarySource,
    },
  };
}

/**
 * Render a `ProviderHandoff` into the system-context block that Step 5B
 * will prepend to the destination combo's enriched prompt. Format is
 * plain text (any provider can consume it) with explicit section
 * headers so the model can disambiguate handoff context from the
 * actual user message.
 *
 * The "Do not acknowledge this note" instruction matters: without it,
 * many models begin the response with "Picking up where we left
 * off..." which breaks immersion. The model should just continue
 * naturally.
 *
 * Step 5A does NOT call this function from the dispatcher — it's
 * exported so 5B can land as a clean "attach the rendered string"
 * branch without re-architecting.
 */
export function renderProviderHandoffAsPrompt(handoff: ProviderHandoff): string {
  const fromHint = handoff.fromModelRef ? ` from ${handoff.fromModelRef}` : '';

  const messagesBlock =
    handoff.recentMessages.length === 0
      ? ''
      : '\n\nRecent exchanges:\n' +
        handoff.recentMessages
          .map((m) => `${m.role === 'assistant' ? 'Companion' : 'User'}: ${m.content}`)
          .join('\n\n');

  return [
    `[Conversation context — handoff${fromHint} to ${handoff.toModelRef}]`,
    `Thread: ${handoff.threadTitle}`,
    '',
    `Summary so far: ${handoff.summary}`,
    messagesBlock,
    '',
    'Continue the conversation naturally. Do not acknowledge this context note.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal: summary generation cascade
// ---------------------------------------------------------------------------

interface SummaryResult {
  summary: string;
  summarySource: 'memory-tier' | 'extractive-fallback';
}

async function generateSummary(opts: {
  messages: NormalizedMessage[];
  summarize: SummarizeFn;
  memoryTierModel: string;
  companionName: string;
  userName: string;
  maxChars: number;
  signal?: AbortSignal;
  thread: Thread;
  targetRuntime: string;
  targetProvider: string;
  targetModelRef: string;
  fromModelRef?: string;
}): Promise<SummaryResult> {
  // System prompt — exact wording from the Step 5A brief. References
  // identity strings so the summarizer keeps the (companion, user)
  // framing intact across the model swap.
  const systemPrompt =
    `You are ${opts.companionName}'s continuity summarizer for byte-light. ` +
    `Summarize the prior conversation so another model/provider can continue ` +
    `the same thread with ${opts.userName}. Preserve user goals, unresolved ` +
    `requests, emotional context, commitments, names, constraints, and current ` +
    `task state. Do not invent facts. Keep it concise.`;

  // Prompt body — thread identity + target/source + chronological
  // recent messages + concise-output instruction. Per-message content
  // is truncated to 1500 chars to keep the summary-prompt size bounded
  // on threads with very long messages.
  const conversationText = opts.messages
    .map((m) => {
      const speaker = m.role === 'assistant' ? opts.companionName : opts.userName;
      const content =
        m.content.length > 1500 ? m.content.slice(0, 1500) + '...' : m.content;
      return `${speaker}: ${content}`;
    })
    .join('\n\n');

  const fromLine = opts.fromModelRef
    ? `From model: ${opts.fromModelRef}\n`
    : '';
  const prompt =
    `Thread: ${opts.thread.name}\n` +
    `Target: ${opts.targetRuntime}/${opts.targetProvider}/${opts.targetModelRef}\n` +
    fromLine +
    `\n` +
    `Conversation so far (chronological):\n\n` +
    `---\n${conversationText}\n---\n\n` +
    `Produce 2-4 sentences capturing what they discussed, decisions made, ` +
    `and where the conversation currently stands. Output ONLY the summary ` +
    `paragraph. No preamble, no sign-off.`;

  // Call the injected summarizer. By contract it does NOT throw — the
  // call site at agent.ts wraps `runOneShotQuery` so any SDK failure
  // returns an empty string. Empty result triggers the extractive
  // fallback below.
  //
  // maxTurns: 2 is Pre-5's preserved reference implementation default for `runOneShotQuery`
  // (covers the SDK's "produced response + exit check" loop without
  // erroring on Reached maximum number of turns). Mirrored here at the
  // builder call site as a documentation belt — the helper's default is
  // 2 anyway.
  const summaryRaw = await opts.summarize({
    prompt,
    model: opts.memoryTierModel,
    systemPrompt,
    maxTurns: 2,
    signal: opts.signal,
  });
  const trimmed = (summaryRaw ?? '').trim();

  if (trimmed.length > 0) {
    // Truncate to the budget if the model overproduced.
    const bounded =
      trimmed.length > opts.maxChars ? trimmed.slice(0, opts.maxChars - 3) + '...' : trimmed;
    return { summary: bounded, summarySource: 'memory-tier' };
  }

  return {
    summary: extractiveSummary(opts.messages, opts.companionName, opts.userName, opts.maxChars),
    summarySource: 'extractive-fallback',
  };
}

/**
 * Model-free summary: first sentence of each of the first 2 user
 * turns + first sentence of each of the last 2 assistant turns,
 * concatenated. Coarse but deterministic — preserves the "what was
 * the user asking about" + "where did the conversation land" beats
 * without needing an LLM call.
 *
 * Used when the memory-tier callback returns an empty/blank string
 * (most commonly: the user is switching AWAY from Claude precisely
 * because Claude is broken — but byte-light's memory tier currently
 * resolves to Claude, so a Claude outage would break the summary
 * cascade unless we have a model-free fallback).
 */
function extractiveSummary(
  messages: NormalizedMessage[],
  companionName: string,
  userName: string,
  maxChars: number,
): string {
  const users = messages.filter((m) => m.role === 'user');
  const assistants = messages.filter((m) => m.role === 'assistant');

  const earlyUsers = users.slice(0, 2);
  const lateAssistants = assistants.slice(-2);

  const parts: string[] = [];
  for (const m of earlyUsers) {
    parts.push(`${userName}: ${firstSentence(m.content)}`);
  }
  for (const m of lateAssistants) {
    parts.push(`${companionName}: ${firstSentence(m.content)}`);
  }

  const joined = parts.join(' ');
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars - 3) + '...';
}

/** First sentence (up to ~120 chars), with reasonable terminator detection. */
function firstSentence(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  const match = trimmed.match(/^(.+?(?:\.\s|!\s|\?\s|\n))/);
  if (match) {
    const sentence = match[1].trim();
    if (sentence.length <= 120) return sentence;
    return sentence.slice(0, 117) + '...';
  }
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}
