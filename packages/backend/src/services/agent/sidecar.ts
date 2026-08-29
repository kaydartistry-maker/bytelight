/**
 * ThreadSidecar — Slice 3 extraction of the per-(thread, runtime, provider,
 * model_ref) session sidecar access seam from agent.ts.
 *
 * Wraps three db.ts functions behind a single interface so:
 *   - the provider-key mapping (claude → anthropic) lives in one place and
 *     can't drift between the read site and the write site;
 *   - the call sites in agent.ts go through the same `ThreadSidecar`
 *     instance, making them easy to swap at test time;
 *   - the load-bearing control flow stays at the agent.ts call site — this
 *     wrapper does NOT own retry/bridge policy. `_retryWithoutResume`
 *     short-circuit and `decideBridge` inputs remain visible inside
 *     `_processQuery` so the stale-session recovery contract is obvious
 *     at the call site.
 *
 * Mapping table (single entry, intentionally small):
 *   - 'claude' → 'anthropic' (legacy pre-multi-provider key in
 *     thread_provider_sessions; documented in db.ts:400-403)
 *   - everything else → passthrough (verbatim, no normalization)
 *
 * Not in scope:
 *   - `_retryWithoutResume` short-circuit (lives in _processQuery)
 *   - `decideBridge` inputs (live in _processQuery)
 *   - `clearProviderSessionsForThread` / `listProviderSessionsForThread`
 *     (used by other call paths in agent.ts; not part of the Slice 3 seam)
 *   - DB schema, query shape, or row composition (lives in db.ts)
 */

import {
  getProviderSession,
  setProviderSession,
  hasAnyProviderSessionForThread,
  type ProviderSession,
} from '../db.js';

export type { ProviderSession };

/**
 * Map a raw ProviderId to the legacy sidecar provider key used in
 * `thread_provider_sessions.provider`. Single entry today: claude →
 * anthropic. Every other provider passes through verbatim — adding entries
 * here changes resume continuity for that provider and is a Slice 3 stop
 * condition.
 */
export function sidecarProviderFor(providerId: string): string {
  return providerId === 'claude' ? 'anthropic' : providerId;
}

export interface SidecarHandle {
  threadId: string;
  runtimeId: string;
  providerId: string;
  modelRef: string;
}

export interface ThreadSidecar {
  read(handle: SidecarHandle): ProviderSession | null;
  write(handle: SidecarHandle & { sessionId: string }): void;
  hasAnyForThread(threadId: string): boolean;
}

/**
 * Dependency surface — exposes the three db.ts functions the default
 * sidecar wraps. Tests pass a stub deps object to verify key-composition
 * behavior without touching SQLite. Production call sites use the default.
 */
export interface SidecarDeps {
  getProviderSession: typeof getProviderSession;
  setProviderSession: typeof setProviderSession;
  hasAnyProviderSessionForThread: typeof hasAnyProviderSessionForThread;
}

const defaultDeps: SidecarDeps = {
  getProviderSession,
  setProviderSession,
  hasAnyProviderSessionForThread,
};

export function createThreadSidecar(
  deps: SidecarDeps = defaultDeps,
): ThreadSidecar {
  return {
    read: (h) =>
      deps.getProviderSession({
        threadId: h.threadId,
        runtimeId: h.runtimeId,
        provider: sidecarProviderFor(h.providerId),
        modelRef: h.modelRef,
      }),
    write: (h) =>
      deps.setProviderSession({
        threadId: h.threadId,
        runtimeId: h.runtimeId,
        provider: sidecarProviderFor(h.providerId),
        modelRef: h.modelRef,
        sessionId: h.sessionId,
      }),
    hasAnyForThread: (threadId) =>
      deps.hasAnyProviderSessionForThread(threadId),
  };
}
