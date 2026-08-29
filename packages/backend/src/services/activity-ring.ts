// Rolling "what was the process doing" buffer for the memory-burst tripwire.
//
// RSS detonations (e.g. 384MB -> 1562MB inside one sample) happen with a flat
// JS heap, so heap snapshots can't name the trigger. Instead we keep the last
// few dozen activity events (HTTP hits, agent turns, model recycles) in memory
// and the memory monitor snapshots them alongside any RSS spike — whatever ran
// right before the jump is the suspect.
//
// Deliberately tiny: fixed-size ring, strings only, no bodies/queries.

const MAX_ENTRIES = 40;

export interface ActivityEntry { t: string; kind: string; detail: string; }

const ring: ActivityEntry[] = [];

export function recordActivity(kind: string, detail: string): void {
  try {
    ring.push({ t: new Date().toISOString(), kind, detail });
    if (ring.length > MAX_ENTRIES) ring.shift();
  } catch {
    /* best-effort only */
  }
}

export function getRecentActivity(): ActivityEntry[] {
  return [...ring];
}
