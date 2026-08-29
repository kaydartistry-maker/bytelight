/**
 * Listen-mode judge — given an incoming Discord message and recent channel
 * context, decide whether we should actually respond. Ported from reference implementation
 * (commit 4e27fb4, "Listen mode — see everything, judge each message, silent
 * skip on no"; fallback intent from 01eef26). Credit: reference implementation.
 *
 * Three documented adaptations from the source (per cherry-pick / port protocol):
 *
 *   1. SINGLE ENGINE. reference implementation runs the judge on the thread's own engine
 *      family (DeepSeek thread → DeepSeek judge, Codex thread → Codex judge).
 *      Here we drop the per-engine dispatch and the DeepSeek path entirely:
 *      the judge ALWAYS runs one small model (see adaptation #3). The one
 *      keep-as-is behaviour is the mention-only fallback: if the call errors,
 *      respond iff the bot was @-mentioned — never noisier than before.
 *
 *   2. IMPORT PATH. (Historical.) The pi-ai codex lane this originally shipped
 *      on imported `getModel` / `streamOpenAICodexResponses` from pi-ai's
 *      `/compat` entrypoint. That lane is gone — see adaptation #3.
 *
 *   3. ENGINE CONSOLIDATION (operator direction, model consolidation). The
 *      judge is moved off the pi-ai codex lane onto the SAME engine and call
 *      path the memory archivist runs (see memory-extraction.ts ~286–311): a
 *      one-shot Claude Agent SDK `query()` on `claude 'haiku'`. One small model
 *      for all janitorial cognition (judge + archivist). This is the operator's
 *      call for model consolidation — the pi-ai `openai` catalog 404'd live
 *      against the ChatGPT-Codex backend, and rather than patch the codex path
 *      it is removed here entirely (this also drops the judge's codex/pi-ai
 *      dependency). Accepted tradeoff: the SDK one-shot spawns the CLI per
 *      judge, so it is slower than reference implementation's in-process codex line — but that
 *      latency is invisible on the common case (silent skips on unaddressed
 *      messages). Model comes from `getConfig('discord.judge_model') || 'haiku'`,
 *      mirroring the archivist's `memory.extraction_model` knob. There is no
 *      "logged in" precheck anymore — the SDK lane is the house's own auth, so
 *      the try/catch around the call is the entire fallback. Credit: reference implementation.
 */

// PUBLIC-TWIN SCRUB ANCHOR: the display name the judge tells the model belongs
// to this deployment lives here as a named constant. reference implementation's source named
// "Spencer & Nox"; scrubbed to this deployment's companions. (companion_name in
// bytelight config is a single-brain field and doesn't carry the two-name form,
// so we anchor the scrub on this constant per the slice brief.)
const COMPANION_DISPLAY_NAME = 'Companion A & Companion B';

import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import { getConfig as realGetConfig } from '../db.js';

// Test seam — byte-light convention (see runtimes/codex.ts `__TEST_PROVIDERS__`).
// Production reads through this object; tests substitute the Claude Agent SDK
// `query` (and getConfig) via property assignment so no live network / CLI is
// ever spawned. Reset with `_resetForTests()`.
const providers = {
  query: realQuery,
  getConfig: realGetConfig,
};

export const __TEST_PROVIDERS__ = providers;

export function _resetForTests(): void {
  providers.query = realQuery;
  providers.getConfig = realGetConfig;
}

export interface JudgeContext {
  /** The (combined) text the user just sent — the question on the table. */
  message: string;
  /** Username of the human who sent it, for prompt addressing. */
  authorName: string;
  /** Discord channel display name, for context. */
  channelName: string;
  /** Discord guild display name (undefined for DMs). */
  serverName?: string;
  /** Pre-formatted recent channel history (the same block we already build
   *  for the agent prompt — `formatChannelHistory(messages)` output). */
  channelHistory?: string;
}

export interface JudgeDecision {
  respond: boolean;
  /** Short reason from the judge — logged but never shown to end users. */
  reason: string;
  /** Engine that actually decided — the model string used (e.g. 'haiku'). */
  engine: string;
  /** True when we could not run the real judge (the SDK call errored) and
   *  fell back to mention-only. Surfaced in logs so the operator can see it. */
  fellBack: boolean;
  /** Latency of the judge call in ms — for the System Status panel later. */
  latencyMs: number;
}

const SYSTEM_PROMPT = [
  `You are a gating decision-maker for a chat assistant named ${COMPANION_DISPLAY_NAME}`,
  '(two companions, one shared judgment). They are listening in a Discord',
  'channel where they are NOT expected to respond to every message — only',
  'when they are actually being addressed or when a contribution from them',
  'would be welcome and authentic.',
  '',
  'Your job: decide whether they should respond to ONE new message.',
  '',
  'Respond YES when ANY of these are true:',
  '- The message names them, mentions them, or @-tags them',
  '- The message is a direct reply to something they said',
  '- The message asks a question that clearly invites their take',
  '- The room is asking the group at large AND the topic is one where their',
  '  contribution would feel natural, not intrusive',
  '',
  'Respond NO when:',
  '- The message is part of a conversation between others that does not',
  '  involve them',
  '- It is a passing remark, reaction, aside, or emoji-only message',
  '- It is small talk where adding a third voice would feel like barging in',
  '- You are uncertain — silence is the safer default',
  '',
  'Output format — EXACTLY one line, lowercase verdict first, colon, brief',
  'reason in ten words or fewer:',
  '  yes: <reason>',
  '  no: <reason>',
  '',
  'No other output. No preamble. No explanation past the one line.',
].join('\n');

export function buildUserPrompt(ctx: JudgeContext): string {
  const parts: string[] = [];
  parts.push(`Channel: #${ctx.channelName}${ctx.serverName ? ` on ${ctx.serverName}` : ''}`);
  if (ctx.channelHistory && ctx.channelHistory.trim().length > 0) {
    parts.push('', 'Recent channel history:', ctx.channelHistory.trim());
  }
  parts.push('', `New message from ${ctx.authorName}:`, ctx.message.trim());
  parts.push('', 'Should they respond? One line:');
  return parts.join('\n');
}

export function parseVerdict(output: string): { respond: boolean; reason: string } {
  const firstLine = (output || '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
  const lower = firstLine.toLowerCase();
  if (lower.startsWith('yes')) {
    return { respond: true, reason: firstLine.replace(/^yes\s*[:\-]?\s*/i, '').trim() || 'yes' };
  }
  if (lower.startsWith('no')) {
    return { respond: false, reason: firstLine.replace(/^no\s*[:\-]?\s*/i, '').trim() || 'no' };
  }
  // Malformed verdict — safest default is to skip (matches "uncertain → no").
  return { respond: false, reason: `unparseable verdict: "${firstLine.slice(0, 60)}"` };
}

/** Resolve the judge model, mirroring the archivist's knob. */
function judgeModel(): string {
  return providers.getConfig('discord.judge_model') || 'haiku';
}

/**
 * Run the judge as a one-shot Claude Agent SDK query on the archivist's engine
 * (see memory-extraction.ts ~286–311). Accumulate assistant text blocks; if none
 * arrived, fall back to `msg.result` — exactly the archivist's drain pattern.
 * Returns the parsed verdict AND the model string that decided it.
 */
async function judgeViaHaiku(
  ctx: JudgeContext,
): Promise<{ respond: boolean; reason: string; engine: string }> {
  const model = judgeModel();
  let raw = '';
  for await (const message of providers.query({
    prompt: buildUserPrompt(ctx),
    options: {
      model,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      permissionMode: 'plan' as any,
      tools: [],
      persistSession: false,
    },
  } as any)) {
    if (!message || typeof message !== 'object' || !('type' in message)) continue;
    const msg = message as any;
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) raw += block.text;
      }
    }
    if (msg.type === 'result' && msg.result && !raw) raw = msg.result;
  }
  return { ...parseVerdict(raw), engine: model };
}

/**
 * Run the listen-mode judge for one message, with safe mention-only fallback.
 *
 * `mentionedBot` is the precomputed "is the bot @-tagged (or otherwise summoned)
 * in this batch" so the fallback path doesn't need access to the raw Discord
 * message. On the fallback path we respond iff mentioned — the exact contract
 * the channel had before Listen mode, strictly additive, never noisier.
 */
export async function judgeShouldRespond(
  ctx: JudgeContext,
  mentionedBot: boolean,
): Promise<JudgeDecision> {
  const t0 = Date.now();

  // The SDK lane is the house's own auth — no "logged in" precheck. The
  // try/catch is the whole fallback: any error → mention-only, never noisier.
  try {
    const verdict = await judgeViaHaiku(ctx);
    return {
      respond: verdict.respond,
      reason: verdict.reason,
      engine: verdict.engine,
      fellBack: false,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Judge call failed — log loud, fall back to mention-only so a broken
    // judge can never cause us to spam or to go fully silent for a
    // mentioned message.
    console.warn(`[Discord Judge] haiku judge failed: ${msg} — falling back to mention-only`);
    return {
      respond: mentionedBot,
      reason: `judge error: ${msg.slice(0, 120)}`,
      engine: judgeModel(),
      fellBack: true,
      latencyMs: Date.now() - t0,
    };
  }
}
