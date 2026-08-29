/**
 * Resolver: (companion, tier, thread?) → (provider, model, effort)
 *
 * Priority order (most-specific wins):
 *   1. Thread-scope override   (if threadId provided + row exists)
 *   2. Companion-scope default (companion-wide override)
 *   3. System fallback         — byte-light's existing config resolution
 *      (cfg.agent.model / cfg.agent.model_autonomous). Untouched by P0;
 *      this resolver only DELEGATES to it, never replaces it.
 *
 * In P0 this resolver exists but is NOT wired into _processQuery (out of
 * scope). The existing Claude dispatch in services/agent.ts continues to
 * read cfg.agent.* directly. The resolver is here so future wiring work
 * can move call sites over without re-designing the contract.
 *
 * Safety belt: the system-fallback exit (and every exit) runs the effort
 * through coerceEffortForProvider so a stale 'none'/'minimal' (Codex-only)
 * can never escape to the Claude SDK. Mirrors reference implementation agent.ts:1163-1165
 * pattern — belt and suspenders at the resolver boundary.
 */

import {
  coerceEffortForProvider,
  normalizeModelRef,
  type ProviderId,
  type ThinkingEffort,
  type TierHint,
} from '@bytelight/shared';
import { getBytelightConfig } from '../config.js';
// SLICE-5a ADAPTATION: DB-config layer for systemFallback — see comment there.
import { getConfig as getDbConfig } from './db.js';
import { getCompanionSetting } from './db/companion-settings.js';

/** What the resolver hands back to a call site. */
export interface ResolvedCompanionConfig {
  provider: ProviderId;
  model: string;
  /** Always a defined ThinkingEffort value — never null. 'auto' is the
   *  sentinel for "let the per-model resolver pick at the SDK boundary." */
  effort: ThinkingEffort;
  /** Which scope this resolution came from. Useful for debug + telemetry. */
  source: 'thread' | 'companion' | 'system';
}

/**
 * Read byte-light's existing per-tier model config. This MUST stay
 * delegation-only — the Claude default path keeps using the same code
 * paths it always has. Adding a new tier here means adding it to
 * BytelightConfig.agent too; in P0 only interactive + autonomous are
 * actually wired in the config schema, so pulse/memory tiers fall back
 * to the interactive model.
 *
 * The 'pulse' and 'memory' tier mappings are intentional defaults — not
 * "wrong." byte-light's config doesn't differentiate them today; if
 * anyone wants them split, they create a companion_settings row at
 * scope='system' or scope='companion' for that tier, which overrides
 * this fallback via the resolver's priority chain.
 */
function systemFallback(tier: TierHint): { provider: ProviderId; model: string } {
  // SLICE-5a ADAPTATION: main's live model selection layers DB config ABOVE
  // YAML — agent.ts getConfiguredModel reads getDbConfig('agent.model' /
  // 'agent.model_autonomous') first (written by commands.ts /model and the
  // pre-5a pill's updateSetting), then cfg.agent.*, then env, then the
  // hard default. The tag's YAML-only fallback (cfg.agent.* alone) would
  // silently ignore a DB-set model the moment the resolver replaced
  // getConfiguredModel at the turn call site. This mirrors the oracle's
  // exact chain; pinned by agent.model-resolution-parity.test.ts. Pulse
  // and memory keep the tag's mapping to the interactive model.
  //
  // The chosen value is split through normalizeModelRef — byte-identical
  // to what the pre-5a call site did (resolveRuntimeDescriptor(model) at
  // agent.ts:856): bare Claude ids (incl. '[1m]' forms) stay on the
  // claude lane with the id untouched, while a canonical
  // '<provider>/<model>' config value (agent.dual-path.test.ts (a):
  // 'openai-codex/gpt-5.5') keeps routing to its real provider instead
  // of being mislabeled 'claude'. Unknown-provider throws surface at the
  // same call depth they did pre-5a.
  const isAutonomous = tier === 'autonomous';
  const cfg = getBytelightConfig();
  const configured =
    getDbConfig(isAutonomous ? 'agent.model_autonomous' : 'agent.model') ||
    (isAutonomous ? cfg.agent.model_autonomous : cfg.agent.model) ||
    process.env.AGENT_MODEL ||
    'claude-sonnet-4-6';
  const ref = normalizeModelRef(configured);
  return { provider: ref.provider, model: ref.model };
}

/**
 * Resolve effective config for (companionId, tier, threadId?).
 *
 * @param companionId  String identifier (validated at the db layer).
 *                     byte-light uses 'companion-a' | 'companion-b' today but the
 *                     resolver doesn't enforce that — any non-empty
 *                     string is accepted.
 * @param tier         Which model-resolution tier to read.
 * @param threadId     Optional. When provided, thread-scope overrides
 *                     are consulted first.
 */
export function resolveCompanionConfig(
  companionId: string,
  tier: TierHint,
  threadId?: string | null,
): ResolvedCompanionConfig {
  // 1. Thread-scope override — most specific
  if (threadId) {
    const threadRow = getCompanionSetting({
      companionId,
      tier,
      scope: 'thread',
      threadId,
    });
    if (threadRow) {
      const effort = coerceEffortForProvider(
        threadRow.provider_id as ProviderId,
        threadRow.thinking_effort ?? 'auto',
      );
      return {
        provider: threadRow.provider_id as ProviderId,
        model: threadRow.model_id,
        effort,
        source: 'thread',
      };
    }
  }

  // 2. Companion-scope default
  const companionRow = getCompanionSetting({
    companionId,
    tier,
    scope: 'companion',
  });
  if (companionRow) {
    const effort = coerceEffortForProvider(
      companionRow.provider_id as ProviderId,
      companionRow.thinking_effort ?? 'auto',
    );
    return {
      provider: companionRow.provider_id as ProviderId,
      model: companionRow.model_id,
      effort,
      source: 'companion',
    };
  }

  // 3. System scope row (operator override sitting above bare cfg.*)
  const systemRow = getCompanionSetting({
    companionId,
    tier,
    scope: 'system',
  });
  if (systemRow) {
    const effort = coerceEffortForProvider(
      systemRow.provider_id as ProviderId,
      systemRow.thinking_effort ?? 'auto',
    );
    return {
      provider: systemRow.provider_id as ProviderId,
      model: systemRow.model_id,
      effort,
      source: 'system',
    };
  }

  // 4. Final fallback: byte-light's existing agent.* config. This is the
  // path that today's Claude dispatch ALREADY takes; the resolver here
  // just produces a structured value with the safety belt applied.
  const fallback = systemFallback(tier);
  const effort = coerceEffortForProvider(fallback.provider, 'auto');
  return {
    provider: fallback.provider,
    model: fallback.model,
    effort,
    source: 'system',
  };
}
