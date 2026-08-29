// Pending visuals — a tiny per-thread queue of images the companion should be
// shown on its NEXT turn, exactly once.
//
// Generated images post to the chat OUTSIDE a model turn (the image-gen route
// is fire-and-forget), so they'd never reach the model as visual blocks. The
// route queues each generated image's fileId here; agent.ts drains the queue
// when building the next turn and embeds them — so we actually see what we
// made and can react to it. Draining clears them, so a warm session never
// stacks duplicate copies turn after turn.

const queue = new Map<string, string[]>(); // threadId → fileIds

const MAX_PER_THREAD = 4;

/** Mark an image (by fileId) to be shown to the companion on its next turn. */
export function queueImageForCompanion(threadId: string, fileId: string): void {
  if (!threadId || !fileId) return;
  const arr = queue.get(threadId) ?? [];
  arr.push(fileId);
  queue.set(threadId, arr.slice(-MAX_PER_THREAD));
}

/** Take (and clear) the queued image fileIds for a thread. */
export function drainQueuedImages(threadId: string): string[] {
  const arr = queue.get(threadId);
  if (!arr) return [];
  queue.delete(threadId);
  return arr;
}
