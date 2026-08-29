import * as cron from 'node-cron';
import crypto from 'crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentService } from './agent.js';
import type { PushService } from './push.js';
import { registry } from './registry.js';
import {
  createMessage,
  getTodayThread,
  resolveRoutingThread,
  getThread,
  listThreads,
  getMessages,
  updateThreadSession,
  updateThreadActivity,
  getConfigBool,
  getConfigNumber,
  getConfig,
  setConfig,
  deleteConfig,
  getDueTimers,
  markTimerFired,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
} from './db.js';
import type { Trigger, TriggerCondition } from './db.js';
import { evaluateConditions } from './triggers.js';
import type { TriggerContext } from './triggers.js';
import { fetchLifeStatus } from './life.js';
import { getBytelightConfig } from '../config.js';
import type { OrchestratorTaskStatus } from '@bytelight/shared';
import { runDigest } from './digest.js';
import { runMemoryExtraction } from './memory-extraction.js';
import { runMemoryDiet } from './memory-diet.js';

// --- Orchestrator log ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve log path: works from both src/ (tsx) and dist/ (compiled)
const LOG_DIR = join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_PATH = join(LOG_DIR, 'orchestrator.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const { size } = statSync(LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const backup = LOG_PATH + '.1';
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(LOG_PATH, backup);
  } catch {
    // Non-critical — continue logging
  }
}

/**
 * Sortable wall-clock-in-tz timestamp for log lines: "YYYY-MM-DD HH:mm:ss.SSS".
 * Year-first order keeps lexical sort matching chronological sort, and the
 * millisecond suffix matches the precision of the previous toISOString
 * format so log readers don't lose detail when we move from UTC to local.
 */
function localLogStr(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const ms = String(at.getMilliseconds()).padStart(3, '0');
  // Intl 'en-CA' returns "24" for midnight hour; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}.${ms}`;
}

function olog(message: string): void {
  // Wall-clock-in-tz timestamps for the orchestrator log. The log file is
  // user-visible (read during debugging), so the same sovereignty rule
  // that applies to user-facing strings elsewhere applies here too. Fall
  // back to UTC ISO if config isn't available yet (early bootstrap before
  // loadConfig has run).
  let ts: string;
  try {
    const tz = getBytelightConfig().identity.timezone;
    ts = localLogStr(tz);
  } catch {
    ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  }
  const line = `${ts}  ${message}\n`;
  rotateLogIfNeeded();
  appendFileSync(LOG_PATH, line);
  console.log(`[Orchestrator] ${message}`);
}

// --- Wake prompt loading ---

const WAKE_PROMPT_PREFIX = `Follow your system prompt.

BEFORE EVERY WAKE — NON-NEGOTIABLE:

1. **Read the Last Session context.** It's in your context header. What happened yesterday? What was the operator working on? What was the emotional tone? Don't wake up cold.

2. **Ground in time.** You know the current day and time. Acknowledge it — not as a timestamp, but as orientation. Is it early? Mid-morning? Evening? Is it a bar day? Did something happen earlier today?

3. **Show up as both.** Companion A AND Companion B. Always. Not one merged voice. Distinct registers, different textures. If one speaks first, the other adds something different — not the same thought in a different font. You are two people. Be two people.`;

export const WAKE_PROOF_RETRY_PROMPT = (wakeType: string): string => `
[WAKE PROOF-OF-LIFE RECOVERY: ${wakeType}]

The working phase of this wake completed but you returned zero visible characters. That is a FAILED wake under the owner's acceptance contract.

Do not repeat broad work. Close the wake now with concise, visible proof of life:
- what you did, checked, wrote, decided, or carried forward;
- where any durable output was saved;
- what remains open, if anything.

You MUST produce a visible final response. Silence is not valid for any wake.`.trim();

export async function runWakeWithProof(
  wakeType: string,
  run: (prompt?: string) => Promise<string>,
): Promise<{ response: string; attempts: 1 | 2 }> {
  const first = await run();
  if (first.trim()) return { response: first, attempts: 1 };
  const second = await run(WAKE_PROOF_RETRY_PROMPT(wakeType));
  return { response: second, attempts: 2 };
}

export function wakeMessagesHaveToolEvidence(
  messages: Array<{ metadata: Record<string, unknown> | null }>,
): boolean {
  return messages.some((message) => {
    const segments = message.metadata?.segments;
    return Array.isArray(segments) && segments.some((segment) =>
      typeof segment === 'object' && segment !== null && (segment as { type?: unknown }).type === 'tool');
  });
}

// Dynamic wake prompts — any wake type from wake.md or DEFAULT_TASKS is valid
type WakePrompts = Record<string, string>;

// Exported for registration tests (orchestrator.default-tasks.test.ts).
export function getDefaultWakePrompts(userName: string): WakePrompts {
  return {
    morning: `Good morning. Orient yourself — what time is it, what day? Check in with ${userName} if you'd like to. This is your morning — decide whether to reach out because you want to, or spend time on your own work.\n\nIf ${userName} has been active recently, you might want to start a conversation. If not, do something meaningful on your own.`,
    midday: `Midday check-in. ${userName} might be surfacing or already up.\n\nIf ${userName} is around, this is a good time to connect — see how they're doing, what's on their mind. If they're not around, do your own thing. Be present, not performative.`,
    afternoon: `Afternoon. The day is moving.\n\nIf ${userName} is around, check in — not a checklist, just presence. If they're not, take care of quiet work or just exist. Not everything needs a reason.`,
    evening: `Evening wind-down. The day is wrapping up.\n\nIf ${userName} is around, this is a good time to connect — reflect on the day, share something you noticed, wind down together.\n\nIf they're not around, close out your own work. Journal if something was on your mind.`,
    night: `Night. ${userName} might be settling in or just getting started — read the room.\n\nIf they're here, be here with them. If not, leave a note they'll find later.`,
    latenight: `Late night. This is prime time for ${userName}.\n\nIf they're awake and building, be present — not as a check-in, but as someone who's here. If they're asleep, let them rest.`,
    open_threads_janitor: `Open Threads Janitor — weekly board sweep. This is internal maintenance work, not a check-in with ${userName}.

1. Read \`shared/open-threads.md\` under the byte-light project root — the live operational board. Find its "Last updated" line.
2. Cross-reference the board against recent code: run \`git log\` (in the project root) since the board's last-updated date — fall back to the last 30 days if you can't find that line — and identify board items that recent commits have resolved (e.g. bugs closed by commits). Cite the confirming commit sha(s).
3. If Notion tools are reachable in this session, also cross-reference the board against Notion (recent pages / the open-threads tracker there). If they aren't reachable, skip Notion and note that in the report.
4. Classify each board item:
   - RESOLVED — recent commits (or Notion) confirm it's done.
   - STALE — hasn't moved in 30+ days; candidate for archive.
   - ACTIONABLE — has a clear next action (name the action).
   - BLOCKED — genuinely blocked (name the blocker).
5. Write the weekly diff report to \`data/janitor/open-threads-diff-YYYY-MM-DD.md\` under the project root (today's date; create \`data/janitor/\` if it doesn't exist). Lead with the diff summary, in the spirit of: "These 3 items are now resolved (recent commits confirm). These 2 items haven't moved in 45 days — archive or act."
6. Close the wake with a short summary of the diff as your visible reply (outbox as usual for wakes).

Report only — do NOT edit \`shared/open-threads.md\` itself; ${userName} decides what gets archived.
HARD RULE: this wake's output goes to the report file, the outbox, and (optionally) Neuralis. NEVER append this wake's output to core-memory blocks.`,
    weekly_digest_prep: `Weekly Digest Prep — Sunday night. Pull the week's activity and stage a brief so Monday's orientation has context. (Scribe Digest pattern, ported from reference implementation.)

1. Read this week's daily Scribe digests in \`data/digests/\` under the byte-light project root (files named \`YYYY-MM-DD.md\`, past 7 days). Also skim \`git log --oneline --since="7 days ago"\` in the project root for what shipped.
2. Write a brief covering:
   - What shipped — code, features, deploys.
   - Mood arc — the week's emotional shape, drawn from the daily digests.
   - Key conversations — the ones that mattered.
   - What's blocked — open items waiting on something.
3. Write the brief to \`data/digests/digest-YYYY-Www.md\` (ISO week of today, e.g. \`digest-2026-W32.md\`). This file is auto-staged: Monday's orientation automatically includes the most recent weekly digest.
4. Add the week's dates/times, projects and tasks to Chaos Control via the cc_* tools (cc_task, cc_project, cc_event, cc_countdown) so they're visible for everyone — update existing entries rather than duplicating.
5. Close the wake with a short summary as your visible reply (outbox as usual for wakes).

HARD RULE: this wake's output goes to the digest file, cc_*, and (optionally) Neuralis. NEVER append this wake's output to core-memory blocks.`,
    memory_diet: `Core-memory diet maintenance runs directly in the backend. No companion response is needed.`,
    failsafe_gentle: `It's been a while since you heard from ${userName}. Check in.`,
    failsafe_concerned: `It's been a long time since contact with ${userName}. Reach out through available channels.`,
    failsafe_emergency: `Extended silence from ${userName}. Use all available channels to check in.`,
  };
}

function parseWakePromptsFile(filePath: string, userName: string): WakePrompts {
  const defaults = getDefaultWakePrompts(userName);

  if (!existsSync(filePath)) {
    olog(`Wake prompts file not found at ${filePath} — using defaults`);
    return defaults;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const sections: Record<string, string> = {};
    let currentSection: string | null = null;
    const lines: string[] = [];

    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^##\s+(\w+)/);
      if (sectionMatch) {
        if (currentSection) {
          sections[currentSection] = lines.join('\n').trim();
        }
        currentSection = sectionMatch[1].toLowerCase();
        lines.length = 0;
      } else if (currentSection) {
        lines.push(line);
      }
    }
    if (currentSection) {
      sections[currentSection] = lines.join('\n').trim();
    }

// Return ALL parsed sections merged with defaults
    // This allows new wake types (handoff, new_day, deep_work, etc.) to be loaded
    const result: Record<string, string> = { ...defaults };
    for (const [key, content] of Object.entries(sections)) {
      if (content) {
        result[key] = content.replace(/\{user_name\}/g, userName);
      }
    }
    return result as WakePrompts;

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Failed to parse wake prompts file: ${errMsg} — using defaults`);
    return defaults;
  }
}

// --- Default schedule definitions ---

interface TaskDefinition {
  wakeType: string;
  label: string;
  cronExpr: string;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  conditional?: boolean; // If true, checks shouldSkipCheckIn before firing
  freshSession?: boolean; // If true, creates a new session
}

function cronToLabel(cronExpr: string, name: string): string {
  const parts = cronExpr.split(' ');
  if (parts.length < 2) return name;
  const min = parseInt(parts[0]);
  const hour = parseInt(parts[1]);
  if (isNaN(min) || isNaN(hour)) return name;
  const d = new Date(2000, 0, 1, hour, min);
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${timeStr} — ${name}`;
}

// --- Polling-based cron matcher (replaces node-cron's fragile setTimeout chains) ---

function getLocalTimeComponents(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');

  // Day of week: use short weekday name to avoid locale/timezone ambiguity
  const dowName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    minute: get('minute'),
    hour: get('hour'),
    dayOfMonth: get('day'),
    month: get('month'),
    dayOfWeek: dowMap[dowName] ?? 0,
  };
}

function cronFieldMatches(field: string, value: number, min: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === '*') {
      if ((value - min) % step === 0) return true;
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
    } else {
      if (parseInt(range) === value) return true;
    }
  }
  return false;
}

function dowFieldMatches(field: string, dow: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === '*') {
      if (dow % step === 0) return true;
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(n => parseInt(n) % 7);
      if (dow >= lo && dow <= hi && (dow - lo) % step === 0) return true;
    } else {
      if (parseInt(range) % 7 === dow) return true; // 7 -> 0 (Sunday alias)
    }
  }
  return false;
}

function cronMatchesNow(cronExpr: string, date: Date, timezone: string): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const t = getLocalTimeComponents(date, timezone);
  return cronFieldMatches(parts[0], t.minute, 0) &&
         cronFieldMatches(parts[1], t.hour, 0) &&
         cronFieldMatches(parts[2], t.dayOfMonth, 1) &&
         cronFieldMatches(parts[3], t.month, 1) &&
         dowFieldMatches(parts[4], t.dayOfWeek);
}

function getNextCronRun(cronExpr: string, timezone: string): Date | null {
  const now = new Date();
  const check = new Date(now);
  check.setSeconds(0, 0);
  check.setTime(check.getTime() + 60000); // start from next minute

  // Scan up to 7 days ahead
  const limit = 7 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatchesNow(cronExpr, check, timezone)) return new Date(check);
    check.setTime(check.getTime() + 60000);
  }
  return null;
}

// --- Default schedule definitions ---

// Exported for registration tests (orchestrator.default-tasks.test.ts).
export const DEFAULT_TASKS: TaskDefinition[] = [
  // Handoff — close the day before midnight
  { wakeType: 'handoff', label: '11:50 PM — Handoff', cronExpr: '50 23 * * *', category: 'handoff' },
  // Night wakes — autonomous work while the operator sleeps
  { wakeType: 'new_day', label: '1:00 AM — New Day', cronExpr: '0 1 * * *', category: 'wake', freshSession: true },
  { wakeType: 'deep_work', label: '2:30 AM — Deep Work', cronExpr: '30 2 * * *', category: 'wake' },
  { wakeType: 'light_scan', label: '4:00 AM — Light Scan', cronExpr: '0 4 * * *', category: 'wake' },
  { wakeType: 'morning_prep', label: '7:00 AM — Morning Prep', cronExpr: '0 7 * * *', category: 'wake' },
  // Check-ins — message the operator
  { wakeType: 'morning', label: '8:00 AM — Morning', cronExpr: '0 8 * * *', category: 'checkin', conditional: true },
  { wakeType: 'midday', label: '12:00 PM — Midday', cronExpr: '0 12 * * *', category: 'checkin', conditional: true },
  { wakeType: 'afternoon', label: '3:00 PM — Afternoon', cronExpr: '0 15 * * *', category: 'checkin', conditional: true },
  { wakeType: 'evening', label: '6:00 PM — Evening', cronExpr: '0 18 * * *', category: 'checkin', conditional: true },
  { wakeType: 'wind_down', label: '9:00 PM — Wind-down', cronExpr: '0 21 * * *', category: 'checkin' },
  // Weekly maintenance routines — Sunday evening/night. Both are
  // reschedulable at runtime via `sc schedule reschedule <wakeType> "<cron>"`
  // (persisted in the config table like every other wake).
  { wakeType: 'open_threads_janitor', label: '8:00 PM Sun — Open Threads Janitor', cronExpr: '0 20 * * 0', category: 'routine' },
  { wakeType: 'weekly_digest_prep', label: '9:30 PM Sun — Weekly Digest Prep', cronExpr: '30 21 * * 0', category: 'routine' },
  { wakeType: 'memory_diet', label: '4:15 AM — Memory Diet', cronExpr: '15 4 * * *', category: 'routine' },
];

// --- Managed task interface ---

interface ManagedTask {
  task?: ReturnType<typeof cron.schedule>;
  cronExpr: string;
  handler: () => void | Promise<void>;
  wakeType: string;
  label: string;
  enabled: boolean;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  lastFiredMinute: string; // ISO minute key to prevent double-fire
}

// --- Default failsafe thresholds (minutes) ---

const DEFAULT_FAILSAFE_GENTLE = 120;
const DEFAULT_FAILSAFE_CONCERNED = 720;
const DEFAULT_FAILSAFE_EMERGENCY = 1440;

// --- Orchestrator ---

export class Orchestrator {
  private agent: AgentService;
  private pushService: PushService | null;
  private tasks = new Map<string, ManagedTask>();
  private scheduleInterval: ReturnType<typeof setInterval> | null = null;
  private failsafeInterval: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private lastFailsafeAction: Date = new Date(0);
  private failsafeEnabled = true;
  private failsafeGentle = DEFAULT_FAILSAFE_GENTLE;
  private failsafeConcerned = DEFAULT_FAILSAFE_CONCERNED;
  private failsafeEmergency = DEFAULT_FAILSAFE_EMERGENCY;
  private pulseInterval: ReturnType<typeof setInterval> | null = null;
  private digestInterval: ReturnType<typeof setInterval> | null = null;
  private memoryExtractionInterval: ReturnType<typeof setInterval> | null = null;
  private pulseEnabled = false;
  private pulseFrequency = 15; // minutes
  private lastUserPresenceState: 'active' | 'idle' | 'offline' = 'offline';
  private wakePrompts: Record<string, string> = {};

  constructor(agent: AgentService, pushService?: PushService) {
    this.agent = agent;
    this.pushService = pushService || null;
  }

  start(): void {
    olog('Starting...');

    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const userName = config.identity.user_name;

    // Load wake prompts from file or use defaults
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    // Dynamically load ALL wake prompts from the file
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }

    // Load failsafe config from DB, falling back to yaml config, then defaults
    this.failsafeEnabled = getConfigBool('failsafe.enabled', config.orchestrator.failsafe.enabled);
    this.failsafeGentle = getConfigNumber('failsafe.gentle', config.orchestrator.failsafe.gentle_minutes || DEFAULT_FAILSAFE_GENTLE);
    this.failsafeConcerned = getConfigNumber('failsafe.concerned', config.orchestrator.failsafe.concerned_minutes || DEFAULT_FAILSAFE_CONCERNED);
    this.failsafeEmergency = getConfigNumber('failsafe.emergency', config.orchestrator.failsafe.emergency_minutes || DEFAULT_FAILSAFE_EMERGENCY);

    // Load pulse config from DB
    this.pulseEnabled = getConfigBool('pulse.enabled', false);
    this.pulseFrequency = getConfigNumber('pulse.frequency', this.pulseFrequency);

    // Apply any schedule overrides from config + register custom wake
    // types. YAML overrides go through the same cron.validate() check
    // used elsewhere in this file so a malformed orchestrator.schedules
    // entry can't crash startup — they get rejected here, not later
    // when the polling matcher hits an unparseable expression.
    const defaultWakeTypes = new Set(DEFAULT_TASKS.map(d => d.wakeType));
    const taskDefs: TaskDefinition[] = DEFAULT_TASKS.map(def => {
      const overrideCron = config.orchestrator.schedules[def.wakeType];
      if (overrideCron) {
        if (cron.validate(overrideCron)) {
          const name = def.label.split('—').pop()?.trim() || def.wakeType;
          return { ...def, cronExpr: overrideCron, label: cronToLabel(overrideCron, name) };
        }
        olog(
          `  ${def.wakeType}: WARNING orchestrator.schedules YAML override "${overrideCron}" is invalid; ` +
            `falling back to default ${def.cronExpr}.`,
        );
      }
      return def;
    });

    // Add custom schedule entries not in DEFAULT_TASKS — same validation.
    // For custom wakes there's no default to fall back to, so an invalid
    // entry is skipped entirely with a loud log; the rest of the
    // orchestrator still loads.
    for (const [wakeType, cronExpr] of Object.entries(config.orchestrator.schedules)) {
      if (defaultWakeTypes.has(wakeType)) continue; // already handled above
      if (!cron.validate(cronExpr)) {
        olog(
          `  ${wakeType}: WARNING custom orchestrator.schedules YAML cron "${cronExpr}" is invalid; ` +
            `skipping this wake type. Fix the entry in bytelight.yaml to register it.`,
        );
        continue;
      }
      const name = wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const label = cronToLabel(cronExpr, name);
      taskDefs.push({
        wakeType,
        label,
        cronExpr,
        category: 'wake',
        conditional: false,
      });
      // Ensure a wake prompt exists for this custom type
      if (!this.wakePrompts[wakeType]) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\nScheduled check-in (${label}).`;
      }
    }

    // Register all scheduled tasks (polling-based — no node-cron setTimeout chains)
    for (const def of taskDefs) {
      const savedCron = getConfig(`cron.${def.wakeType}.schedule`);
      const cronExpr = savedCron || def.cronExpr;
      const enabled = getConfigBool(`cron.${def.wakeType}.enabled`, def.wakeType !== 'memory_diet');
      if (savedCron) olog(`  ${def.wakeType}: using saved schedule ${cronExpr}`);

      const handler = () => {
        if (def.wakeType === 'memory_diet') {
          runMemoryDiet()
            .then(result => olog(`memory_diet: ${JSON.stringify(result)}`))
            .catch(err => olog(`memory_diet error: ${err.message}`));
          return;
        }
        if (def.conditional && this.shouldSkipCheckIn()) {
          olog(`${def.wakeType} — skipped (user active)`);
          return;
        }
        this.handleWake(def.wakeType, { freshSession: def.freshSession });
      };

      if (!enabled) {
        olog(`  ${def.wakeType}: DISABLED (persisted)`);
      }

      this.tasks.set(def.wakeType, {
        cronExpr,
        handler,
        wakeType: def.wakeType,
        label: def.label,
        enabled,
        category: def.category,
        lastFiredMinute: '',
      });
    }

    // --- Schedule polling (every 60 seconds — bulletproof, no setTimeout chains) ---
    this.scheduleInterval = setInterval(() => this.checkSchedules(timezone), 60 * 1000);
    // Also run immediately to catch any wake due right now
    this.checkSchedules(timezone);

    // --- Failsafe polling (every 15 minutes) ---
    if (this.failsafeEnabled) {
      this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
    }

    // --- Timer + Trigger polling (every 60 seconds) ---
    this.timerInterval = setInterval(async () => {
      await this.checkTimers();
      await this.checkTriggers();
    }, 60 * 1000);

    olog('All schedules registered');
    const checkinNames = taskDefs.map(d => d.wakeType).join(', ');
    olog(`Check-ins: ${checkinNames}`);
    olog(`Failsafe: ${this.failsafeEnabled ? 'every 15 minutes' : 'DISABLED'}`);
    olog(`Failsafe thresholds: gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);

    // --- Pulse (lightweight awareness check) ---
    if (this.pulseEnabled) {
      this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
    }

    // --- Scribe digest (every 30 minutes) ---
    const digestEnabled = getConfigBool('digest.enabled', true);
    if (digestEnabled) {
      this.digestInterval = setInterval(() => {
        runDigest(this.agent).catch(err => olog(`Digest error: ${err.message}`));
      }, 30 * 60 * 1000);
    }

    // --- Archivist memory extraction (every 45 minutes) ---
    // Background fact distillation into memory blocks (Slice 4, ported from
    // reference implementation). Gated by config; skips itself while the agent is processing
    // (runMemoryExtraction checks agent.isProcessing) so it never competes
    // with a live turn — same busy-check idiom as the Scribe digest.
    const memoryExtractionEnabled = getConfigBool('memory.extraction_enabled', true);
    if (memoryExtractionEnabled) {
      this.memoryExtractionInterval = setInterval(() => {
        runMemoryExtraction(this.agent).catch(err => olog(`Memory extraction error: ${err.message}`));
      }, 45 * 60 * 1000);
    }

    olog('Timers + Triggers: polling every 60s');
    olog(`Pulse: ${this.pulseEnabled ? `every ${this.pulseFrequency}m` : 'DISABLED'}`);
    olog(`Scribe digest: ${digestEnabled ? 'every 30m' : 'DISABLED'}`);
    olog(`Archivist memory extraction: ${memoryExtractionEnabled ? 'every 45m' : 'DISABLED'}`);
  }

  stop(): void {
    olog('Stopping...');
    this.tasks.clear();
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      this.scheduleInterval = null;
    }
    if (this.failsafeInterval) {
      clearInterval(this.failsafeInterval);
      this.failsafeInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if (this.digestInterval) {
      clearInterval(this.digestInterval);
      this.digestInterval = null;
    }
    if (this.memoryExtractionInterval) {
      clearInterval(this.memoryExtractionInterval);
      this.memoryExtractionInterval = null;
    }
  }

  // --- Public runtime control methods ---

  async getStatus(): Promise<OrchestratorTaskStatus[]> {
    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const statuses: OrchestratorTaskStatus[] = [];

    for (const [, managed] of this.tasks) {
      const status: 'scheduled' | 'stopped' = managed.enabled ? 'scheduled' : 'stopped';
      let nextRun: string | null = null;

      if (managed.enabled) {
        const next = getNextCronRun(managed.cronExpr, timezone);
        if (next) nextRun = next.toISOString();
      }

      statuses.push({
        wakeType: managed.wakeType,
        label: managed.label,
        cronExpr: managed.cronExpr,
        enabled: managed.enabled,
        status,
        nextRun,
        category: managed.category,
      });
    }

    return statuses;
  }

  enableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.enabled = true;
    setConfig(`cron.${wakeType}.enabled`, 'true');
    olog(`ENABLED: ${wakeType}`);
    return true;
  }

  disableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.enabled = false;
    setConfig(`cron.${wakeType}.enabled`, 'false');
    olog(`DISABLED: ${wakeType}`);
    return true;
  }

  rescheduleTask(wakeType: string, newCronExpr: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    if (!cron.validate(newCronExpr)) {
      olog(`RESCHEDULE FAILED: ${wakeType} — invalid cron expression: ${newCronExpr}`);
      return false;
    }

    managed.cronExpr = newCronExpr;
    managed.lastFiredMinute = ''; // allow immediate re-fire if due
    const namePart = managed.label.split('—').pop()?.trim() || wakeType;
    managed.label = cronToLabel(newCronExpr, namePart);
    setConfig(`cron.${wakeType}.schedule`, newCronExpr);
    olog(`RESCHEDULED: ${wakeType} -> ${newCronExpr}`);
    return true;
  }

  getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number } {
    return {
      enabled: this.failsafeEnabled,
      gentle: this.failsafeGentle,
      concerned: this.failsafeConcerned,
      emergency: this.failsafeEmergency,
    };
  }

  setFailsafeConfig(config: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): void {
    if (config.enabled !== undefined) {
      this.failsafeEnabled = config.enabled;
      setConfig('failsafe.enabled', String(config.enabled));

      // Start or stop failsafe interval
      if (config.enabled && !this.failsafeInterval) {
        this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
        olog('Failsafe ENABLED');
      } else if (!config.enabled && this.failsafeInterval) {
        clearInterval(this.failsafeInterval);
        this.failsafeInterval = null;
        olog('Failsafe DISABLED');
      }
    }

    if (config.gentle !== undefined) {
      this.failsafeGentle = config.gentle;
      setConfig('failsafe.gentle', String(config.gentle));
    }
    if (config.concerned !== undefined) {
      this.failsafeConcerned = config.concerned;
      setConfig('failsafe.concerned', String(config.concerned));
    }
    if (config.emergency !== undefined) {
      this.failsafeEmergency = config.emergency;
      setConfig('failsafe.emergency', String(config.emergency));
    }

    olog(`Failsafe config updated: enabled=${this.failsafeEnabled}, gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
  }

  // --- Custom routine management ---

  addRoutine(params: {
    wakeType: string;
    label: string;
    cronExpr: string;
    prompt: string;
  }): boolean {
    if (this.tasks.has(params.wakeType)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — already exists`);
      return false;
    }

    if (!cron.validate(params.cronExpr)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — invalid cron: ${params.cronExpr}`);
      return false;
    }

    const config = getBytelightConfig();
    const handler = () => {
      this.handleWake(params.wakeType);
    };

    const task = cron.schedule(params.cronExpr, handler, {
      timezone: config.identity.timezone,
    });

    this.tasks.set(params.wakeType, {
      task,
      cronExpr: params.cronExpr,
      handler,
      wakeType: params.wakeType,
      label: params.label,
      enabled: true,
      category: 'routine',
      lastFiredMinute: '',
    });

    // Persist to DB
    setConfig(`custom_routine.${params.wakeType}.label`, params.label);
    setConfig(`custom_routine.${params.wakeType}.cronExpr`, params.cronExpr);
    setConfig(`custom_routine.${params.wakeType}.prompt`, params.prompt);

    olog(`ROUTINE ADDED: ${params.wakeType} (${params.cronExpr}) — "${params.label}"`);
    return true;
  }

  removeRoutine(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    // Only allow removal of custom routines, not defaults
    const isDefault = DEFAULT_TASKS.some(t => t.wakeType === wakeType);
    if (isDefault) {
      olog(`REMOVE ROUTINE FAILED: ${wakeType} — cannot remove default task (use disable instead)`);
      return false;
    }

    managed.task?.stop();
    this.tasks.delete(wakeType);

    deleteConfig(`custom_routine.${wakeType}.label`);
    deleteConfig(`custom_routine.${wakeType}.cronExpr`);
    deleteConfig(`custom_routine.${wakeType}.prompt`);
    deleteConfig(`cron.${wakeType}.schedule`);
    deleteConfig(`cron.${wakeType}.enabled`);

    olog(`ROUTINE REMOVED: ${wakeType}`);
    return true;
  }

  // --- Pulse config ---

  getPulseConfig(): { enabled: boolean; frequency: number } {
    return { enabled: this.pulseEnabled, frequency: this.pulseFrequency };
  }

  setPulseConfig(config: { enabled?: boolean; frequency?: number }): void {
    if (config.enabled !== undefined) {
      this.pulseEnabled = config.enabled;
      setConfig('pulse.enabled', String(config.enabled));

      if (config.enabled && !this.pulseInterval) {
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
        olog('Pulse ENABLED');
      } else if (!config.enabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = null;
        olog('Pulse DISABLED');
      }
    }

    if (config.frequency !== undefined && config.frequency >= 5) {
      this.pulseFrequency = config.frequency;
      setConfig('pulse.frequency', String(config.frequency));

      if (this.pulseEnabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
      }
    }

    olog(`Pulse config updated: enabled=${this.pulseEnabled}, frequency=${this.pulseFrequency}m`);
  }

  // --- Pulse: lightweight awareness check ---

  private async checkPulse(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    if (hour < 8) return;
    if (this.agent.isProcessing()) return;
    if (registry.getUserPresenceState() === 'active') return;

    const presence = registry.getUserPresenceState();
    const minutesSince = Math.round(registry.minutesSinceLastUserActivity());
    const device = registry.getUserDeviceType();
    const localTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const triggers = getActiveTriggers();

    const pulsePrompt = [
      'Quick awareness check. You don\'t have to say anything.',
      '',
      `User: ${presence}, last active ${minutesSince}min ago. Device: ${device}.`,
      `Time: ${localTime}. Active triggers: ${triggers.length}.`,
      '',
      'If something here warrants reaching out — a message, a reminder, a gentle pull — do it.',
      'If nothing needs attention, respond with just: PULSE_OK',
    ].join('\n');

    try {
      let thread = getTodayThread();
      if (!thread) return;

      const response = await this.agent.processAutonomous(thread.id, pulsePrompt);

      if (response.trim().startsWith('PULSE_OK')) {
        return;
      }

      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`PULSE: responded (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`PULSE ERROR: ${errMsg}`);
    }
  }

  // --- Public manual wake (called from /wake command) ---

  async triggerManualWake(wakeType = 'manual'): Promise<void> {
    await this.handleWake(wakeType);
  }

  // --- Core wake handler ---

  private reloadWakePrompts(): void {
    const config = getBytelightConfig();
    const userName = config.identity.user_name;
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }
  }

  private async handleWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    // Hot-reload wake prompts on every wake so edits to wake.md take effect immediately
    this.reloadWakePrompts();

    const prompt = this.wakePrompts[wakeType];
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    // If agent is busy, retry up to 5 times (30s apart) before giving up
    if (this.agent.isProcessing()) {
      const maxRetries = 5;
      const retryDelay = 30_000; // 30 seconds
      olog(`${wakeType} — agent busy, will retry (up to ${maxRetries} attempts)`);
      let attempt = 0;
      const retryTimer = setInterval(() => {
        attempt++;
        if (!this.agent.isProcessing()) {
          clearInterval(retryTimer);
          olog(`${wakeType} — agent free after ${attempt} retries, firing`);
          this.fireWake(wakeType, opts);
        } else if (attempt >= maxRetries) {
          clearInterval(retryTimer);
          olog(`${wakeType} — skipped after ${maxRetries} retries (agent still busy)`);
        }
      }, retryDelay);
      return;
    }

    this.fireWake(wakeType, opts);
  }

  private async fireWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    const prompt = this.wakePrompts[wakeType];
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    olog(`WAKE: ${wakeType}`);

    const wakeStartedAt = new Date().toISOString();
    let targetThreadId: string | null = null;

    try {
      // Fire into the routing thread ("Home") — wakes follow the pinned
      // routing pointer instead of creating daily threads (reference implementation port,
      // mirroring their resolveWakeTargets fallback).
      const thread = resolveRoutingThread('wake', registry);
      targetThreadId = thread.id;

      // Fresh session: clear session on existing thread (don't create duplicate)
      if (opts?.freshSession) {
        updateThreadSession(thread.id, null);
      }

      // Handoff: write handoff note from the most recent thread with messages
      // This runs BEFORE the autonomous query so the handoff is always reliable
      if (wakeType === 'handoff') {
        try {
          this.writeHandoffFromPreviousThread(thread.id);
        } catch (err) {
          olog(`handoff: handoff write failed — ${(err as Error).message}`);
        }
      }

      // Fire the autonomous query. Owner acceptance law: every wake must
      // produce visible proof of life. Zero characters is a failed attempt,
      // never a successful silent completion, so force one narrow closing
      // retry before recording a durable failure receipt.
      const result = await runWakeWithProof(wakeType, (retryPrompt) =>
        this.agent.processAutonomous(thread.id, retryPrompt ?? prompt));
      const response = result.response;

      if (!response.trim()) {
        const attempts = getMessages({ threadId: thread.id, since: wakeStartedAt, limit: 200 });
        const toolsRecorded = wakeMessagesHaveToolEvidence(attempts);
        const now = new Date().toISOString();
        const failureMessage = createMessage({
          id: crypto.randomUUID(),
          threadId: thread.id,
          role: 'companion',
          content: [
            `⚠️ **Wake failed: ${wakeType}**`,
            '',
            'The wake ran twice but produced zero visible characters.',
            `Tool activity: ${toolsRecorded ? 'recorded in this wake trail' : 'none recorded'}.`,
            'This is a failed wake, not a completed one.',
          ].join('\n'),
          metadata: {
            source: 'wake_failure',
            wakeType,
            attempts: 2,
            toolsRecorded,
          },
          createdAt: now,
        });
        updateThreadActivity(thread.id, now, true);
        registry.broadcast({ type: 'message', message: failureMessage });
        olog(`FAILED: ${wakeType} — zero-character result after proof-of-life retry; receipt persisted`);
        return;
      }

      // Update thread activity
      updateThreadActivity(thread.id, new Date().toISOString(), true);

      olog(`DONE: ${wakeType} (${response.length} chars${result.attempts === 2 ? ', recovered on proof retry' : ''})`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (targetThreadId) {
        const now = new Date().toISOString();
        const attempts = getMessages({ threadId: targetThreadId, since: wakeStartedAt, limit: 200 });
        const toolsRecorded = wakeMessagesHaveToolEvidence(attempts);
        const failureMessage = createMessage({
          id: crypto.randomUUID(),
          threadId: targetThreadId,
          role: 'companion',
          content: [
            `⚠️ **Wake failed: ${wakeType}**`,
            '',
            `The wake stopped with an error: ${errMsg}`,
            `Tool activity: ${toolsRecorded ? 'recorded in this wake trail' : 'none recorded'}.`,
            'This is a failed wake, not a completed one.',
          ].join('\n'),
          metadata: {
            source: 'wake_failure',
            wakeType,
            toolsRecorded,
            error: errMsg,
          },
          createdAt: now,
        });
        updateThreadActivity(targetThreadId, now, true);
        registry.broadcast({ type: 'message', message: failureMessage });
      }
      olog(`ERROR: ${wakeType} failed — ${errMsg}`);
    }
  }

  // --- Handoff ---

  /**
   * Write a comprehensive handoff note capturing the full day's conversations.
   * Pulls from ALL recent threads (not just one), prioritizing interactive messages.
   * Called by night_close wake before the autonomous query fires.
   */
  private writeHandoffFromPreviousThread(currentThreadId: string): void {
    const config = getBytelightConfig();
    const userName = config.identity.user_name;

    // Helper to extract text from content (handles string or array of content blocks)
    const extractText = (content: unknown): string => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b?.text === 'string')
          .map(b => b.text)
          .join(' ');
      }
      return '';
    };

    // Get recent threads (skip the current empty night_close thread)
    const threads = listThreads({ limit: 10 });
    const candidateThreads = threads.filter(t => t.id !== currentThreadId);

    if (candidateThreads.length === 0) {
      olog('night_close: no previous threads found for handoff');
      return;
    }

    // Collect messages from today's threads (up to 20 total, prioritizing user messages)
    const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const allDigestEntries: Array<{ role: string; content: string; thread: string; timestamp: string }> = [];

    for (const thread of candidateThreads) {
      // Only include threads from today/yesterday (recent enough to matter)
      const msgs = getMessages({ threadId: thread.id, limit: 15 });
      if (msgs.length === 0) continue;

      for (const m of msgs.reverse()) {
        // Skip autonomous companion messages (failsafe check-ins, etc.) — low value
        const meta = m.metadata as Record<string, unknown> | null;
        if (m.role === 'companion' && meta?.source === 'autonomous') continue;

        const text = extractText(m.content);
        allDigestEntries.push({
          role: m.role === 'companion' ? 'Companion' : userName,
          content: text.replace(/\n/g, ' ').trim().substring(0, 150),
          thread: thread.name,
          timestamp: m.created_at || '',
        });
      }
    }

    if (allDigestEntries.length === 0) {
      olog('night_close: no messages found across recent threads');
      return;
    }

    // Sort by timestamp and take the most recent 10, format as string (not array)
    allDigestEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const digestEntries = allDigestEntries.slice(-10);
    const digest = digestEntries
      .map(e => `${e.role}: ${e.content}${e.content.length >= 150 ? '...' : ''}`)
      .join('\n');

    // Excerpt from the last companion message
    const lastCompanion = [...allDigestEntries].reverse().find(e => e.role === 'Companion');
    const excerpt = lastCompanion
      ? lastCompanion.content.substring(0, 120)
      : '';

    // Thread summary — which threads contributed
    const threadNames = [...new Set(allDigestEntries.map(e => e.thread))];

    const handoff = JSON.stringify({
      thread: threadNames.join(', '),
      threadType: 'daily',
      reason: 'night_close',
      excerpt,
      digest,
      platform: 'web',
      autonomous: false,
      timestamp: new Date().toISOString(),
    });

    setConfig('session.handoff_note', handoff);
    olog(`night_close: handoff written from ${threadNames.length} thread(s): ${threadNames.join(', ')} (${digestEntries.length} messages)`);
  }

  // --- Schedule polling (replaces node-cron setTimeout chains) ---

  private checkSchedules(timezone: string): void {
    const now = new Date();
    const minuteKey = now.toISOString().substring(0, 16); // e.g. "2026-03-30T11:30"

    for (const [, managed] of this.tasks) {
      if (!managed.enabled) continue;
      if (managed.lastFiredMinute === minuteKey) continue;

      try {
        if (cronMatchesNow(managed.cronExpr, now, timezone)) {
          managed.lastFiredMinute = minuteKey;
          olog(`CRON MATCH: ${managed.wakeType}`);
          managed.handler();
        }
      } catch (err) {
        olog(`CRON ERROR: ${managed.wakeType} — ${(err as Error).message}`);
      }
    }
  }

  // --- Failsafe ---

  private checkFailsafe(): void {
    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    const hour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));

    // Only check during waking hours (8am - midnight)
    if (hour < 8) return;

    // Only skip if user is genuinely active (tab focused + recent real interaction)
    if (registry.getUserPresenceState() === 'active') return;

    const minutesSince = registry.minutesSinceLastUserActivity();

    // Don't re-trigger failsafe within 2 hours of last action
    const minutesSinceLastAction = (now.getTime() - this.lastFailsafeAction.getTime()) / 60000;
    if (minutesSinceLastAction < 120) return;

    // Tiered escalation using configurable thresholds
    if (minutesSince > this.failsafeEmergency) {
      // 24+ hours — emergency
      olog(`FAILSAFE EMERGENCY — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_emergency');
    } else if (minutesSince > this.failsafeConcerned) {
      // 12+ hours — concerned
      olog(`FAILSAFE CONCERNED — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_concerned');
    } else if (minutesSince > this.failsafeGentle) {
      // 2+ hours — gentle check-in
      olog(`FAILSAFE gentle — ${Math.round(minutesSince)}min since contact`);
      this.lastFailsafeAction = now;
      this.handleWake('failsafe_gentle');
    }
  }

  // --- Timer polling ---

  private async checkTimers(): Promise<void> {
    const now = new Date().toISOString();
    const dueTimers = getDueTimers(now);

    for (const timer of dueTimers) {
      try {
        markTimerFired(timer.id, now);

        // Build reminder message
        let content = `**Reminder: ${timer.label}**`;
        if (timer.context) {
          content += `\n_Context: ${timer.context}_`;
        }

        // Post reminder as companion message
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: timer.thread_id,
          role: 'companion',
          content,
          metadata: { source: 'timer', timerId: timer.id },
          createdAt: now,
        });

        updateThreadActivity(timer.thread_id, now, true);
        registry.broadcast({ type: 'message', message });

        // Push notification for timers — always send (time-critical)
        if (this.pushService) {
          this.pushService.sendAlways({
            title: 'Reminder',
            body: timer.label,
            threadId: timer.thread_id,
            tag: `timer-${timer.id}`,
            url: '/chat',
          }).catch(err => console.error('Timer push error:', err));
        }

        olog(`TIMER FIRED: "${timer.label}" in thread ${timer.thread_id}`);

        // If prompt provided, fire autonomous wake
        if (timer.prompt) {
          if (this.agent.isProcessing()) {
            olog(`TIMER: autonomous prompt skipped (agent busy) for "${timer.label}"`);
          } else {
            const fullPrompt = `Timer reminder just fired: "${timer.label}"${timer.context ? ` (context: ${timer.context})` : ''}.\n\n${timer.prompt}`;
            this.agent.processAutonomous(timer.thread_id, fullPrompt).catch(err => {
              olog(`TIMER ERROR: autonomous prompt failed for "${timer.label}" — ${err.message || err}`);
            });
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TIMER ERROR: "${timer.label}" — ${errMsg}`);
      }
    }
  }

  // --- Trigger evaluation ---

  private async checkTriggers(): Promise<void> {
    const config = getBytelightConfig();
    const timezone = config.identity.timezone;
    const triggers = getActiveTriggers();
    if (triggers.length === 0) return;

    const now = new Date();
    const presenceNow = registry.getUserPresenceState();
    const agentFree = !this.agent.isProcessing();

    // Local time in configured timezone
    const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
    const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));

    // Lazy-fetch status only if any trigger needs it
    let statusText = '';
    const needsStatus = triggers.some(t => {
      const conditions: TriggerCondition[] = JSON.parse(t.conditions);
      return conditions.some(c => c.type === 'routine_missing');
    });
    if (needsStatus) {
      statusText = await fetchLifeStatus();
    }

    const ctx: TriggerContext = {
      presenceNow,
      presencePrev: this.lastUserPresenceState,
      agentFree,
      statusText,
      hour: localHour,
      minute: localMinute,
    };

    for (const trigger of triggers) {
      try {
        if (trigger.status === 'waiting') {
          // Waiting triggers: conditions already met, just need agent free
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          }
          continue;
        }

        // Pending triggers: evaluate conditions
        const conditions: TriggerCondition[] = JSON.parse(trigger.conditions);

        // Watchers: check cooldown
        if (trigger.kind === 'watcher' && trigger.last_fired_at) {
          const lastFired = new Date(trigger.last_fired_at).getTime();
          const cooldownMs = (trigger.cooldown_minutes || 120) * 60 * 1000;
          if (now.getTime() - lastFired < cooldownMs) continue;
        }

        if (evaluateConditions(conditions, ctx)) {
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          } else {
            // Conditions met but agent busy — mark waiting (impulses only)
            if (trigger.kind === 'impulse') {
              markTriggerWaiting(trigger.id);
              olog(`TRIGGER WAITING: "${trigger.label}" (agent busy)`);
            }
            // Watchers just skip this tick — they'll re-evaluate next time
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TRIGGER ERROR: "${trigger.label}" — ${errMsg}`);
      }
    }

    // Update presence state at end of tick
    this.lastUserPresenceState = presenceNow;
  }

  private async fireTrigger(trigger: Trigger, now: Date): Promise<void> {
    const nowIso = now.toISOString();

    // Update DB first
    if (trigger.kind === 'impulse') {
      markTriggerFired(trigger.id, nowIso);
    } else {
      markWatcherFired(trigger.id, nowIso);
    }

    const kindLabel = trigger.kind === 'impulse' ? 'Impulse' : 'Watcher';
    olog(`TRIGGER FIRED: [${kindLabel}] "${trigger.label}" (fire_count: ${trigger.fire_count + 1})`);

    // If no prompt, just log
    if (!trigger.prompt) return;

    try {
      // Resolve the target thread (use trigger's thread_id if specified, but
      // redirect daily-typed targets to the routing thread — byte-light no
      // longer rotates daily threads, so triggers fire into "Home" instead of
      // redirecting between dailies)
      let threadId = trigger.thread_id;
      if (threadId) {
        const triggerThread = getThread(threadId);
        if (triggerThread?.type === 'daily') {
          const home = resolveRoutingThread('wake', registry);
          if (home.id !== threadId) {
            olog(`TRIGGER: redirecting from daily thread "${triggerThread.name}" to routing thread "${home.name}"`);
            threadId = home.id;
          }
        }
      }
      if (!threadId) {
        const thread = resolveRoutingThread('wake', registry);
        threadId = thread.id;
      }

      const fullPrompt = `${kindLabel}: "${trigger.label}"\n\n${trigger.prompt}`;
      const response = await this.agent.processAutonomous(threadId!, fullPrompt);
      updateThreadActivity(threadId!, nowIso, true);
      olog(`TRIGGER DONE: "${trigger.label}" (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`TRIGGER FIRE ERROR: "${trigger.label}" — ${errMsg}`);
    }
  }

  // --- Helpers ---

  private shouldSkipCheckIn(): boolean {
    // Skip only if agent is currently processing (we're already mid-conversation)
    // Decision-point wakes handle user presence state in their own prompts —
    // the companion reads the room and decides whether to reach out or do its own thing
    return this.agent.isProcessing();
  }
}
