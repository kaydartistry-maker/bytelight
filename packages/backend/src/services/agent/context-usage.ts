/**
 * computeContextUsageUpdate — Slice 4b.2 extraction of the
 * `context_usage` event translation from agent.ts's event consumer loop.
 *
 * The event loop in agent.ts still owns WHEN to apply a context-usage
 * update:
 *   - the `if (event.type === 'context_usage')` check,
 *   - assigning the returned state values to the module-level
 *     `contextTokensUsed` / `contextWindowSize` bindings,
 *   - calling `console.log(...)` and `registry.broadcast(...)`,
 *   - the `continue;`.
 *
 * This helper owns HOW the runtime event maps to those operator-visible
 * signals: the percentage math, the broadcast/log guard, the WS-protocol
 * field-name translation, and the log format.
 *
 * Behavior is held verbatim against the inline source (agent.ts:1165-1184
 * at base 8f132cc). Notable invariants:
 *   - `tokensUsed` and `contextWindow` are always returned — even when
 *     the guard suppresses broadcast/log — so the downstream `usage`
 *     branch (which reads `contextTokensUsed` / `contextWindowSize`
 *     closure-style at the same loop iteration sequence) sees the
 *     latest values, including zero. The pre-Slice-2 comment on the
 *     inline branch makes this explicit and we preserve it here.
 *   - Guard `max > 0 && used > 0` gates broadcast AND log together;
 *     there is no partial-emit pattern.
 *   - Broadcast payload field-name translation matches @bytelight/shared
 *     protocol.ts: runtime `used` ➜ WS `tokensUsed`, runtime `max` ➜
 *     WS `contextWindow`. Snake-case drift here would break the
 *     frontend's protocol contract.
 *   - Log format `Context usage: ${used} / ${max} (${percentage}%)` is
 *     grepped in incident response. Format drift is a stop condition.
 *
 * Pure: no `console`, no `registry`, no `recordUsageEvent`, no
 * module-state references. Tests exercise it directly with no spies.
 *
 * Not in scope (Slice 4b.2):
 *   - applying the returned state to module bindings (stays at agent.ts),
 *   - calling `console.log(...)` or `registry.broadcast(...)` (stays at
 *     agent.ts call site),
 *   - the compaction-reset path that zeros `contextTokensUsed` from
 *     elsewhere in the loop,
 *   - the `usage` branch's read of these values,
 *   - the public getter at agent.ts:474.
 *
 * Broadcast payload shape is defined locally rather than imported as
 * `Extract<ServerMessage, { type: 'context_usage' }>` to keep this
 * file's import surface minimal. The local definition is structurally
 * identical to protocol.ts:79 — a structural-typing check on the
 * `Parameters<typeof registry.broadcast>[0]` accepted at the call site
 * proves no drift can land silently.
 */

import type { AgentRuntimeEvent } from '../runtimes/types.js';

/** The `context_usage` variant of the canonical AgentRuntimeEvent stream. */
export type ContextUsageEvent = Extract<AgentRuntimeEvent, { type: 'context_usage' }>;

/**
 * WS broadcast payload shape — structurally identical to
 * `@bytelight/shared/protocol.ts:79`'s `ServerMessage` `context_usage`
 * variant. Defined locally so this helper has zero downstream import
 * surface; the call site's `registry.broadcast(...)` accepts the
 * matching union variant by structural typing.
 */
export interface ContextUsageBroadcastPayload {
  type: 'context_usage';
  percentage: number;
  tokensUsed: number;
  contextWindow: number;
}

/**
 * Result of translating a runtime `context_usage` event:
 *   - `tokensUsed` / `contextWindow` are always set (apply unconditionally).
 *   - `broadcastPayload` / `logMessage` are non-null only when the
 *     `max > 0 && used > 0` guard passes.
 */
export interface ContextUsageUpdate {
  tokensUsed: number;
  contextWindow: number;
  broadcastPayload: ContextUsageBroadcastPayload | null;
  logMessage: string | null;
}

export function computeContextUsageUpdate(event: ContextUsageEvent): ContextUsageUpdate {
  const tokensUsed = event.used;
  const contextWindow = event.max;

  if (contextWindow > 0 && tokensUsed > 0) {
    const percentage = Math.round((tokensUsed / contextWindow) * 100);

    return {
      tokensUsed,
      contextWindow,
      broadcastPayload: {
        type: 'context_usage',
        percentage,
        tokensUsed,
        contextWindow,
      },
      logMessage: `Context usage: ${tokensUsed} / ${contextWindow} (${percentage}%)`,
    };
  }

  return {
    tokensUsed,
    contextWindow,
    broadcastPayload: null,
    logMessage: null,
  };
}
