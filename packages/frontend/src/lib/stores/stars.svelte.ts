// Adapted for byte-light under Apache 2.0 (generic multi-actor).
// Stars store — tracks which messages the human viewer (actor 'user') has starred,
// so MessageBubble can render toggle state without a per-bubble fetch.
// Companions' stars ('companion-a'/'companion-b'/'companion-c'/…) live in the StarredDrawer, not on the bubble.
import { apiFetch } from '$lib/utils/api';

// The human viewer's actor slug. Companions use their own slugs server-side.
export const HUMAN_ACTOR = 'user';

let myStars = $state<Set<string>>(new Set());
let loaded = $state(false);
let loading = false;

export function getMyStars(): Set<string> {
  return myStars;
}

export function isStarredByMe(messageId: string): boolean {
  return myStars.has(messageId);
}

export async function loadMyStars(): Promise<void> {
  if (loaded || loading) return;
  loading = true;
  try {
    const r = await apiFetch(`/api/starred?starred_by=${HUMAN_ACTOR}&limit=500`);
    if (!r.ok) throw new Error(`Failed to load stars (${r.status})`);
    const data = await r.json();
    const ids = new Set<string>();
    for (const item of data.items ?? []) {
      if (item?.message_id) ids.add(item.message_id);
    }
    myStars = ids;
    loaded = true;
  } catch (e) {
    console.error('loadMyStars failed:', e);
  } finally {
    loading = false;
  }
}

export async function toggleMyStar(messageId: string): Promise<void> {
  const wasStarred = myStars.has(messageId);
  // Optimistic update
  const next = new Set(myStars);
  if (wasStarred) next.delete(messageId);
  else next.add(messageId);
  myStars = next;

  try {
    const r = await apiFetch(`/api/messages/${messageId}/star`, {
      method: wasStarred ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred_by: HUMAN_ACTOR }),
    });
    if (!r.ok) throw new Error(`Failed (${r.status})`);
  } catch (e) {
    // Roll back on failure
    const rollback = new Set(myStars);
    if (wasStarred) rollback.add(messageId);
    else rollback.delete(messageId);
    myStars = rollback;
    console.error('toggleMyStar failed:', e);
  }
}

// Called by the WS store on message_starred / message_unstarred events.
export function handleStarBroadcast(payload: {
  type: 'message_starred' | 'message_unstarred';
  messageId: string;
  starredBy: string;
}): void {
  // Only the human viewer's own stars affect bubble toggle state.
  if (payload.starredBy !== HUMAN_ACTOR) return;
  const next = new Set(myStars);
  if (payload.type === 'message_starred') next.add(payload.messageId);
  else next.delete(payload.messageId);
  myStars = next;
}
