import { getConfig, getDb } from './db.js';
import { cortexRemember } from './cortex-recall.js';
import { memoryReceipt } from './memory-ledger.js';
import { proposeEdit } from './memory-proposals.js';
import type { MemoryBlock } from './memory-blocks.js';

// Soft budget default. Deliberately set ABOVE the largest current hot-core
// block (post-smoosh shared/human ≈ 64k chars) so an accidental cron enable or
// manual run finds nothing over budget and cannot gnaw ruled-hot lines. The
// diet is meant to manage NEW growth: the owner lowers this (globally via
// `memory.diet.default_budget_chars`, or per block via
// `memory.diet.budget.<scope>.<label>`) once they've decided which blocks
// should trim and by how much. Tighten deliberately, never by default.
export const DEFAULT_BUDGET_CHARS = 80_000;
export const DEFAULT_PACE_CHARS = 2_000;
export const RECENT_GUARD_DAYS = 14;

export interface DietSelection { archived: string; remaining: string; chars: number }
export type DietDecisionAction = 'archive' | 'propose' | 'skip' | 'fail';
export interface DietDecision {
  scope: string; label: string; action: DietDecisionAction; reason: string; chars?: number;
}
export interface DietRunResult {
  archived: number; proposed: number; skipped: number; failed: number; decisions: DietDecision[];
}

const ENTRY_START = /^(?:#{1,6}\s*)?(?:\[)?(\d{4}-\d{2}-\d{2})(?:\])?(?=\s|:|—|-|$)/;
const DATE_LIKE_START = /^(?:#{1,6}\s*)?(?:\[)?\d{4}-\d{2}-\d{2}/;

type SelectionAnalysis =
  | { kind: 'selected'; selection: DietSelection }
  | { kind: 'unsafe'; reason: string }
  | { kind: 'none'; reason: string };

function positiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function budgetForBlock(scope: string, label: string): number {
  const perBlock = getConfig(`memory.diet.budget.${scope}.${label}`);
  const envDefault = process.env.MEMORY_DIET_DEFAULT_BUDGET_CHARS;
  return positiveInt(perBlock, positiveInt(getConfig('memory.diet.default_budget_chars') ?? envDefault, DEFAULT_BUDGET_CHARS));
}

export function charsToMove(current: number, budget: number, pace = DEFAULT_PACE_CHARS): number {
  return Math.max(0, Math.min(pace, current - budget));
}

/** Select whole, oldest dated entries only. Every nonblank entry must have an ISO-date seam. */
export function selectOldestDatedEntries(
  content: string,
  targetChars: number,
  now = new Date(),
): DietSelection | null {
  const analysis = analyzeDatedEntries(content, targetChars, now);
  return analysis.kind === 'selected' ? analysis.selection : null;
}

function analyzeDatedEntries(content: string, targetChars: number, now: Date): SelectionAnalysis {
  if (targetChars <= 0 || !content.trim()) return { kind: 'none', reason: 'empty or within budget' };
  const lines = content.split('\n');
  const starts: Array<{ line: number; date: Date }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ENTRY_START);
    if (match) {
      const date = new Date(`${match[1]}T00:00:00Z`);
      if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === match[1]) {
        starts.push({ line: i, date });
      } else {
        return { kind: 'unsafe', reason: 'malformed date seam' };
      }
    } else if (DATE_LIKE_START.test(lines[i])) {
      return { kind: 'unsafe', reason: 'malformed date seam' };
    }
  }
  if (!starts.length) return { kind: 'unsafe', reason: 'no valid dated entry structure' };
  const startLines = new Set(starts.map(start => start.line));
  // Fail closed: only self-contained, date-prefixed nonblank lines are
  // mechanically unambiguous. Even indented prose might be persona material.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || startLines.has(i)) continue;
    return { kind: 'unsafe', reason: 'ambiguous undated or freeform material' };
  }
  const cutoffDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - RECENT_GUARD_DAYS);
  const cutoff = cutoffDate.getTime();
  const entries = starts.map((start, i) => ({
    ...start,
    end: starts[i + 1]?.line ?? lines.length,
  }));
  // Mixed structure is unsafe: text between entries belongs to its preceding dated entry,
  // while an invalid/non-chronological date makes the whole block proposal-only.
  if (entries.some((entry, i) => entry.date.getTime() > (entries[i + 1]?.date.getTime() ?? Infinity))) {
    return { kind: 'unsafe', reason: 'dated entries are not chronological' };
  }
  let take = 0;
  let chars = 0;
  for (const entry of entries) {
    if (entry.date.getTime() >= cutoff) break;
    const nextChars = lines.slice(0, entry.end).join('\n').length + (entry.end < lines.length ? 1 : 0);
    if (take > 0 && nextChars > targetChars) break;
    // A single huge entry is not mechanically splittable and must not break the pace cap.
    if (nextChars > targetChars) break;
    take = entry.end;
    chars = nextChars;
  }
  if (!take) return { kind: 'none', reason: 'no whole entry is outside the recency guard and within the pace cap' };
  return { kind: 'selected', selection: { archived: content.slice(0, chars), remaining: content.slice(chars), chars } };
}

function routeToProposal(block: MemoryBlock): boolean {
  return proposeEdit({
    op: 'replace', scope: block.scope, label: block.label,
    oldText: block.content, content: block.content,
    sourceThread: 'memory-diet:manual-review-required',
  }) !== null;
}

export async function runMemoryDiet(
  remember: typeof cortexRemember = cortexRemember,
  now = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<DietRunResult> {
  const result: DietRunResult = { archived: 0, proposed: 0, skipped: 0, failed: 0, decisions: [] };
  const blocks = getDb().prepare('SELECT * FROM memory_blocks ORDER BY scope, label').all() as MemoryBlock[];
  const pace = positiveInt(getConfig('memory.diet.pace_chars') ?? process.env.MEMORY_DIET_PACE_CHARS, DEFAULT_PACE_CHARS);
  for (const block of blocks) {
    const move = charsToMove(block.content.length, budgetForBlock(block.scope, block.label), pace);
    if (!move) {
      result.skipped++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'skip', reason: 'within soft budget' });
      continue;
    }
    const analysis = analyzeDatedEntries(block.content, move, now);
    if (analysis.kind === 'unsafe') {
      if (options.dryRun) {
        result.proposed++;
        result.decisions.push({ scope: block.scope, label: block.label, action: 'propose', reason: analysis.reason });
      } else if (routeToProposal(block)) {
        result.proposed++;
        result.decisions.push({ scope: block.scope, label: block.label, action: 'propose', reason: analysis.reason });
      } else {
        result.skipped++;
        result.decisions.push({ scope: block.scope, label: block.label, action: 'skip', reason: 'manual-review proposal already exists' });
      }
      continue;
    }
    if (analysis.kind === 'none') {
      result.skipped++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'skip', reason: analysis.reason });
      continue;
    }
    const selection = analysis.selection;
    if (options.dryRun) {
      result.archived++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'archive', reason: 'eligible oldest whole entries', chars: selection.chars });
      continue;
    }
    const mirrored = await remember(selection.archived, {
      domain: 'core-memory-archive', context: `${block.scope}/${block.label}`,
    });
    if (!mirrored) {
      result.failed++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'fail', reason: 'remote archive did not acknowledge success' });
      continue;
    }
    const committed = getDb().transaction(() => {
      const current = getDb().prepare('SELECT content FROM memory_blocks WHERE scope = ? AND label = ?')
        .get(block.scope, block.label) as { content: string } | undefined;
      if (current?.content !== block.content) return false;
      const receiptId = memoryReceipt({
        actor: 'diet-loop', action: 'memory.archive', subjectType: 'memory_block',
        subjectId: `${block.scope}/${block.label}`,
        detail: `Archived ${selection.chars} chars from ${block.scope}/${block.label}.`,
        metadata: { scope: block.scope, label: block.label, archived_chars: selection.chars },
      });
      getDb().prepare(`INSERT INTO memory_blocks_archive
        (scope, label, content, ledger_receipt_id, archived_at) VALUES (?, ?, ?, ?, ?)`)
        .run(block.scope, block.label, selection.archived, receiptId, now.toISOString());
      getDb().prepare(`UPDATE memory_blocks SET content = ?, updated_at = ? WHERE scope = ? AND label = ?`)
        .run(selection.remaining, now.toISOString(), block.scope, block.label);
      return true;
    })();
    if (committed) {
      result.archived++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'archive', reason: 'archived', chars: selection.chars });
    } else {
      result.failed++;
      result.decisions.push({ scope: block.scope, label: block.label, action: 'fail', reason: 'block changed before commit' });
    }
  }
  return result;
}
