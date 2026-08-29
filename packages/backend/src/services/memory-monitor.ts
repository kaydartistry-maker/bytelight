// Memory black-box recorder + auto-trim.
//
// (1) Records the process memory breakdown every 15s to a rolling log so any
//     future creep names its own cause (native vs JS-heap), and snapshots
//     process activity to a spikes file when RSS jumps >=150MB between samples
//     (the July 2026 detonation pattern — native bursts with a flat JS heap).
// (2) The C allocator (glibc) hoards freed heap and will not return it to the OS
//     on its own — verified June 30 2026: a manual malloc_trim dropped the live
//     process from 4.3GB to 0.45GB, no restart. Studio image-gen + more wakes
//     (Jun 26-27) raised the peak the allocator then clutched, marching RSS into
//     the pm2 ceiling ~daily and forcing session-losing restarts. So we call
//     malloc_trim ourselves whenever RSS climbs past TRIM_ABOVE_MB — the
//     footprint sawtooths near the real ~450MB working set, never the ceiling.
//
// Fully best-effort: a monitor must never destabilize the process it watches.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import { getEmbedStats } from "./embeddings.js";
import { getRecentActivity } from "./activity-ring.js";
import { getMcpClientStats } from "./mcp-client.js";

const TRACE = join(process.cwd(), "data", "mem-trace.jsonl");
const SAMPLE_MS = 15_000; // 15s — the July 8 detonations (384MB->1562MB) fit inside one 60s sample; finer grain narrows the trigger window.
const MAX_LINES = 11_520; // ~48h at one sample/15s
const TRIM_ABOVE_MB = 600; // trim when RSS climbs past this. Tuned for byte-light's ~300MB working set (lowered from 1024 which was reference implementation's headroom — the leak plateaued at ~980MB, just under the old floor, and never tripped). Verified 2026-07-06 from mem-trace: a clean trim drops RSS 1028MB->317MB.

// Burst tripwire: when RSS jumps this much between two samples, snapshot what
// the process was doing (recent activity + embed counters) to a separate file.
// The slow leak is cured — these step-function native bursts are what's left,
// and they leave no fingerprint in the plain trace (JS heap stays flat).
const SPIKES = join(process.cwd(), "data", "mem-trace-spikes.jsonl");
const SPIKE_DELTA_MB = 150;
const SPIKE_MAX_LINES = 500;

interface Sample { t: string; rss: number; heapUsed: number; external: number; arrayBuffers: number; }

const mb = (n: number): number => Math.round(n / 1024 / 1024);

// libc malloc_trim(0) via FFI — hands hoarded free heap back to the OS. Guarded:
// silently unavailable on non-glibc platforms or if koffi fails to load.
let mallocTrim: (() => void) | null = null;
try {
  const req = createRequire(import.meta.url);
  const koffi = req("koffi");
  const libc = koffi.load("libc.so.6");
  const fn = libc.func("int malloc_trim(unsigned long pad)");
  mallocTrim = () => { try { fn(0); } catch { /* ignore */ } };
} catch {
  mallocTrim = null;
}

let prevRss: number | null = null;

// One-line /proc/self/smaps_rollup summary (Linux only). The native RSS leak is
// invisible to the JS heap; the kernel's rollup names the region class. Fully
// best-effort — returns null if the file is absent (non-Linux) or unreadable.
function smapsRollupSummary(): { rssKb: number; privateDirtyKb: number; anonymousKb: number; anonHugePagesKb: number } | null {
  try {
    const raw = readFileSync("/proc/self/smaps_rollup", "utf8");
    const grab = (key: string): number => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
      return m ? parseInt(m[1], 10) : -1;
    };
    return {
      rssKb: grab("Rss"),
      privateDirtyKb: grab("Private_Dirty"),
      anonymousKb: grab("Anonymous"),
      anonHugePagesKb: grab("AnonHugePages"),
    };
  } catch {
    return null;
  }
}

function recordSpike(row: Sample, rssBefore: number): void {
  try {
    const spike = {
      t: row.t,
      rssBefore,
      rssAfter: row.rss,
      delta: row.rss - rssBefore,
      heapUsed: row.heapUsed,
      external: row.external,
      embedStats: getEmbedStats(),
      mcpClientStats: getMcpClientStats(),
      smapsRollup: smapsRollupSummary(),
      recentActivity: getRecentActivity(),
    };
    appendFileSync(SPIKES, JSON.stringify(spike) + "\n");
    console.log(`[memory] SPIKE tripwire: RSS ${rssBefore}MB -> ${row.rss}MB (+${spike.delta}MB) — snapshot appended to mem-trace-spikes.jsonl`);
    const lines = readFileSync(SPIKES, "utf8").trimEnd().split("\n");
    if (lines.length > SPIKE_MAX_LINES) {
      writeFileSync(SPIKES, lines.slice(lines.length - SPIKE_MAX_LINES).join("\n") + "\n");
    }
  } catch {
    /* best-effort only */
  }
}

function sample(): void {
  try {
    const m = process.memoryUsage();
    const rss = mb(m.rss);
    const row: Sample = {
      t: new Date().toISOString(),
      rss,
      heapUsed: mb(m.heapUsed),
      external: mb(m.external),
      arrayBuffers: mb(m.arrayBuffers),
    };
    appendFileSync(TRACE, JSON.stringify(row) + "\n");
    const lines = readFileSync(TRACE, "utf8").trimEnd().split("\n");
    if (lines.length > MAX_LINES) {
      writeFileSync(TRACE, lines.slice(lines.length - MAX_LINES).join("\n") + "\n");
    }
    if (prevRss !== null && rss - prevRss >= SPIKE_DELTA_MB) {
      recordSpike(row, prevRss);
    }
    prevRss = rss;
    // Hand hoarded free heap back to the OS before it marches into the ceiling.
    if (mallocTrim && rss > TRIM_ABOVE_MB) {
      mallocTrim();
      const after = mb(process.memoryUsage().rss);
      console.log(`[memory] RSS ${rss}MB over ${TRIM_ABOVE_MB}MB floor -> trimmed to ${after}MB`);
    }
  } catch {
    /* best-effort only */
  }
}

export function startMemoryMonitor(): void {
  try {
    console.log(mallocTrim ? "[memory] auto-trim armed (malloc_trim via koffi)" : "[memory] auto-trim UNAVAILABLE");
    console.log(`[memory] burst tripwire armed: sampling every ${SAMPLE_MS / 1000}s, spike threshold +${SPIKE_DELTA_MB}MB -> mem-trace-spikes.jsonl`);
    sample();
    const timer = setInterval(sample, SAMPLE_MS);
    timer.unref?.();
  } catch {
    /* best-effort only */
  }
}

/**
 * Summarize the climb leading up to now (or up to a kill): peak RSS vs the start
 * of the recent window, and whether the growth was native or JS-heap. Returns
 * null when there is no meaningful climb to report.
 */
export function summarizeRecentMemoryClimb(): string | null {
  try {
    if (!existsSync(TRACE)) return null;
    const lines = readFileSync(TRACE, "utf8").trimEnd().split("\n");
    if (lines.length < 5) return null;
    // 960 samples = the same ~4h window this held at the old 60s cadence.
    const recent = lines.slice(-Math.min(lines.length, 960)).map((l) => JSON.parse(l) as Sample);
    const first = recent[0];
    const peak = recent.reduce((a, b) => (b.rss > a.rss ? b : a), first);
    const dRss = peak.rss - first.rss;
    if (dRss < 100) return null;
    const dHeap = peak.heapUsed - first.heapUsed;
    const dNative = peak.external + peak.arrayBuffers - (first.external + first.arrayBuffers);
    const kind =
      dHeap > dNative
        ? "JS-heap (objects piling up — a heap snapshot would pinpoint it)"
        : "native/off-heap (onnxruntime/sharp-class — invisible to a heap snapshot)";
    return `Memory climbed +${dRss}MB beforehand (heap +${dHeap}MB, native +${dNative}MB) -> ${kind} leak.`;
  } catch {
    return null;
  }
}
