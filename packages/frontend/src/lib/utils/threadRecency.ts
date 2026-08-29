// Rolling window that defines how long a touched thread lingers in the
// "Active" group of the thread list. Tunable — widen it to keep threads
// surfaced longer, narrow it to let them settle back into their homes sooner.
export const ACTIVE_WINDOW_MS = 36 * 60 * 60 * 1000; // ~36h

/**
 * True when a thread's last_activity_at falls within the rolling active
 * window ending at `now`. Guards against a missing or invalid timestamp:
 * such threads are treated as not-recent rather than crashing.
 */
export function isRecentlyActive(
  lastActivityAt: string | null | undefined,
  now: number = Date.now(),
  windowMs: number = ACTIVE_WINDOW_MS,
): boolean {
  if (!lastActivityAt) return false;
  const ts = new Date(lastActivityAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts < windowMs;
}
