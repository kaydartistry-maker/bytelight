import type { Message } from '@bytelight/shared';

const BRIDGE_TURN_CAP = 15;
const BRIDGE_CHAR_CAP = 14_000; // ~3.5k tokens at ~4 chars/token
const PER_MESSAGE_CHAR_CAP = 800;

export function formatTurnsForContext(messages: Message[]): string {
  // Walk newest-first to guarantee most recent turns are kept under cap,
  // then unshift to restore chronological order in the emitted block.
  const out: string[] = [];
  let totalChars = 0;
  let turnsKept = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (turnsKept >= BRIDGE_TURN_CAP) break;
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'companion') continue;

    const roleLabel = m.role === 'user' ? 'User' : 'Companion';
    let body = (m.content || '').trim();
    if (body.length === 0) continue;
    if (body.length > PER_MESSAGE_CHAR_CAP) {
      body = body.slice(0, PER_MESSAGE_CHAR_CAP) + '…[truncated]';
    }
    const line = `${roleLabel}: ${body}`;

    if (totalChars + line.length + 1 > BRIDGE_CHAR_CAP) break;
    out.unshift(line);
    totalChars += line.length + 1;
    turnsKept++;
  }

  return out.join('\n');
}

export function buildBridgeBlock(messages: Message[]): string {
  const transcript = formatTurnsForContext(messages);
  if (!transcript) return '';
  return (
    `[Prior conversation in this thread — model swap continuity bridge]\n` +
    transcript +
    `\n[/Prior conversation]\n\n`
  );
}

// Decision table (Slice 1.5 — recency-aware):
//
//   retry | hit  | newerForeign | anyPrior || decision
//   ------+------+--------------+----------++---------------
//   true  |  *   |      *       |    *     || pristine
//   false | true |    false     |    *     || resume
//   false | true |    true      |    *     || resume+bridge   ← return-to-model amnesia fix
//   false | false|      *       |   true   || bridge
//   false | false|      *       |   false  || pristine
//
// 'resume+bridge': the sidecar HIT for the current triple, but a row under a
// DIFFERENT (runtime_id, provider, model_ref) triple has a strictly newer
// last_used_at — i.e. another model carried the thread since this one last
// spoke. Plain resume would wake the session amnesiac about that era, so we
// resume AND inject the continuity bridge covering the gap. All other paths
// are byte-identical to the pre-1.5 table.
export function decideBridge(opts: {
  retry: boolean;
  sidecarHitForCurrentModel: boolean;
  anyPriorSidecarRow: boolean;
  newerForeignSessionExists: boolean;
}): 'resume' | 'resume+bridge' | 'bridge' | 'pristine' {
  if (opts.retry) return 'pristine';
  if (opts.sidecarHitForCurrentModel) {
    return opts.newerForeignSessionExists ? 'resume+bridge' : 'resume';
  }
  if (opts.anyPriorSidecarRow) return 'bridge';
  return 'pristine';
}

/** Intentional Codex refresh is idle-based, never age-based. Invalid or
 * future timestamps fail closed so a malformed sidecar cannot discard a
 * usable warm session. */
export function shouldRecycleCodexSession(
  lastUsedAt: string,
  nowMs = Date.now(),
  idleMs = 12 * 60 * 60 * 1000,
): boolean {
  const lastUsedMs = Date.parse(lastUsedAt);
  return Number.isFinite(lastUsedMs)
    && lastUsedMs <= nowMs
    && nowMs - lastUsedMs >= idleMs;
}
