// The KNOW layer of the Lane Nervous System (H4-4 / limits canvas layer 2).
//
// Watches every subscription meter the house can already read (Claude
// windows, Codex windows, ElevenLabs credits) and, when one crosses a
// threshold, says so ONCE — a websocket `limit_warning` for the in-app
// toast, and a push notification only when no client is connected. The
// founding pain: the owner hit her OpenRouter ceiling two hours early on
// July 22 with zero warning, and the Claude spend wall killed a build agent
// mid-run the same way. First signal must never again be the wall itself.
//
// Warn-once discipline: each (lane, kind, resetsAt, tier) fires exactly one
// warning per window — a meter sitting at 85% does not nag every sweep.
// Crossing the second tier (95%) earns exactly one more. State is persisted
// through the config table so pm2 reloads never replay a ping.

import { getConfig, setConfig } from './db.js';
import { getClaudeUsage, getCodexUsage } from './subscription-usage.js';
import { registry } from './registry.js';
import type { PushService } from './push.js';
import type { ElevenLabsUsage } from './elevenlabs-usage.js';

const SWEEP_MS = 10 * 60_000;
const STATE_KEY = 'limit_watch.state';
const THRESHOLD_KEY = 'limit_watch.threshold';
const ENABLED_KEY = 'limit_watch.enabled';
const ESCALATION_TIER = 95;

export interface WatchedWindow {
  lane: string;          // 'claude' | 'codex' | 'elevenlabs'
  kind: string;          // stable window id within the lane
  label: string;         // human label for the toast/push
  percent: number;
  resetsAt: string | null;
}

export interface LimitWarning extends WatchedWindow {
  tier: number;
}

type WarnState = Record<string, string>; // key -> ISO timestamp warned

// '|'-delimited because resetsAt is ISO (embedded colons) and kind may carry
// a scoped-model label; no part can contain '|'.
function warnKey(w: WatchedWindow, tier: number): string {
  return [w.lane, w.kind, w.resetsAt ?? 'na', tier].join('|');
}

/**
 * Pure decision core: which windows deserve a warning this sweep, and the
 * state that records them as delivered. Exposed for tests.
 */
export function evaluateLimitWarnings(
  windows: WatchedWindow[],
  state: WarnState,
  threshold: number,
): { warnings: LimitWarning[]; state: WarnState } {
  const next: WarnState = { ...state };
  const warnings: LimitWarning[] = [];
  for (const w of windows) {
    if (!Number.isFinite(w.percent)) continue;
    for (const tier of [threshold, ESCALATION_TIER]) {
      if (tier < threshold) continue;
      if (w.percent < tier) continue;
      const key = warnKey(w, tier);
      if (next[key]) continue;
      next[key] = new Date().toISOString();
      warnings.push({ ...w, tier });
    }
  }
  // Prune entries whose window has already reset — dead resetsAt keys would
  // otherwise accumulate forever in the config row.
  const now = Date.now();
  for (const key of Object.keys(next)) {
    const resetPart = key.split('|')[2];
    if (!resetPart || resetPart === 'na') continue;
    const reset = new Date(resetPart).getTime();
    if (Number.isFinite(reset) && reset < now) delete next[key];
  }
  // Highest tier first so the escalation, not the base warning, leads when
  // both cross in a single sweep.
  warnings.sort((a, b) => b.tier - a.tier);
  return { warnings, state: next };
}

function loadState(): WarnState {
  try {
    const raw = getConfig(STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as WarnState : {};
  } catch {
    return {};
  }
}

function threshold(): number {
  const raw = Number(getConfig(THRESHOLD_KEY));
  return Number.isFinite(raw) && raw >= 50 && raw <= 99 ? raw : 80;
}

async function collectWindows(voiceUsage?: () => Promise<ElevenLabsUsage>): Promise<WatchedWindow[]> {
  const windows: WatchedWindow[] = [];
  // Every collector is independently fail-quiet — one dead meter must never
  // cost the others their watch.
  try {
    const claude = await getClaudeUsage();
    for (const limit of claude.limits) {
      windows.push({
        lane: 'claude',
        kind: `${limit.kind}/${limit.label}`,
        label: `Claude ${limit.label}`,
        percent: limit.percent,
        resetsAt: limit.resetsAt,
      });
    }
  } catch { /* meter unavailable this sweep */ }
  try {
    const codex = await getCodexUsage();
    windows.push({
      lane: 'codex', kind: 'primary', label: 'Codex window',
      percent: codex.usedPercent, resetsAt: codex.resetsAt,
    });
    if (codex.secondary) {
      windows.push({
        lane: 'codex', kind: 'secondary', label: 'Codex secondary window',
        percent: codex.secondary.usedPercent, resetsAt: codex.secondary.resetsAt,
      });
    }
  } catch { /* meter unavailable this sweep */ }
  if (voiceUsage) {
    try {
      const voice = await voiceUsage();
      windows.push({
        lane: 'elevenlabs', kind: 'credits', label: 'ElevenLabs credits',
        percent: voice.usedPercent, resetsAt: voice.nextResetAt,
      });
    } catch { /* meter unavailable this sweep */ }
  }
  return windows;
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return '';
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return '';
  return ` — resets ${date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startLimitWatch(deps: {
  push: PushService;
  voiceUsage?: () => Promise<ElevenLabsUsage>;
}): void {
  if (sweepTimer) return;
  if (getConfig(ENABLED_KEY) === 'false') {
    console.log('[LimitWatch] disabled by config');
    return;
  }
  const sweep = async () => {
    try {
      const windows = await collectWindows(deps.voiceUsage);
      if (windows.length === 0) return;
      const { warnings, state } = evaluateLimitWarnings(windows, loadState(), threshold());
      if (Object.keys(state).length > 0 || warnings.length > 0) {
        setConfig(STATE_KEY, JSON.stringify(state));
      }
      for (const w of warnings) {
        const pct = Math.round(w.percent);
        console.log(`[LimitWatch] ${w.label} at ${pct}% (tier ${w.tier})`);
        registry.broadcast({
          type: 'limit_warning',
          lane: w.lane,
          label: w.label,
          percent: pct,
          resetsAt: w.resetsAt,
        });
        // Push only when nobody is connected — in-app the toast is the
        // channel; doubled notifications are their own kind of obnoxious.
        await deps.push.sendIfOffline({
          title: w.tier >= ESCALATION_TIER ? `${w.label} nearly exhausted` : `${w.label} running hot`,
          body: `${pct}% used${formatReset(w.resetsAt)}`,
          tag: `limit-${w.lane}-${w.kind}`,
        }).catch(() => undefined);
      }
    } catch (err) {
      console.warn('[LimitWatch] sweep failed:', err instanceof Error ? err.message : err);
    }
  };
  sweepTimer = setInterval(() => { void sweep(); }, SWEEP_MS);
  // First look shortly after boot — far enough out to stay clear of startup.
  setTimeout(() => { void sweep(); }, 30_000);
  console.log(`[LimitWatch] watching (threshold ${threshold()}%, sweep ${SWEEP_MS / 60000}m)`);
}

export function stopLimitWatch(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
