// Thought-card text normalization + coalescing for the thinking-segment
// renderer. Ported from reference implementation thought-normalization suite and adapted to
// byte-light's segment shape (packages/shared MessageSegment 'thinking'
// variant: { content, summary?, kind?: 'authored' | 'provider' | 'system' }).
//
// The pure text helpers strip byte-light's internal thought marker plus
// presentation Markdown so provider summaries such as `**Checking the
// renderer**` do not leak asterisks into the card title or become a second
// layer of typography in the expanded body. The coalescer collapses the
// repetitive provider phase labels a reasoning stream emits into one card
// while keeping authored reflections, spoken text, and system notices
// (recycle seams) independent.
//
// Run tests with:
//   node --test --import tsx packages/frontend/src/lib/thinking.test.ts

import type { MessageSegment } from '@bytelight/shared';

// byte-light-native thought-card marker. Mirrors the backend's
// CODEX_THOUGHT_MARKER (codex-thought-card.ts) so a card authored here is
// stripped even if the marker survives to the frontend. The marker rides
// through the thinking-segment contract and is never UI.
const THOUGHT_MARKER = '[BYTELIGHT_THOUGHT]';

// Session-recycle / system-notice text prefix. Primary detection is the
// segment's `kind: 'system'`; this stays as a fallback for segments persisted
// before the kind contract.
const RECYCLE_PREFIX = '[Session recycled';

/**
 * Thinking cards already supply their own muted presentation. Strip Markdown's
 * presentation markers so provider summaries do not leak asterisks into the
 * card title or become a second layer of typography in the expanded body.
 */
export function plainThinkingText(value: string): string {
  return (value || '')
    .replace(/\r\n?/g, '\n')
    // Internal routing marker for the authored companion-perspective card. It
    // keeps the segment distinct from spoken commentary but is never UI.
    .replace(
      new RegExp(`^\\s*${THOUGHT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n?`, 'i'),
      '',
    )
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^```\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-+]\s+/gm, '• ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    // Single emphasis markers are only removed when they form a pair. This
    // leaves technical text such as *.tsx intact.
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s)\]},.!?:;])/gm, '$1$2')
    .replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s)\]},.!?:;])/gm, '$1$2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function thinkingParts(value: string): string[] {
  return plainThinkingText(value)
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Merge provider phase summaries while preserving their order and wording,
 *  dropping paragraphs that repeat (case-insensitive, whitespace-normalized). */
export function mergeThinkingText(values: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of values) {
    for (const part of thinkingParts(value)) {
      const key = part.replace(/\s+/g, ' ').toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
  }

  return merged.join('\n\n');
}

/** First normalized paragraph, one line, truncated to ~100 chars for the
 *  collapsed card header. */
export function thinkingTitle(value: string): string {
  const firstPart = thinkingParts(value)[0] || 'Thinking…';
  const oneLine = firstPart.replace(/\s+/g, ' ');
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

function thinkingText(segment: MessageSegment): string {
  return segment.type === 'thinking' ? (segment.content || segment.summary || '') : '';
}

function isAuthoredThinking(segment: MessageSegment): boolean {
  return segment.type === 'thinking' && segment.kind === 'authored';
}

/**
 * Detect the session-recycle / system notice card so it stays independent.
 * byte-light tags these `kind: 'system'`; the text-prefix heuristic is a
 * fallback for segments persisted before the kind contract.
 */
export function isRecycleThinking(segment: MessageSegment): boolean {
  if (segment.type !== 'thinking') return false;
  if (segment.kind === 'system') return true;
  return thinkingText(segment).startsWith(RECYCLE_PREFIX);
}

/**
 * A reasoning stream can expose the same reasoning as individual commentary
 * phases and as grouped provider summaries. Present those consecutive provider
 * phases as one thought card while leaving authored reflections, spoken text,
 * and session-recycle / system seams independent.
 *
 * Rules, faithful to the source, mapped onto byte-light's `kind` semantics:
 *   - Spoken text (a non-empty `text` segment) is a HARD boundary — never pull
 *     later thinking above words the companion said mid-turn.
 *   - System notices (recycle seams) are boundaries and stay their own card.
 *   - Within a run, an authored perspective (`kind: 'authored'`) wins over
 *     provider telemetry: the authored cards are kept, provider cards dropped.
 *     Engineering labels never blend back into the authored voice.
 *   - Otherwise consecutive provider (and legacy kindless) thinking merge into
 *     a single card via mergeThinkingText.
 */
export function coalesceThinkingSegments(segments: MessageSegment[]): MessageSegment[] {
  const coalesceRun = (run: MessageSegment[]): MessageSegment[] => {
    const authoredWins = run.some(isAuthoredThinking);
    const kept = (authoredWins ? run.filter(isAuthoredThinking) : run)
      .filter((segment) => segment.type === 'thinking' && !isRecycleThinking(segment));
    const values = kept.map(thinkingText);
    if (values.length === 0) return run;

    // No-op guard: if nothing actually merges or gets dropped — a single
    // thinking card in the run and no provider cards being discarded — pass
    // the run through UNTOUCHED. This preserves a backend-authored `summary`
    // that intentionally differs from the content's first line (e.g. a short
    // "Noticed tiredness" label over a longer reflection), so the common,
    // already-correct single-card path renders exactly as before.
    const thinkingCount = run.filter(
      (s) => s.type === 'thinking' && !isRecycleThinking(s),
    ).length;
    if (kept.length === 1 && kept.length === thinkingCount) return run;

    const content = mergeThinkingText(values);
    // Preserve the run's kind so the badge/styling survive coalescing:
    // authored wins → authored card; otherwise the merged card inherits the
    // first kept block's kind (provider, or kindless legacy → no kind).
    const firstKept = kept[0];
    const mergedKind = firstKept.type === 'thinking' ? firstKept.kind : undefined;
    const merged: MessageSegment = {
      type: 'thinking',
      content,
      summary: thinkingTitle(content),
      ...(mergedKind ? { kind: mergedKind } : {}),
    };

    let inserted = false;
    return run.flatMap((segment) => {
      if (segment.type !== 'thinking' || isRecycleThinking(segment)) return [segment];
      if (authoredWins && !isAuthoredThinking(segment)) return [];
      if (inserted) return [];
      inserted = true;
      return [merged];
    });
  };

  const output: MessageSegment[] = [];
  let run: MessageSegment[] = [];
  const flush = () => {
    if (run.length > 0) output.push(...coalesceRun(run));
    run = [];
  };

  for (const segment of segments) {
    // Spoken text and system/recycle notices are hard boundaries. Tool calls
    // are transparent within a thought run (they consolidate around them).
    const boundary =
      isRecycleThinking(segment) ||
      (segment.type === 'text' && !!segment.content.trim());
    if (boundary) {
      flush();
      output.push(segment);
    } else {
      run.push(segment);
    }
  }
  flush();
  return output;
}
