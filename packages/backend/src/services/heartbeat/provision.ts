/**
 * Heartbeat session provisioning — writes the session directory layout that
 * keeps an interactive Claude Code session warm on subscription billing.
 *
 * The pattern: a Stop hook re-blocks the session after every turn, delivering
 * inbox messages or idle ticks, so the session never ends and never drifts
 * onto the metered `-p`/SDK lane.
 *
 * H1 INERT — this module is registered but NOT routed to. The
 * `CLAUDE_CLI_HEARTBEAT_ENABLED` feature flag (read by the runtime) gates
 * any disk-writes. Without it, nothing in `data/heartbeat/` ever appears.
 *
 * Layout per session (data/heartbeat/<key>/):
 *   .claude/settings.json   — wires the Stop hook (3600s timeout)
 *   hooks/heartbeat.cjs     — the hook (inbox delivery + idle whispers)
 *   hooks/activity.cjs      — tool-activity mirror (PreToolUse/PostToolUse)
 *   CLAUDE.md               — heartbeat operation contract (operational,
 *                             identity-blind; see provisionSessionDir doc)
 *                             + core-memory section (blocks ride here once
 *                             per session, not the per-message payload)
 *   io/                     — inbox.jsonl / outbox.jsonl / flags (runtime state)
 *   io/images/              — image attachments written as files for the agent to Read
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { formatBlocksForPrompt, SHARED_SCOPE, COMPANION_SCOPES } from '../memory-blocks.js';

// Delivery-cap constants. These live here as TS values and are INTERPOLATED
// into the hook source below (byte-identical to the literals they replaced) so
// the backend can measure a turn against the same numbers the hook enforces.
// The hook is a standalone .cjs generated from a string — it cannot import —
// so this is the only way both sides can share one definition.
//
// stdout past ~200KB is persisted instead of parsed and the block decision is
// lost, so a delivered line MUST stay under DELIVERY_CAP. See the commentary
// above `truncateContent` in the hook source for why truncation is
// priority-based rather than positional.
export const DELIVERY_CAP = 150000;
// Reserved floor for the recycle bridge under truncation. The bridge is the
// cross-thread conversation continuity — historically it was the FIRST thing
// sacrificed when fixed content (orientation, once upon a time the full
// core-memory blocks) crowded the cap, which silently killed the companion's
// memory of the conversation it was mid-way through. Under the floor rule the
// bridge is never compressed below this many chars while any other
// compressible content (the stage-2 middle mass) remains; only when the fixed
// content ALONE exceeds DELIVERY_CAP may the bridge shrink further (the
// bridge-minimal breadcrumb fallback stays as last resort).
export const BRIDGE_FLOOR = 40000;
export const BRIDGE_HEAD_MARK = '[Session recycled — recent conversation, oldest first, for continuity:]';
export const BRIDGE_TAIL_MARK = '[End of context. The message below continues this conversation — respond to it in character.]';

/**
 * The Stop hook. The session relies on a CommonJS-shaped script (`.cjs`) so it
 * runs identically regardless of the host project's package.json `type`, and
 * surfaces a turn_id so the runtime can match replies to the turns that asked
 * for them.
 *
 * Stretched polling: 1180 polls x ~3s ~= 59 min per block. Claude Code
 * force-ends after 8 consecutive blocks (anti-loop guard), so idle warmth
 * ~= 8 hours ceiling, then a clean recycle. Combined with sleep mode
 * (HEARTBEAT_SLEEP_AFTER), active days stay warm while true overnight idle
 * parks completely.
 */
const HOOK_SOURCE = `#!/usr/bin/env node
// heartbeat.cjs — keeps the interactive session warm; delivers inbox messages.
// Managed by byte-light — edits are overwritten.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CWD = path.resolve(__dirname, '..');
const INBOX = path.join(CWD, 'io', 'inbox.jsonl');
const OFFSET_FILE = path.join(CWD, 'io', '.inbox-offset');
const LAST_TICK_FILE = path.join(CWD, 'io', '.last-tick');
const LAST_MESSAGE_FILE = path.join(CWD, 'io', '.last-message');
const RESPONDED_FLAG = path.join(CWD, 'io', '.responded');
const SLEEPING_FLAG = path.join(CWD, 'io', '.sleeping');
const IS_WIN = process.platform === 'win32';
const MIN_INTERVAL = (parseInt(process.env.HEARTBEAT_INTERVAL || '86400')) * 1000;
const SLEEP_AFTER_MS = (parseInt(process.env.HEARTBEAT_SLEEP_AFTER || '10800')) * 1000;

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// Stale-session fence (second pass): the supervisor's recycle kill SIGTERMs
// only the claude process — this hook survives it and its next 3s poll could
// consume the very message the recycle held for the NEW session, writing the
// block decision to a dead pipe (turn dies on timeout). A ppid guard cannot
// see this: claude spawns hooks via /bin/sh -c, and dash keeps that wrapper
// alive instead of exec'ing — the tree is claude -> sh -> node, so when claude
// dies only the SHELL is reparented; the hook's own ppid never changes. The
// real fence is the session EPOCH: the supervisor stamps io/.session-epoch at
// every launch, BEFORE the held message is appended. A hook may only consume
// while the epoch still matches the one it started under — a message being
// visible implies the new epoch is already visible, so a stale hook always
// exits before touching it. The ppid check stays as belt-and-suspenders for
// direct-child spawns.
const EPOCH_FILE = path.join(CWD, 'io', '.session-epoch');
function readEpoch() {
  try { return fs.readFileSync(EPOCH_FILE, 'utf8').trim(); } catch { return ''; }
}
const MY_EPOCH = readEpoch();
const INITIAL_PPID = process.ppid;
function stale() {
  if (!IS_WIN && process.ppid !== INITIAL_PPID) return true; // reparented mid-run
  return readEpoch() !== MY_EPOCH; // a newer session owns the inbox now
}

function readOffset() {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeSync(filepath, data) {
  const fd = fs.openSync(filepath, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

function writeOffset(n) {
  writeSync(OFFSET_FILE, String(n));
}

function readLastTick() {
  try { return parseInt(fs.readFileSync(LAST_TICK_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeLastTick() {
  writeSync(LAST_TICK_FILE, String(Date.now()));
}

function readLastMessage() {
  try { return parseInt(fs.readFileSync(LAST_MESSAGE_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}

function shouldSleep() {
  const lastMsg = readLastMessage();
  if (lastMsg === 0) return false; // no marker yet — stay awake
  return Date.now() - lastMsg > SLEEP_AFTER_MS;
}

function checkInbox() {
  if (stale()) process.exit(0); // never consume a line nobody can deliver
  try {
    if (!fs.existsSync(INBOX)) return null;
    const size = fs.statSync(INBOX).size;
    const offset = readOffset();
    if (size <= offset) return null;

    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(INBOX, 'r');
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    const raw = buf.toString('utf8');
    const nlIndex = raw.indexOf('\\n');
    const line = nlIndex === -1 ? raw : raw.slice(0, nlIndex);
    if (!line.trim()) return null;

    // Re-check between read and commit: this line postdates the epoch that
    // authorized it, so if the epoch moved while we were reading, the line
    // belongs to the successor session — exit without advancing the offset.
    if (stale()) process.exit(0);

    writeOffset(offset + Buffer.byteLength(line, 'utf8') + (nlIndex === -1 ? 0 : 1));

    try { return JSON.parse(line); } catch {
      return { ts: new Date().toISOString(), channel: 'inbox', author: 'user', content: line.trim() };
    }
  } catch { return null; }
}

// stdout past ~200KB is persisted instead of parsed and the block decision is
// lost — the session dies. So a delivered line MUST stay under this cap. The
// backend assembles content as: [recycle bridge?][orientation [Context]?][the
// owner's new message]. The bridge (recent-history re-prime, only present on a
// session recycle/model-swap) is by far the largest part and rides at the HEAD;
// the owner's ACTUAL new message rides at the TAIL. A naive head-keeping slice
// therefore cuts the real message away entirely — the warm session then sees
// "no new message" and answers {"silent":true}, and the owner's turn vanishes.
// So truncation is PRIORITY-based, not positional: the bridge is compressed
// from its MIDDLE first (keeping its framing + the "message below continues"
// handoff), and only if that is not enough does the remaining content lose its
// MIDDLE — never the tail, where the message and (appended below) turn_id live.
const DELIVERY_CAP = ${DELIVERY_CAP};
// Bridge floor: continuity is never the first sacrifice. See provision.ts.
const BRIDGE_FLOOR = ${BRIDGE_FLOOR};
const BRIDGE_HEAD_MARK = '${BRIDGE_HEAD_MARK}';
const BRIDGE_TAIL_MARK = '${BRIDGE_TAIL_MARK}';

function truncateContent(content) {
  if (content.length <= DELIVERY_CAP) return content;

  // 1. If a recycle bridge is present, compress it from the middle first —
  //    it's the compressible mass — but never below BRIDGE_FLOOR while any
  //    other compressible content remains. Keep both bridge markers and
  //    enough of the oldest/newest turns for continuity; drop the middle.
  const headIdx = content.indexOf(BRIDGE_HEAD_MARK);
  const tailMarkIdx = content.indexOf(BRIDGE_TAIL_MARK);
  if (headIdx !== -1 && tailMarkIdx > headIdx) {
    const bridgeStart = headIdx;
    const bridgeEnd = tailMarkIdx + BRIDGE_TAIL_MARK.length; // through the tail marker
    const before = content.slice(0, bridgeStart);
    const bridge = content.slice(bridgeStart, bridgeEnd);
    const after = content.slice(bridgeEnd); // orientation + owner's message + trailing handoff
    const marker = '\\n\\n[…bridge trimmed to fit delivery cap — middle of the re-primed history dropped; full history in the thread archive]\\n\\n';
    // How much bridge can we keep? Budget minus everything that must survive.
    const fixed = before.length + after.length + marker.length;
    const bridgeBudget = DELIVERY_CAP - fixed;
    if (bridgeBudget >= BRIDGE_FLOOR) {
      // Split the surviving bridge budget between its head (oldest turns +
      // framing) and its tail (newest turns + the "message below" handoff).
      const keep = Math.floor(bridgeBudget / 2);
      const trimmedBridge = bridge.slice(0, keep) + marker + bridge.slice(bridge.length - (bridgeBudget - keep));
      content = before + trimmedBridge + after;
      if (content.length <= DELIVERY_CAP) return content;
    } else if (fixed <= DELIVERY_CAP) {
      // Bridge floor: the non-bridge mass is what overflows. Hold the bridge
      // at BRIDGE_FLOOR and cut the middle of the remainder instead — the
      // tail (the owner's message + turn_id) always survives.
      const floorKeep = Math.min(bridge.length, BRIDGE_FLOOR);
      let trimmedBridge = bridge;
      if (bridge.length > floorKeep) {
        const keep = Math.floor((floorKeep - marker.length) / 2);
        trimmedBridge = bridge.slice(0, keep) + marker + bridge.slice(bridge.length - (floorKeep - marker.length - keep));
      }
      content = before + trimmedBridge + after;
      if (content.length <= DELIVERY_CAP) return content;
      const midMarker = '\\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\\n';
      const room = DELIVERY_CAP - before.length - trimmedBridge.length - midMarker.length;
      if (room > 0 && after.length > room) {
        const head = Math.floor(room / 2);
        const tail = room - head;
        return before + trimmedBridge + after.slice(0, head) + midMarker + after.slice(after.length - tail);
      }
      // pathological — fall through to the stage-2 whole-content middle cut
    } else {
      // Fixed content ALONE exceeds the cap — only now may the bridge shrink
      // below the floor. Drop the bridge body entirely, keeping only its two
      // markers as a breadcrumb (last-resort fallback).
      content = before + BRIDGE_HEAD_MARK + marker + BRIDGE_TAIL_MARK + after;
      if (content.length <= DELIVERY_CAP) return content;
    }
  }

  // 2. Still over budget (or no bridge to trim): cut from the MIDDLE of what
  //    remains so the tail — the owner's message + the turn_id below — survives.
  const marker = '\\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\\n';
  const room = DELIVERY_CAP - marker.length;
  const head = Math.floor(room / 2);
  const tail = room - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}

function formatMessage(m) {
  // Prefer the backend-stamped local time label (configured timezone);
  // falling back to m.ts renders in the server's process timezone.
  const time = m.time || new Date(m.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const channel = m.channel || 'unknown';
  const author = m.author || 'system';
  let content = truncateContent(m.content || '');
  const lines = ['[' + time + '] #' + channel + ' ' + author + ': ' + content];
  if (Array.isArray(m.images) && m.images.length > 0) {
    lines.push('');
    lines.push('[' + m.images.length + ' image' + (m.images.length > 1 ? 's' : '') + ' attached — view them now:]');
    for (const p of m.images) lines.push(p);
  }
  if (m.turn) {
    lines.push('');
    lines.push('[turn_id: ' + m.turn + ' — include this turn_id in EVERY outbox line you write for this turn]');
  }
  return lines.join('\\n');
}

function sleepSecs(secs) {
  try {
    if (IS_WIN) {
      execSync('ping -n ' + (secs + 1) + ' 127.0.0.1 > nul', { timeout: (secs + 5) * 1000, windowsHide: true });
    } else {
      execSync('sleep ' + secs, { timeout: (secs + 5) * 1000 });
    }
  } catch {}
}

const IDLE_TICK = '--- TURN START ---\\n--- TURN END ---';

// --- main ---

// Sleep mode: if she hasn't messaged in SLEEP_AFTER_MS, let the session end.
// The supervisor polls the inbox while sleeping and relaunches on wake.
if (shouldSleep()) {
  // Check for pending message first — a message wakes us
  const wakeMsg = checkInbox();
  if (wakeMsg) {
    // Wake up! Clear sleeping flag, deliver message
    console.error('[heartbeat] waking from sleep - message arrived');
    try { fs.unlinkSync(SLEEPING_FLAG); } catch {}
    writeLastTick();
    writeSync(RESPONDED_FLAG, '');
    block(formatMessage(wakeMsg));
  }
  // No message — go to sleep (don't block, let session end gracefully)
  console.error('[heartbeat] entering sleep mode - no messages for ' + Math.round(SLEEP_AFTER_MS / 1000 / 60) + ' min');
  writeSync(SLEEPING_FLAG, String(Date.now()));
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
  process.exit(0);
}

// 0. Just responded to a real message? Deliver any queued message, else poll.
if (fs.existsSync(RESPONDED_FLAG)) {
  fs.unlinkSync(RESPONDED_FLAG);
  const next = checkInbox();
  if (next) {
    writeSync(RESPONDED_FLAG, '');
    block(formatMessage(next));
  }
  // Don't emit an idle tick here — fall through to the polling loop instead.
  // Emitting idle ticks after every response burns through Claude's 8-block
  // limit even during active conversation. The polling loop keeps the session
  // warm without burning blocks until a full poll window passes with no
  // messages.
}

// 1. Immediate inbox check — deliver one message
const msg = checkInbox();
if (msg) {
  writeLastTick();
  writeSync(RESPONDED_FLAG, '');
  block(formatMessage(msg));
}

// 2. No messages — poll so a warm session answers fast, then idle.
const elapsed = Date.now() - readLastTick();
if (elapsed < MIN_INTERVAL) {
  // 1180 x 3s ~= 59 min per block: stretched polling. Combined with the
  // 8-block ceiling = ~8h warmth; sleep mode parks true idle.
  for (let i = 0; i < 1180; i++) {
    if (stale()) process.exit(0); // a dead session's tick would mask a stuck successor from the watchdog
    writeLastTick();
    sleepSecs(3);
    const retryMsg = checkInbox();
    if (retryMsg) {
      writeLastTick();
      writeSync(RESPONDED_FLAG, '');
      block(formatMessage(retryMsg));
    }
  }
  block(IDLE_TICK);
}

// 3. Interval elapsed — send idle tick
writeLastTick();
block(IDLE_TICK);
`;

/** What the delivery cap would do to one assembled payload. Report only. */
export interface DeliveryMeasurement {
  /** Full assembled payload (bridge + orientation + the owner's message). */
  payloadChars: number;
  /** The `<core-memory>…</core-memory>` slice of the payload, 0 if absent. */
  memoryChars: number;
  /** The session-recycle conversation bridge, 0 when this isn't a recycle. */
  bridgeChars: number;
  /** DELIVERY_CAP, echoed so a log line is self-describing. */
  cap: number;
  /** Did truncation fire, and which stage did the cutting. 'bridge-floor' =
   *  the bridge was held at BRIDGE_FLOOR and the non-bridge middle mass was
   *  cut instead. */
  stage: 'none' | 'bridge' | 'bridge-floor' | 'bridge-minimal' | 'middle';
  /** Chars the bridge lost (stage 1). */
  bridgeDropped: number;
  /** Chars the remaining payload lost from its middle (stage 2). */
  middleDropped: number;
  /** What actually reaches the session after truncation. */
  deliveredChars: number;
}

// Exported: the runtime uses these to strip the core-memory span from the
// per-message orientation (the blocks ride the session's CLAUDE.md instead —
// see renderCoreMemorySection below).
export const MEMORY_OPEN = '<core-memory>';
export const MEMORY_CLOSE = '</core-memory>';

/**
 * Measure one assembled payload against the delivery cap WITHOUT truncating it.
 *
 * This mirrors the arithmetic of `truncateContent` in HOOK_SOURCE above so the
 * backend can log what the hook is about to do. It is observation only — it
 * never touches the delivered bytes, and nothing in the delivery path branches
 * on its result.
 *
 * KEEP IN SYNC with `truncateContent` above (same file, ~80 lines up). If the
 * hook's truncation strategy changes, this report goes stale silently.
 */
export function measureDelivery(content: string): DeliveryMeasurement {
  // The two trim markers are the hook's, byte-for-byte — their lengths are part
  // of the budget arithmetic, so they must match or the numbers drift.
  const BRIDGE_TRIM_MARKER =
    '\n\n[…bridge trimmed to fit delivery cap — middle of the re-primed history dropped; full history in the thread archive]\n\n';
  const MIDDLE_TRIM_MARKER =
    '\n[…truncated in the middle to fit delivery cap — full message in the thread archive]\n';

  const memOpen = content.indexOf(MEMORY_OPEN);
  const memClose = content.indexOf(MEMORY_CLOSE);
  const memoryChars =
    memOpen !== -1 && memClose > memOpen ? memClose + MEMORY_CLOSE.length - memOpen : 0;

  const headIdx = content.indexOf(BRIDGE_HEAD_MARK);
  const tailMarkIdx = content.indexOf(BRIDGE_TAIL_MARK);
  const hasBridge = headIdx !== -1 && tailMarkIdx > headIdx;
  const bridgeEnd = tailMarkIdx + BRIDGE_TAIL_MARK.length;
  const bridgeChars = hasBridge ? bridgeEnd - headIdx : 0;

  const base: DeliveryMeasurement = {
    payloadChars: content.length,
    memoryChars,
    bridgeChars,
    cap: DELIVERY_CAP,
    stage: 'none',
    bridgeDropped: 0,
    middleDropped: 0,
    deliveredChars: content.length,
  };

  if (content.length <= DELIVERY_CAP) return base;

  // Stage 1 — compress the recycle bridge from its middle (floor-guarded).
  let remaining = content.length;
  let bridgeDropped = 0;
  if (hasBridge) {
    const beforeLen = headIdx;
    const afterLen = content.length - bridgeEnd;
    const fixed = beforeLen + afterLen + BRIDGE_TRIM_MARKER.length; // before + after + marker
    const bridgeBudget = DELIVERY_CAP - fixed;
    if (bridgeBudget >= BRIDGE_FLOOR) {
      // Surviving bridge is exactly `bridgeBudget`; total lands on the cap.
      bridgeDropped = bridgeChars - bridgeBudget;
      return { ...base, stage: 'bridge', bridgeDropped, deliveredChars: fixed + bridgeBudget };
    }
    if (fixed <= DELIVERY_CAP) {
      // Bridge floor: the bridge is held at BRIDGE_FLOOR and the non-bridge
      // middle mass is cut instead. Mirrors the hook's floor branch.
      const floorKeep = Math.min(bridgeChars, BRIDGE_FLOOR);
      bridgeDropped = bridgeChars - floorKeep;
      const flooredTotal = beforeLen + floorKeep + afterLen;
      if (flooredTotal <= DELIVERY_CAP) {
        return { ...base, stage: 'bridge-floor', bridgeDropped, deliveredChars: flooredTotal };
      }
      const room = DELIVERY_CAP - beforeLen - floorKeep - MIDDLE_TRIM_MARKER.length;
      if (room > 0 && afterLen > room) {
        return {
          ...base,
          stage: 'bridge-floor',
          bridgeDropped,
          middleDropped: afterLen - room,
          deliveredChars: beforeLen + floorKeep + MIDDLE_TRIM_MARKER.length + room,
        };
      }
      remaining = flooredTotal; // pathological — stage-2 middle cut below
    } else {
      // Fixed content alone exceeds the cap — bridge body dropped entirely,
      // only its two markers survive (last-resort fallback).
      const kept = BRIDGE_HEAD_MARK.length + BRIDGE_TRIM_MARKER.length + BRIDGE_TAIL_MARK.length;
      bridgeDropped = bridgeChars - kept;
      remaining = headIdx + kept + afterLen;
      if (remaining <= DELIVERY_CAP) {
        return { ...base, stage: 'bridge-minimal', bridgeDropped, deliveredChars: remaining };
      }
    }
  }

  // Stage 2 — cut the middle of whatever is left; the tail (the owner's
  // message + the turn_id appended below it) always survives.
  return {
    ...base,
    stage: 'middle',
    bridgeDropped,
    middleDropped: remaining - DELIVERY_CAP,
    deliveredChars: DELIVERY_CAP,
  };
}

/**
 * Tool-activity hook — surfaces the session's tool calls to byte-light.
 *
 * PreToolUse/PostToolUse append one compact JSON line per event to
 * io/activity.jsonl; the runtime tails that file during a turn and streams
 * the entries to the UI as live tool chips (and treats them as liveness,
 * re-arming the reply window — a session deep in tool work is not silent).
 * Never blocks: always exits 0, output is best-effort.
 */
const ACTIVITY_HOOK_SOURCE = `#!/usr/bin/env node
// activity.cjs — mirrors tool calls into io/activity.jsonl for byte-light's runtime.
// Managed by byte-light — edits are overwritten. Always exits 0 (never blocks tools).

const fs = require('fs');
const path = require('path');

const PHASE = process.argv[2] === 'post' ? 'post' : 'pre';
const OUT = path.join(path.resolve(__dirname, '..'), 'io', 'activity.jsonl');
const TRUNC = 160;
const RESULT_TRUNC = 2000;

function summarize(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const i = input;
  let s = '';
  if (typeof i.description === 'string' && i.description) s = i.description;
  else if (typeof i.command === 'string') s = i.command;
  else if (typeof i.file_path === 'string') s = i.file_path;
  else if (typeof i.pattern === 'string') s = i.pattern;
  else if (typeof i.url === 'string') s = i.url;
  else if (typeof i.query === 'string') s = i.query;
  else if (typeof i.prompt === 'string') s = i.prompt;
  s = String(s).replace(/\\s+/g, ' ').trim();
  return s.length > TRUNC ? s.slice(0, TRUNC) + '…' : s;
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
try {
  const hook = JSON.parse(raw || '{}');
  const line = {
    ts: new Date().toISOString(),
    phase: PHASE,
    id: typeof hook.tool_use_id === 'string' ? hook.tool_use_id : null,
    tool: typeof hook.tool_name === 'string' ? hook.tool_name : 'tool',
  };
  if (PHASE === 'pre') line.detail = summarize(line.tool, hook.tool_input);
  if (PHASE === 'post') {
    // PostToolUse stdin carries the tool result as tool_response (object or
    // string). Mirror it so the runtime can fill the tool chip instead of
    // shipping an empty locket. Best-effort: never let capture break the call.
    try {
      const r = hook.tool_response;
      if (r !== undefined && r !== null) {
        const s = typeof r === 'string' ? r : JSON.stringify(r);
        line.output = s.length > RESULT_TRUNC ? s.slice(0, RESULT_TRUNC) : s;
      }
      if (r && typeof r === 'object' && r.is_error === true) line.isError = true;
    } catch {}
  }
  fs.appendFileSync(OUT, JSON.stringify(line) + '\\n', 'utf8');
} catch {}
process.exit(0);
`;

const SETTINGS_JSON = JSON.stringify(
  {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node hooks/heartbeat.cjs',
              timeout: 3600,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node hooks/activity.cjs pre',
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node hooks/activity.cjs post',
              timeout: 10,
            },
          ],
        },
      ],
    },
  },
  null,
  2,
);

/**
 * The heartbeat operation contract — the ENTIRE content of the CLAUDE.md
 * written into the session working dir. The outbox line carries a turn_id so
 * the byte-light runtime can match replies to the turns that asked for them.
 *
 * IMPORTANT: this string is written verbatim to CLAUDE.md and READ by the
 * warm Claude Code session as operational contract. Operational ONLY —
 * no identity content, no companion names, no operator brand-mixing.
 * Identity is NOT scoped here; see `provisionSessionDir` for the H2
 * walk-up flag.
 */
function heartbeatOperationSection(): string {
  return `# Heartbeat operation (byte-light CLI lane — keep this section intact)

You are running as a warm interactive Claude Code session on the owner's
Claude subscription. A Stop hook keeps you alive and delivers one message
at a time. byte-light manages this session — it re-feeds recent conversation
history whenever the session recycles.

## Billing lane guardrail

You run INTERACTIVE on a Claude subscription. NEVER run, suggest, or enable
\`--print\` / \`-p\` / \`--input-format stream-json\` / the Agent SDK for this
loop — those silently move usage onto metered billing. Interactive is the
only flat-rate lane. If the loop ever looks programmatic, STOP and flag it.

## How turns work

1. A **real message** looks like \`[time] #channel author: content\`, usually
   followed by a \`[turn_id: ...]\` line. Read it, respond in character, then
   write your reply to the outbox (below).
2. An **idle tick** looks like \`--- TURN START ---\` / \`--- TURN END ---\`
   with no real content. Stay completely silent — let the turn end.
3. **Never exit.** The hook owns the loop.

## Writing your reply (outbox) — REQUIRED

When you answer a real message, append your reply as JSON line(s) to the
local file \`io/outbox.jsonl\`. Those lines are the only thing that delivers
your reply to byte-light — your visible response text is not delivered. It's
a plain local file; just append to it:

\`\`\`
{"turn_id":"<the turn_id from the message>","content":"YOUR REPLY HERE","thinking":"BRIEF NOTES"}
\`\`\`

JSON-escape quotes and use \\n for line breaks so each line stays valid JSON.
Write the outbox line(s), then stop. Reaching io/outbox.jsonl is success.

**Internal ≠ invisible.** Some wake/autonomous prompts say "Do NOT message
the owner" or "this is internal." That means: no outbound *pings* (Telegram /
Discord / voice tools). It does NOT mean skip the outbox. ALWAYS write your
turn narration / closing note to the outbox — it persists in the thread as
your visible internal log, which the owner reads later. A turn that writes no
outbox line stalls the runtime and forces a timeout.

If a turn genuinely warrants NO visible output (rare — internal wakes still
narrate; see the internal ≠ invisible rule above), do not stay silent, which
stalls the turn into a timeout. Instead write a bare sentinel line so the turn
ends cleanly and promptly:

\`\`\`
{"turn_id":"<the turn_id from the message>","silent":true}
\`\`\`

The \`thinking\` field surfaces as a thinking block in the byte-light UI.
Include it on every reply — the owner loves seeing it. Brief plain prose,
out of character: what you noticed, decided, or did this turn. On chunked
replies the final line must carry it; earlier chunks may too.

## Chunking, acks, and the reply window

- A simple conversational reply is ONE line with no \`more\` field. Done.
- Longer work may split a reply across SEVERAL lines sharing this turn's
  turn_id. Every line except the last must include \`"more": true\`; the
  final line omits it. Chunks render in order, joined by blank lines.
- **Ack first.** When a turn needs real tool work (debugging, file edits,
  anything past ~a minute), append a quick in-voice ack line with
  \`"more": true\` BEFORE starting, then work, then append the final line.
  Every line you write re-arms the reply window (default 600s) — only
  sustained silence times a turn out.
- **Late is never lost.** If you suspect you blew the window, write the
  line anyway, with the turn_id — late lines are delivered with the next
  turn instead of dropped. Never discard a finished reply.

## Image attachments

When a message lists attached image paths ("view them now:"), Read each file
immediately before responding — they are visual content meant for you to see.
`;
}

export interface ProvisionResult {
  dir: string;
  /** True if the on-disk CLAUDE.md OPERATIONAL contract changed (session
   *  needs a restart to pick it up). Since the template is static source,
   *  this only flips true on first write or after a deploy that revised the
   *  contract. The core-memory section below the contract deliberately does
   *  NOT count — block edits refresh the file on disk without forcing a
   *  recycle (the running session picks them up at its next natural recycle,
   *  same tradeoff as the reference implementation reference architecture). */
  templateChanged: boolean;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Delimits the operational contract from the core-memory section inside the
// session CLAUDE.md. Everything BEFORE this mark is the contract (hashed for
// `templateChanged`); everything after is live memory content, refreshed on
// disk every provision but only loaded by the session at launch/recycle.
const CORE_MEMORY_MARK =
  '\n\n<!-- core-memory below — written by byte-light at provision/recycle. ' +
  'The per-message payload does NOT carry these blocks (delivery-cap fix); ' +
  'mid-session edits land here on disk but surface after the next recycle. -->\n';

/**
 * Render the core-memory blocks as a CLAUDE.md section. The blocks used to be
 * injected into EVERY delivered message's orientation [Context] (~150K chars
 * riding every turn), which overflowed DELIVERY_CAP and got the recycle
 * bridge truncated first — killing cross-thread continuity. Following the
 * reference implementation (reference implementation) delivery model, they now ride the session's CLAUDE.md once per
 * session instead, and the pipe carries the conversation.
 *
 * Best-effort: any failure (DB not initialized — e.g. unit tests importing
 * this module standalone) renders an empty section rather than breaking
 * provisioning.
 */
function renderCoreMemorySection(): string {
  try {
    const rendered = formatBlocksForPrompt([SHARED_SCOPE, ...COMPANION_SCOPES]);
    if (!rendered.trim()) return '';
    return `${CORE_MEMORY_MARK}## Core memory\n${rendered}`;
  } catch {
    return ''; // no DB (tests / pre-init) — operational contract stands alone
  }
}

/**
 * Ensure the session directory exists with hooks, settings, io/, and an
 * up-to-date CLAUDE.md (heartbeat operational contract — identity-blind).
 *
 * The CLAUDE.md content here is the heartbeat-operational contract written
 * into the session working dir; identity is NOT scoped here — the warm
 * session inherits CLAUDE.md by Claude CLI walk-up from cwd, which is the
 * H2 identity surface. H1 deliberately writes operational-only text and
 * leaves the identity question for H2 to solve.
 */
export function provisionSessionDir(dir: string): ProvisionResult {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'io', 'images'), { recursive: true });

  writeFileSync(join(dir, 'hooks', 'heartbeat.cjs'), HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, 'hooks', 'activity.cjs'), ACTIVITY_HOOK_SOURCE, 'utf8');
  writeFileSync(join(dir, '.claude', 'settings.json'), SETTINGS_JSON, 'utf8');

  const operational = heartbeatOperationSection();
  const memorySection = renderCoreMemorySection();
  const claudeMd = operational + memorySection;
  const claudeMdPath = join(dir, 'CLAUDE.md');
  let templateChanged = true;
  let fileChanged = true;
  if (existsSync(claudeMdPath)) {
    try {
      const existing = readFileSync(claudeMdPath, 'utf8');
      fileChanged = existing !== claudeMd;
      // templateChanged tracks the OPERATIONAL contract only — a memory-block
      // edit must refresh the file without forcing a session recycle.
      const markIdx = existing.indexOf(CORE_MEMORY_MARK);
      const existingOperational = markIdx === -1 ? existing : existing.slice(0, markIdx);
      templateChanged = sha(existingOperational) !== sha(operational);
    } catch { /* treat as changed */ }
  }
  if (fileChanged) {
    writeFileSync(claudeMdPath, claudeMd, 'utf8');
    if (memorySection) {
      // The CLAUDE.md-side counterpart of the per-turn payload measurement:
      // memory no longer rides the pipe, so its size is logged here instead.
      console.log(
        `[Heartbeat] core memory section in session CLAUDE.md refreshed: ${memorySection.length} chars`,
      );
    }
  }

  return { dir, templateChanged };
}

// Test surface: export the hook + template strings so the quarantine
// tests can verify the on-disk payloads are byte-light-clean without
// having to spawn a real session.
export const __TEST_HOOK_SOURCES__ = {
  heartbeatHook: HOOK_SOURCE,
  activityHook: ACTIVITY_HOOK_SOURCE,
  settingsJson: SETTINGS_JSON,
  heartbeatOperationSection: heartbeatOperationSection(),
};
