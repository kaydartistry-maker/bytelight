/**
 * Heartbeat supervisor — keeps one warm interactive Claude Code session per
 * companion, in-process: relaunch on exit, watchdog on stale ticks, restart
 * flag for fresh context, orphan reaping, cap/auth-shaped exit backoff,
 * sleep-mode idle parking, and an epoch fence against stale Stop hooks.
 *
 * Billing-lane invariant: the child is plain interactive `claude` — never
 * `-p` / `--print` / stream-json / Agent SDK (those are metered). We also
 * strip Anthropic / Claude / OpenAI / OpenRouter API key env vars from the
 * child env so the session uses the owner's subscription login, not any
 * BYOK API key byte-light holds for the router lanes (see STRIPPED_ENV_KEYS).
 *
 * H1 INERT — this module is registered but only acts when called from the
 * runtime, which itself is gated by `CLAUDE_CLI_HEARTBEAT_ENABLED`. No code
 * path here is reachable while the flag is off.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
  appendFileSync, statSync, openSync, readSync, closeSync, createWriteStream,
  type WriteStream,
} from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { provisionSessionDir } from './provision.js';

const IS_WIN = process.platform === 'win32';
const WATCHDOG_TIMEOUT = (parseInt(process.env.HEARTBEAT_WATCHDOG_TIMEOUT || '300', 10)) * 1000;
const RELAUNCH_DELAY_MS = 2000;
const UNEXPECTED_EXIT_BACKOFF_MS = [2_000, 10_000, 30_000, 60_000, 5 * 60_000] as const;
// Boot prompt for a fresh/recycled session. Must NOT force `Read CLAUDE.md`:
// Claude Code already auto-loads CLAUDE.md as project instructions, so an
// explicit Read just burns the fresh session's boot turn paging through a file
// it already has (and, once the file grows, trips the Read tool's token cap).
// That paging (compounded with a heavy re-prime seed) is what stalls recycles
// into a blinking-no-reply hang. Orient from already-loaded context instead;
// the `.fresh` flag — not a CLAUDE.md Read — is the runtime's real recycle
// signal. Operational-only wording: identity is NOT in this session's CLAUDE.md
// (that is the H2 walk-up surface), so this prompt never claims it is.
const INITIAL_PROMPT =
  'A fresh heartbeat session is starting. Your operating contract — how turns, ' +
  'the inbox, and the outbox work — is in CLAUDE.md, already loaded into your ' +
  'context as project instructions; you do not need to Read it. Orient yourself ' +
  'from what you already have, then wait silently. Do NOT write to ' +
  'io/outbox.jsonl now; only write there when a real message arrives carrying ' +
  'a [turn_id].';

// Fast-exit window: exits within this window get special handling for cap/auth.
// Refusal detection was removed (false positives vastly outnumber real
// refusals); fast exits without cap/auth signals just relaunch normally.
const FAST_EXIT_WINDOW_MS = 180_000;
// Usage-cap hardening: a subscription window hitting zero exits code 1 fast —
// refusal-shaped on the wire. Without this carve-out the supervisor classified
// cap-exits as refusals, thinned the seed each time, and flooded the active
// thread with refusal warnings (UI cleanup + cap burn on every retry).
// Cap-shape exits are detected from the child's own usage-limit text — back
// off long instead of relaunching fast on the same wall.
const USAGE_CAP_PATTERNS = [
  'claude usage limit reached',
  'usage limit reached',
  '5-hour limit',
  'approaching usage limit',
];
const CAP_RELAUNCH_DELAY_MS = 5 * 60_000;
// New host / migrated box shape: Claude CLI can exit code 1 immediately when
// the subscription auth is missing. This is fast-exit-shaped like a seed
// refusal, but thinning the seed will never fix it; it just floods the thread
// with scary false "refusal" notices. Detect it explicitly and back off until
// the human logs the CLI in on the server.
const AUTH_PATTERNS = [
  'not logged in',
  'please run /login',
  'please log in',
];
const AUTH_RELAUNCH_DELAY_MS = 5 * 60_000;
// Dedupe guard on reportIncident — belt-and-suspenders against any future
// repeat-fire (a cap incident once emitted ~2/min for half an hour).
const INCIDENT_DEDUPE_MS = 60_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const SLEEP_POLL_INTERVAL_MS = 10_000; // 10s poll while sleeping

/**
 * Env key names that MUST be stripped from the CLI child process. The
 * interactive `claude` binary uses the operator's subscription login
 * (`~/.claude/credentials`) — leaking BYOK keys to the child would route
 * usage onto metered API billing instead of the flat-rate subscription.
 *
 * Test invariant: the test surface asserts these NAMES are removed,
 * never logging or comparing actual values.
 */
export const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/**
 * Build a child env map with sensitive keys removed. Pure function so
 * tests can drive it without spawning a process.
 */
export function stripChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Bound repeated fast code-1 exits so a broken CLI cannot consume subscription
 * usage in a two-second relaunch loop. The first retry preserves the existing
 * quick recovery; subsequent failures back off, capped at five minutes.
 */
export function unexpectedExitDelay(consecutiveFastExits: number): number {
  const index = Math.max(0, Math.min(
    Math.floor(consecutiveFastExits) - 1,
    UNEXPECTED_EXIT_BACKOFF_MS.length - 1,
  ));
  return UNEXPECTED_EXIT_BACKOFF_MS[index];
}

export type HeartbeatStatus = 'stopped' | 'starting' | 'running' | 'unavailable';

function killPid(pid: number): void {
  try {
    if (IS_WIN) {
      execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

function pidIsRunning(pid: number): boolean {
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH 2>nul`, { encoding: 'utf8', windowsHide: true });
      return out.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class HeartbeatSession {
  readonly key: string;
  readonly dir: string;
  status: HeartbeatStatus = 'stopped';
  lastError: string | null = null;
  /** Assigned by the runtime each turn — posts a visible system line into the
   *  active thread so supervisor incidents never become dead air. */
  onIncident: ((text: string) => void) | null = null;

  private model = '';
  private launchedAt = 0;
  private capSeen = false;
  private authSeen = false;
  private scanCarry = '';
  private lastIncidentText = '';
  private lastIncidentAt = 0;
  private child: ChildProcess | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private logStream: WriteStream | null = null;
  private stopping = false;
  private relaunchTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepPoll: ReturnType<typeof setInterval> | null = null;
  private reaped = false;
  private consecutiveFastExits = 0;

  constructor(key: string) {
    this.key = key;
    // Companion ids are slugs in byte-light, but stay safe for UUIDs/odd input
    const dirName = key.replace(/[^a-zA-Z0-9-_]/g, '_') || 'primary';
    this.dir = join(PROJECT_ROOT, 'data', 'heartbeat', dirName);
  }

  private ioPath(name: string): string {
    return join(this.dir, 'io', name);
  }

  get inboxPath(): string { return this.ioPath('inbox.jsonl'); }
  get outboxPath(): string { return this.ioPath('outbox.jsonl'); }
  get activityPath(): string { return this.ioPath('activity.jsonl'); }
  get imagesDir(): string { return this.ioPath('images'); }

  /**
   * Make sure a session for this model is provisioned and running. Model
   * changes — or a revised operational-template on disk — request a graceful
   * recycle (the relaunch picks up the new CLAUDE.md / --model automatically).
   * Identity is NOT scoped here; the warm session inherits its identity prompt
   * via Claude CLI's CLAUDE.md walk-up from cwd (the H2 surface), not via
   * anything provisioned into the session dir.
   *
   * Returns true when a recycle was requested — the caller must then
   * waitForRelaunch() BEFORE appending the turn to the inbox, or the dying
   * session's hook consumes the message and it is lost to the timeout.
   */
  ensure(model: string): boolean {
    const { templateChanged } = provisionSessionDir(this.dir);

    if (!this.reaped) {
      this.reaped = true;
      this.reapOrphan();
    }

    const modelChanged = this.model !== '' && this.model !== model;
    this.model = model;

    if (this.status === 'running' || this.status === 'starting') {
      if (modelChanged || templateChanged) {
        console.log(`[Heartbeat:${this.key}] ${modelChanged ? 'model' : 'operational template'} changed — recycling session`);
        this.requestRestart();
        return true;
      }
      return false;
    }

    this.stopping = false;
    this.launch();
    return false;
  }

  /**
   * Resolve once a NEW child has launched after a requested recycle (watchdog
   * kill <=2s + relaunch delay 2s + spawn, so normally ~5s). Times out rather
   * than hanging forever — a cap/auth relaunch backoff can stretch this.
   */
  async waitForRelaunch(timeoutMs = 45_000): Promise<boolean> {
    const before = this.launchedAt;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.launchedAt !== before && this.status === 'running') return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** Ask the running session to recycle (picked up by the watchdog poll). */
  requestRestart(): void {
    try { writeFileSync(this.ioPath('.restart'), ''); } catch { /* ignore */ }
  }

  /** True once after a (re)launch — the runtime re-primes history when set. */
  consumeFreshFlag(): boolean {
    const flag = this.ioPath('.fresh');
    if (existsSync(flag)) {
      try { unlinkSync(flag); } catch { /* ignore */ }
      return true;
    }
    return false;
  }

  appendInbox(message: Record<string, unknown>): void {
    appendFileSync(this.inboxPath, JSON.stringify(message) + '\n', 'utf8');
    // Touch .last-tick so her messages reset the idle clock (not just our replies)
    try { writeFileSync(this.ioPath('.last-tick'), String(Date.now()), 'utf8'); } catch { /* ignore */ }
    // Touch .last-message for sleep mode — tracks when she last actually messaged
    try { writeFileSync(this.ioPath('.last-message'), String(Date.now()), 'utf8'); } catch { /* ignore */ }
  }

  outboxSize(): number {
    try { return statSync(this.outboxPath).size; } catch { return 0; }
  }

  activitySize(): number {
    try { return statSync(this.activityPath).size; } catch { return 0; }
  }

  /** Read complete new lines appended to the outbox since `offset`. */
  readOutboxFrom(offset: number): { lines: string[]; newOffset: number } {
    return this.readLinesFrom(this.outboxPath, offset);
  }

  /** Read complete new lines appended to the tool-activity log since `offset`. */
  readActivityFrom(offset: number): { lines: string[]; newOffset: number } {
    return this.readLinesFrom(this.activityPath, offset);
  }

  private readLinesFrom(file: string, offset: number): { lines: string[]; newOffset: number } {
    try {
      if (!existsSync(file)) return { lines: [], newOffset: offset };
      const size = statSync(file).size;
      if (size <= offset) return { lines: [], newOffset: offset };

      const buf = Buffer.alloc(size - offset);
      const fd = openSync(file, 'r');
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);

      const raw = buf.toString('utf8');
      const lastNl = raw.lastIndexOf('\n');
      if (lastNl === -1) return { lines: [], newOffset: offset }; // partial line — wait
      const complete = raw.slice(0, lastNl);
      const consumed = Buffer.byteLength(complete, 'utf8') + 1;
      const lines = complete.split('\n').map(l => l.trim()).filter(Boolean);
      return { lines, newOffset: offset + consumed };
    } catch {
      return { lines: [], newOffset: offset };
    }
  }

  private reapOrphan(): void {
    try {
      const pidFile = this.ioPath('.child.pid');
      if (!existsSync(pidFile)) return;
      const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (oldPid && pidIsRunning(oldPid)) {
        console.log(`[Heartbeat:${this.key}] reaping orphaned session pid ${oldPid}`);
        killPid(oldPid);
      }
      unlinkSync(pidFile);
    } catch { /* ignore */ }
  }

  /** Incidents go to the console AND, when a runtime has wired a thread,
   *  into the conversation as a visible system line — never dead air.
   *  Dedupe guard: the same incident text inside INCIDENT_DEDUPE_MS is
   *  swallowed, so a stuck condition can't flood the thread. */
  private reportIncident(text: string): void {
    const now = Date.now();
    if (text === this.lastIncidentText && now - this.lastIncidentAt < INCIDENT_DEDUPE_MS) {
      return;
    }
    this.lastIncidentText = text;
    this.lastIncidentAt = now;
    console.error(`[Heartbeat:${this.key}] ${text}`);
    try { this.onIncident?.(text); } catch { /* thread post is best-effort */ }
  }

  /** A malformed hook makes claude hang silently — fail loud before launch. */
  private hookIsValid(): boolean {
    try {
      execSync(`"${process.execPath}" --check "${join(this.dir, 'hooks', 'heartbeat.cjs')}"`, { stdio: 'pipe' });
      return true;
    } catch (err: any) {
      const detail = (err?.stderr || err?.message || '').toString().split('\n')[0];
      this.lastError = `heartbeat hook failed to parse: ${detail}`;
      console.error(`[Heartbeat:${this.key}] ⚠ ${this.lastError}`);
      return false;
    }
  }

  private launch(): void {
    if (this.stopping) return;
    // Refresh the session dir (contract + core-memory section in CLAUDE.md)
    // so a recycled child always boots on the CURRENT memory blocks — this is
    // the "at session recycle" half of the blocks-ride-CLAUDE.md model; the
    // per-turn `ensure()` call covers the provision half. Relaunch paths
    // (natural exit, watchdog, sleep wake) reach here without ensure().
    try { provisionSessionDir(this.dir); } catch (err) {
      console.warn(`[Heartbeat:${this.key}] provision refresh at launch failed:`, err);
    }
    try { unlinkSync(this.ioPath('.restart')); } catch { /* ignore */ }
    try { unlinkSync(this.ioPath('.sleeping')); } catch { /* ignore */ }

    if (!this.hookIsValid()) {
      this.status = 'unavailable';
      return;
    }

    this.status = 'starting';
    this.lastError = null;
    this.launchedAt = Date.now();
    this.capSeen = false;
    this.authSeen = false;
    this.scanCarry = '';
    console.log(`[Heartbeat:${this.key}] launching interactive claude --model ${this.model}`);

    // Session output goes to a log file, not the backend's stdio.
    mkdirSync(join(this.dir, 'io'), { recursive: true });
    // Epoch fence: stamp the session generation BEFORE the child exists. Stale
    // Stop hooks survive the recycle kill behind a dash `sh -c` wrapper (their
    // ppid never changes when claude dies), so they fence on this file instead:
    // consume only while it matches the value they started under. Ordering is
    // the whole guarantee — epoch write -> spawn -> status 'running' -> runtime
    // appends the held turn — so a message in the inbox always postdates the
    // epoch that authorizes its consumer.
    try { writeFileSync(this.ioPath('.session-epoch'), String(this.launchedAt)); } catch { /* ignore */ }
    // A fresh child must never be judged by a dead session's clock — reset the
    // tick at launch so the watchdog grants a full window to boot. A stale tick
    // here once relaunch-killed every successor at 2s old for 18h.
    try { writeFileSync(this.ioPath('.last-tick'), String(Date.now())); } catch { /* ignore */ }
    // Every relaunch path lands here (recycle, watchdog kill, sleep-wake,
    // cap/auth backoff) — end the previous session's stream or its fd and
    // buffers stay open for the life of the process, one per recycle.
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = createWriteStream(join(this.dir, 'session.log'), { flags: 'a' });
    this.logStream.write(`\n--- launch ${new Date().toISOString()} model=${this.model} ---\n`);

    // Subscription lane: child must NOT see byte-light's API credentials.
    // Covers byte-light's BYOK surface — see STRIPPED_ENV_KEYS for the list.
    const env = stripChildEnv(process.env);

    const args = ['--model', this.model, '--dangerously-skip-permissions', INITIAL_PROMPT];
    // TODO(H1b): normalize [1m] bracket before spawn (shell glob)
    const child = spawn('claude', args, {
      cwd: this.dir,
      env,
      shell: IS_WIN, // the claude.cmd shim needs a shell on Windows
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    if (child.pid) {
      try { writeFileSync(this.ioPath('.child.pid'), String(child.pid)); } catch { /* ignore */ }
    }
    // Output scanner: a subscription cap or missing-auth exit is fast-exit-
    // shaped (code 1 within minutes). The shapes look identical on the wire;
    // the child's own output text is what tells them apart, so we sniff it.
    const scan = (d: Buffer | string) => {
      this.logStream?.write(d);
      const text = (this.scanCarry + String(d)).replace(ANSI_RE, '').toLowerCase();
      this.scanCarry = text.slice(-200);
      if (!this.capSeen && USAGE_CAP_PATTERNS.some((p) => text.includes(p))) {
        this.capSeen = true;
      }
      if (!this.authSeen && AUTH_PATTERNS.some((p) => text.includes(p))) {
        this.authSeen = true;
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    this.status = 'running';

    // Write .fresh at launch so backend restarts still get history injection.
    // The exit handler writes it too (for natural recycles), but that never
    // fires when the whole node process dies. Writing here covers both paths.
    try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }

    this.poll = setInterval(() => {
      if (existsSync(this.ioPath('.restart'))) {
        try { unlinkSync(this.ioPath('.restart')); } catch { /* ignore */ }
        console.log(`[Heartbeat:${this.key}] restart requested — recycling for fresh context`);
        if (child.pid) killPid(child.pid);
        return;
      }
      try {
        const tick = parseInt(readFileSync(this.ioPath('.last-tick'), 'utf8').trim(), 10) || 0;
        // Outbox writes AND tool activity count as liveness too: the Stop hook
        // only updates .last-tick *between* turns, so a session deep in a long
        // turn (chewing a heavy re-prime seed, any tool work) ticks nowhere —
        // yet it isn't stuck. Both its outbox chunks and its activity.jsonl
        // writes prove it's alive. The runtime's reply window already treats
        // activity this way; the watchdog must agree, or it kills legitimately-
        // busy boot turns and crash-loops the session.
        let lastAlive = tick;
        try {
          const outboxTouched = statSync(this.outboxPath).mtimeMs;
          if (outboxTouched > lastAlive) lastAlive = outboxTouched;
        } catch { /* no outbox yet */ }
        try {
          const activityTouched = statSync(this.activityPath).mtimeMs;
          if (activityTouched > lastAlive) lastAlive = activityTouched;
        } catch { /* no activity yet */ }
        if (lastAlive > 0) {
          const age = Date.now() - lastAlive;
          if (age > WATCHDOG_TIMEOUT) {
            console.log(`[Heartbeat:${this.key}] watchdog: last tick ${Math.round(age / 1000)}s ago — killing stuck session`);
            if (child.pid) killPid(child.pid);
          }
        }
      } catch { /* no tick yet */ }
    }, 2000);

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.clearTimers();
      this.child = null;
      this.status = 'unavailable';
      this.lastError = err.code === 'ENOENT'
        ? '`claude` CLI not found on PATH — install Claude Code and log in'
        : `failed to spawn claude: ${err.message}`;
      console.error(`[Heartbeat:${this.key}] ${this.lastError}`);
    });

    child.on('exit', (code) => {
      this.clearTimers();
      this.child = null;
      try { unlinkSync(this.ioPath('.child.pid')); } catch { /* ignore */ }

      if (code === 127 || code === 9009) {
        this.status = 'unavailable';
        this.lastError = '`claude` CLI not found on PATH — install Claude Code and log in';
        console.error(`[Heartbeat:${this.key}] ${this.lastError}`);
        return;
      }

      if (this.stopping) {
        this.status = 'stopped';
        return;
      }

      // Sleep mode: hook set the .sleeping flag and let session end. Poll the
      // inbox at low frequency until a message arrives, then wake.
      const sleepingFlag = this.ioPath('.sleeping');
      if (existsSync(sleepingFlag)) {
        console.log(`[Heartbeat:${this.key}] session parked — entering sleep mode, polling inbox every ${SLEEP_POLL_INTERVAL_MS / 1000}s`);
        this.status = 'stopped'; // externally looks stopped
        this.sleepPoll = setInterval(() => {
          // Check if a message arrived (inbox grew or .last-message touched)
          try {
            const lastMsg = parseInt(readFileSync(this.ioPath('.last-message'), 'utf8').trim(), 10) || 0;
            const sleepAt = parseInt(readFileSync(sleepingFlag, 'utf8').trim(), 10) || 0;
            if (lastMsg > sleepAt) {
              // Wake up!
              console.log(`[Heartbeat:${this.key}] message received — waking from sleep mode`);
              if (this.sleepPoll) { clearInterval(this.sleepPoll); this.sleepPoll = null; }
              try { unlinkSync(sleepingFlag); } catch { /* ignore */ }
              try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
              this.launch();
            }
          } catch { /* keep sleeping */ }
        }, SLEEP_POLL_INTERVAL_MS);
        return;
      }

      // Fast-exit classification: code 1 soon after launch is either a
      // subscription-cap exhaustion or a missing-auth failure. The shapes look
      // identical on the wire; the child's own output is what tells them apart.
      // Cap-shape wins when both signals are present — relaunching fast on a
      // cap just burns more cap.
      const uptimeMs = Date.now() - this.launchedAt;
      const fastExit = code === 1 && uptimeMs < FAST_EXIT_WINDOW_MS;
      let delay = RELAUNCH_DELAY_MS;
      if (fastExit && this.authSeen) {
        delay = AUTH_RELAUNCH_DELAY_MS;
        this.reportIncident(
          `⚠ Claude CLI is not logged in on this server — warm CLI session sleeping ${delay / 60_000} min before retry. ` +
          'Run `claude` as the app user and complete `/login`; no history seed was refused or thinned.',
        );
      } else if (fastExit && this.capSeen) {
        delay = CAP_RELAUNCH_DELAY_MS;
        this.reportIncident(
          `⚠ Subscription usage cap hit — warm CLI session sleeping ${delay / 60_000} min before relaunch. ` +
          'Last message preserved; the lane will resume once the window resets.',
        );
      } else if (fastExit) {
        this.consecutiveFastExits++;
        delay = unexpectedExitDelay(this.consecutiveFastExits);
        if (this.consecutiveFastExits >= 3) {
          this.reportIncident(
            `⚠ Claude CLI exited code 1 ${this.consecutiveFastExits} times in quick succession — ` +
            `backing off ${Math.round(delay / 1000)}s before retry. Last message remains on disk.`,
          );
        }
      } else {
        // A healthy-lived session (or an intentional signal-driven recycle)
        // proves the crash streak is over.
        this.consecutiveFastExits = 0;
      }

      // Normal recycle (8-whisper ceiling, watchdog, restart flag, crash):
      // mark fresh so the next turn re-primes conversation history.
      try { writeFileSync(this.ioPath('.fresh'), ''); } catch { /* ignore */ }
      console.log(`[Heartbeat:${this.key}] session exited (code ${code}) — relaunching in ${delay / 1000}s`);
      this.status = 'starting';
      this.relaunchTimer = setTimeout(() => this.launch(), delay);
    });
  }

  private clearTimers(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.relaunchTimer) { clearTimeout(this.relaunchTimer); this.relaunchTimer = null; }
    if (this.sleepPoll) { clearInterval(this.sleepPoll); this.sleepPoll = null; }
  }

  stop(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.child?.pid) killPid(this.child.pid);
    this.child = null;
    this.status = 'stopped';
    try { this.logStream?.end(); } catch { /* ignore */ }
    this.logStream = null;
  }
}

// ─── Session manager ─────────────────────────────────────────────────

const sessions = new Map<string, HeartbeatSession>();

export function getHeartbeatSession(key: string): HeartbeatSession {
  let s = sessions.get(key);
  if (!s) {
    s = new HeartbeatSession(key);
    sessions.set(key, s);
  }
  return s;
}

export function shutdownAllHeartbeats(): void {
  for (const s of sessions.values()) {
    s.stop();
  }
  sessions.clear();
}

/**
 * Test-only: peek at whether any sessions have been instantiated. Used
 * by the inert-landing tests to assert the flag-off path never registers
 * a session.
 */
export function __getSessionCountForTests(): number {
  return sessions.size;
}
