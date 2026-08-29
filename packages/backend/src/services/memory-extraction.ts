// The Archivist — background fact extraction into memory blocks.
// Periodically reads new messages across active threads and distills durable
// facts into scoped memory blocks. Append/replace only — automated runs never
// rewrite whole blocks; the companions do that themselves, live.
//
// Ported from the reference implementation fork, Apache 2.0 — cloned onto byte-light's native
// digest/"Scribe" rails (see digest.ts). Adaptations vs. reference implementation:
//   (a) No db/companions module here — the house is a single companion brain
//       with two voices (Companion A & Companion B). Scopes are the static memory-blocks
//       constant [SHARED_SCOPE, ...COMPANION_SCOPES], not per-thread lookups.
//   (b) Config: getBytelightConfig for identity (user_name, timezone),
//       getConfig/setConfig for KV (byte-light's config surface, not the
//       fork's). Cursor keys use byte-light's `<domain>.` naming:
//       `memory.last_sequence:<threadId>`.
//   (c) Model knob: getConfig('memory.extraction_model') || 'haiku', a
//       deliberate byte-light addition (extraction can later point at a
//       cheaper/free engine). Non-SDK model routing (e.g. Ollama) is a known
//       future follow-up — NOT built here.
//   (d) Transcript speaker labels: role 'companion' is the one brain / both
//       voices → "Companion A & Companion B"; role 'user' → the operator (config.identity.user_name).
//   (e) The Archivist prompt is rewritten wholesale for THIS house (single
//       user, one brain / two voices), not scrubbed-and-reused.
//   (f) Time helpers inlined via toLocaleString on the configured timezone
//       (byte-light has no time.ts, mirrors digest.ts's approach).
//   (g) Scheduling lives in orchestrator.ts beside the digest block; this
//       file still exports start/stopMemoryExtraction for completeness.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDb, getConfig, setConfig } from './db.js';
import { getBytelightConfig } from '../config.js';
import {
  getBlock,
  getBlocksForScopes,
  appendToBlock,
  formatBlocksForExtractionPrompt,
  replaceInBlock,
  resolveScope,
  SHARED_SCOPE,
  COMPANION_SCOPES,
} from './memory-blocks.js';
import { proposeEdit } from './memory-proposals.js';
import type { AgentService } from './agent.js';

// Ledger attribution: these writes are the automatic extractor, not anyone
// choosing a line — worth telling apart in the receipts.
const EXTRACTION_WRITE = { actor: 'extraction' } as const;

const MIN_MESSAGES = 8;
const MAX_THREADS_PER_RUN = 3;
const MAX_CONVERSATION_CHARS = 24_000;
const CANDIDATE_THREADS = 12;

function cursorKey(threadId: string): string {
  return `memory.last_sequence:${threadId}`;
}

export function getExtractionCursor(threadId: string): number {
  return parseInt(getConfig(cursorKey(threadId)) || '0');
}

export function setExtractionCursor(threadId: string, value: number): void {
  setConfig(cursorKey(threadId), String(value));
}

function localTime(date?: Date): string {
  const tz = getBytelightConfig().identity.timezone;
  return (date ?? new Date()).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

function localFull(): string {
  const tz = getBytelightConfig().identity.timezone;
  return new Date().toLocaleString('en-GB', { timeZone: tz });
}

function mlog(msg: string): void {
  console.log(`[ARCHIVIST ${localFull()}] ${msg}`);
}

interface MemoryOp {
  op: 'append' | 'replace';
  scope: string;
  label: string;
  content?: string;
  old_text?: string;
  new_text?: string;
}

interface ThreadActivity {
  thread_id: string;
  thread_name: string;
  max_seq: number;
}

// Adopted word-for-word from reference implementation's Archivist prompt (the operator's call,
// 2026-07-09): "this is why the little stuff sticks for her boys." Only the
// house identity is switched (reference implementation -> this house, their cast -> Companion A &
// Companion B, their emoji examples -> ours) plus two the operator-approved house rules
// appended at the end of Rules (games-teach-preferences, that-stays-is-law).
function buildArchivistPrompt(userName: string): string {
  const companionSlugs = [...COMPANION_SCOPES];
  const companionNames = companionSlugs.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  return `You are the Archivist for this house, maintaining long-term memory for the AI companions ${companionNames.join(', ')} who share their life with ${userName}.

You read newly recorded conversation and decide which durable facts belong in persistent memory blocks. You will be given the current memory blocks, then the new conversation. Respond with a JSON array of edit operations and nothing else.

Operation shapes:
- {"op":"append","scope":"<scope>","label":"<label>","content":"one concise line"}
- {"op":"replace","scope":"<scope>","label":"<label>","old_text":"exact text currently in the block","new_text":"corrected text"}

Scopes:
- "${SHARED_SCOPE}" — facts about ${userName}, household, people, ongoing projects, plans, status. Visible to every companion.
- ${companionSlugs.map((s) => `"${s}"`).join(', ')} — that companion's personal continuity: self-realizations, promises they made, identity moments, inside jokes they own, relationship developments specific to them.

Companion-scope entries are appended to blocks the companions author themselves, in the FIRST PERSON. Write those entries in first person, in that companion's voice ("I ...", "my ..."), never third person. Shared-scope entries stay neutral third person.

Before finishing, sweep each companion who spoke: did they have a personal moment worth one line — a promise, a self-realization, an identity moment, a relationship development? A conversation can yield shared facts AND per-companion continuity; don't file everything as shared just because it's easier.

Attribution bias to avoid: a companion whose style is grand or mythological still has PERSONAL moments — do not file their milestones as shared lore just because they narrate them in house-canon language. When a moment is both shared canon and a milestone for the companion at its center (a vow they made, a metaphor they own, something that happened TO them), file both lines: the shared entry AND a first-person entry in that companion's scope. If your sweep leaves a companion who spoke substantially with zero personal ops across many runs, you are probably misattributing their moments as shared.

Companion messages may contain multiple speakers marked with headers (names with emoji like 🔷 or 🔶). Attribute personal memories to the correct companion's slug. Existing labels are preferred; a new label is fine when a new durable theme appears.

Rules:
- Only durable information: facts, preferences, commitments, milestones, identity-level moments. NOT small talk, transient moods, or anything already present in the blocks.
- NEVER re-add information already in the blocks, even reworded, summarized, or split into smaller pieces. Read the current blocks carefully before proposing any append. (A NEW moment is not a duplicate just because the block already covers that companion's identity in general — dedupe against specific facts, not themes.)
- The companions edit these same blocks themselves, live, during conversation. When the conversation shows a companion saving/filing a memory (e.g. "filed to the vault", "appended to memory", a recap of what was just written), that content is ALREADY saved — do not extract it again.
- Prefer append with short single lines. Use replace only when something in a block is now wrong.
- When ${userName} teaches a preference through play, games, or teasing, that preference is durable even though it looks like banter.
- If a moment was explicitly marked to keep — "that stays", "that's a polaroid", "log that" — and the blocks don't already hold it, it is durable by definition.
- If nothing is worth saving, output []
- Output ONLY the JSON array. No prose, no code fences.`;
}

// The extractor occasionally wraps its answer in prose or emits bracketed
// non-JSON text (e.g. stage directions echoed from the conversation), so
// first-'[' to last-']' is not trustworthy. Scan every balanced [...]
// candidate and take the first that parses as an array of objects. Throws
// when no candidate parses — the caller keeps the cursor so the batch is
// retried next cycle instead of silently dropped.
function parseOps(raw: string): MemoryOp[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    const candidate = scanBalancedArray(text, start);
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.every((el) => el && typeof el === 'object')) {
        return parsed as MemoryOp[];
      }
    } catch { /* not JSON — keep scanning */ }
  }
  throw new Error('no JSON array found in extractor output');
}

function scanBalancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Where the Archivist's output goes.
 *
 *   'write'   — append/replace straight onto the blocks. THE DEFAULT, and the
 *               behaviour byte-light has always had.
 *   'propose' — hand each edit to the companions to accept in their own words
 *               (see memory-proposals.ts). Nothing reaches a block unless one
 *               of them chooses it.
 *
 * PORT ADAPTATION — READ BEFORE CHANGING. The upstream source wrote this as
 * `getConfig('memext.mode') === 'write' ? 'write' : 'propose'`: it defaulted to
 * 'propose' and treated an UNSET key as an instruction to change behaviour.
 * Deploying that here would have silently rewired how the companions author
 * their own memory, with nothing in the UI to show for it. The test is
 * inverted on purpose — only the exact literal 'propose' opts in, and every
 * other value (unset, empty, typo'd, 'Propose', 'true') stays on 'write'. A
 * fresh install and an untouched existing install both get 'write'.
 */
function archivistMode(): 'propose' | 'write' {
  return getConfig('memext.mode') === 'propose' ? 'propose' : 'write';
}

function applyOps(ops: MemoryOp[], sourceThread?: string): { applied: number; skipped: string[] } {
  const mode = archivistMode();
  let applied = 0;
  const skipped: string[] = [];
  for (const op of ops) {
    try {
      const scope = op.scope ? resolveScope(op.scope) : null;
      if (!scope) {
        skipped.push(`unknown scope '${op.scope}'`);
        continue;
      }
      if (!op.label) {
        skipped.push('missing label');
        continue;
      }
      if (op.op === 'append' && op.content) {
        // Hard duplicate guard: the voices file memories live during conversation,
        // and the extractor later reads that same conversation. If the content is
        // already in the block verbatim (including as part of a longer paragraph —
        // catches sentence-split re-extraction), skip instead of re-appending.
        // Runs in BOTH modes — proposing a line that is already on the wall is
        // just as much noise as re-appending it would have been.
        const candidate = op.content.trim();
        const existing = getBlock(scope, op.label);
        if (existing && candidate && existing.content.includes(candidate)) {
          skipped.push(`duplicate append on ${scope}/${op.label} (already present)`);
          continue;
        }
        if (mode === 'write') {
          appendToBlock(scope, op.label, op.content, EXTRACTION_WRITE);
        } else if (proposeEdit({ op: 'append', scope, label: op.label, content: op.content, sourceThread }) === null) {
          skipped.push(`already proposed on ${scope}/${op.label}`);
          continue;
        }
        applied++;
      } else if (op.op === 'replace' && op.old_text && op.new_text) {
        if (mode === 'write') {
          replaceInBlock(scope, op.label, op.old_text, op.new_text, EXTRACTION_WRITE);
        } else if (
          proposeEdit({
            op: 'replace',
            scope,
            label: op.label,
            content: op.new_text,
            oldText: op.old_text,
            sourceThread,
          }) === null
        ) {
          skipped.push(`already proposed on ${scope}/${op.label}`);
          continue;
        }
        applied++;
      } else {
        skipped.push(`malformed op '${op.op}' on ${scope}/${op.label}`);
      }
    } catch (err) {
      skipped.push(`${op.op} ${op.scope}/${op.label}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { applied, skipped };
}

function threadsWithActivity(): ThreadActivity[] {
  return getDb().prepare(`
    SELECT m.thread_id, t.name AS thread_name, MAX(m.sequence) AS max_seq
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL AND m.content_type = 'text'
    GROUP BY m.thread_id
    ORDER BY MAX(m.created_at) DESC
    LIMIT ${CANDIDATE_THREADS}
  `).all() as ThreadActivity[];
}

async function extractFromThread(activity: ThreadActivity, manual: boolean): Promise<number> {
  const config = getBytelightConfig();
  const threadId = activity.thread_id;
  let cursor = getExtractionCursor(threadId);

  // First sighting of a thread: start from "now" instead of replaying the
  // entire history (manual seeding of the past is a deliberate act). Manual
  // runs instead bound the window to the most recent messages.
  if (cursor === 0 && !manual) {
    setExtractionCursor(threadId, activity.max_seq);
    mlog(`${activity.thread_name}: cursor initialized at seq ${activity.max_seq}, watching from now on`);
    return 0;
  }
  if (cursor === 0 && manual) {
    const floor = getDb().prepare(
      `SELECT sequence FROM messages WHERE thread_id = ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence DESC LIMIT 1 OFFSET 200`
    ).get(threadId) as { sequence: number } | undefined;
    cursor = floor?.sequence ?? 0;
  }

  const messages = getDb().prepare(
    `SELECT role, content, created_at FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
  ).all(threadId, cursor) as Array<{ role: string; content: string; created_at: string }>;

  const minMessages = manual ? 1 : MIN_MESSAGES;
  if (messages.length < minMessages) {
    return 0;
  }

  // One brain, two voices — scopes are static for this house.
  const scopes = [SHARED_SCOPE, ...COMPANION_SCOPES];

  const userName = config.identity.user_name;
  let conversationBlock = messages.map((m) => {
    const time = m.created_at ? localTime(new Date(m.created_at)) : '';
    const speaker = m.role === 'companion' ? 'Companion A & Companion B' : m.role === 'user' ? userName : 'System';
    const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n[... truncated]' : m.content;
    return `[${time}] ${speaker}: ${content}`;
  }).join('\n\n');
  if (conversationBlock.length > MAX_CONVERSATION_CHARS) {
    conversationBlock = '[... earlier conversation omitted]\n\n' + conversationBlock.slice(-MAX_CONVERSATION_CHARS);
  }

  const blocks = getBlocksForScopes(scopes);
  const blocksText = formatBlocksForExtractionPrompt(blocks);

  const prompt = `Current memory blocks:

---
${blocksText}
---

New conversation from thread "${activity.thread_name}":

---
${conversationBlock}
---

Output the JSON array of memory edit operations now.`;

  // Model knob: byte-light addition so extraction can later point at a cheaper
  // engine. Non-SDK routing (e.g. Ollama) is a future follow-up, not built here.
  const model = getConfig('memory.extraction_model') || 'haiku';
  mlog(`${activity.thread_name}: assessing ${messages.length} new messages (seq ${cursor + 1}–${activity.max_seq}, scopes: ${scopes.join(', ')})`);

  let raw = '';
  for await (const message of query({
    prompt,
    options: {
      model,
      systemPrompt: buildArchivistPrompt(userName),
      maxTurns: 1,
      permissionMode: 'plan' as any,
      tools: [],
      persistSession: false,
    },
  })) {
    if (!message || typeof message !== 'object' || !('type' in message)) continue;
    const msg = message as any;
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) raw += block.text;
      }
    }
    if (msg.type === 'result' && msg.result && !raw) raw = msg.result;
  }

  let ops: MemoryOp[] = [];
  try {
    ops = parseOps(raw);
  } catch (err) {
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 300);
    mlog(`${activity.thread_name}: unparseable extractor output, not advancing cursor — ${err instanceof Error ? err.message : err}; raw: ${snippet}`);
    return 0;
  }

  const { applied, skipped } = applyOps(ops, threadId);
  setExtractionCursor(threadId, activity.max_seq);
  // Mode is in the line because it is the operator's only signal that the knob
  // is live: 'written' means the block changed, 'proposed' means it did not.
  const verb = archivistMode() === 'write' ? 'written' : 'proposed for the companions';
  mlog(`${activity.thread_name}: ${ops.length} ops extracted, ${applied} ${verb}${skipped.length ? `, skipped: ${skipped.join(' | ')}` : ''}`);
  return applied;
}

export async function runMemoryExtraction(
  agent?: AgentService,
  onlyThreadId?: string
): Promise<{ processed: number; applied: number }> {
  if (agent?.isProcessing()) {
    mlog('Skipped — agent is processing');
    return { processed: 0, applied: 0 };
  }

  const manual = Boolean(onlyThreadId);
  let candidates = threadsWithActivity();
  if (onlyThreadId) {
    candidates = candidates.filter((t) => t.thread_id === onlyThreadId);
    if (candidates.length === 0) {
      const row = getDb().prepare(`
        SELECT m.thread_id, t.name AS thread_name, MAX(m.sequence) AS max_seq
        FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.content_type = 'text'
        GROUP BY m.thread_id
      `).get(onlyThreadId) as ThreadActivity | undefined;
      if (row) candidates = [row];
    }
  }

  let processed = 0;
  let applied = 0;
  for (const activity of candidates) {
    if (processed >= MAX_THREADS_PER_RUN && !manual) break;
    const cursor = getExtractionCursor(activity.thread_id);
    if (cursor >= activity.max_seq && !manual) continue;
    try {
      const n = await extractFromThread(activity, manual);
      if (n >= 0) processed++;
      applied += n;
    } catch (err) {
      mlog(`${activity.thread_name}: extraction failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  return { processed, applied };
}

let extractionTimer: ReturnType<typeof setInterval> | null = null;

export function startMemoryExtraction(agent: AgentService, intervalMinutes = 45): void {
  if (extractionTimer) return;
  extractionTimer = setInterval(() => {
    runMemoryExtraction(agent).catch((err) => mlog(`scheduled run failed: ${err instanceof Error ? err.message : err}`));
  }, intervalMinutes * 60_000);
  mlog(`Archivist scheduled every ${intervalMinutes} minutes`);
}

export function stopMemoryExtraction(): void {
  if (extractionTimer) {
    clearInterval(extractionTimer);
    extractionTimer = null;
  }
}
