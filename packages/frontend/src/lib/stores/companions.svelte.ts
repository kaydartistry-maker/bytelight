// Companions registry + per-thread roster (Arc C, Slice 3).
//
// Reads GET /api/companions (the pickable identities) and the per-thread
// roster endpoints from Slice 2 (rooms-routes.ts). Faces/emojis for each
// companion are NOT stored here — they render from the profiles store
// (getProfile(companion.id)), the same visual language the Arc B bubbles use.
// So a companion row carries identity/order; the profiles store carries the
// face. All fetches ride apiFetch like profiles.svelte.ts.

import { apiFetch } from '$lib/utils/api';

/** A pickable companion, mirrors the backend companions registry row. */
export interface Companion {
  id: string;
  display_name: string;
  avatar: string | null;
  brain: string;
  model: string | null;
  sort_order: number;
  created_at: string;
}

let companions = $state<Companion[]>([]);
let loaded = $state(false);
let loading = $state(false);

/** The full pickable registry (reactive), in picker order. */
export function allCompanions(): Companion[] {
  return companions;
}

export function companionsLoaded(): boolean {
  return loaded;
}

/** Load the registry once. Safe to call repeatedly (no-op after first load
 *  unless force is set). */
export async function loadCompanions(force = false): Promise<void> {
  if ((loaded || loading) && !force) return;
  loading = true;
  try {
    const r = await apiFetch('/api/companions');
    if (r.ok) {
      const data = (await r.json()) as { companions?: Companion[] };
      companions = data.companions ?? [];
      loaded = true;
    }
  } catch {
    /* keep whatever we had */
  } finally {
    loading = false;
  }
}

/** Read a thread's seated roster (companion ids, picker order). Returns [] on
 *  any failure so callers can render a safe empty state. */
export async function getThreadRoster(threadId: string): Promise<Companion[]> {
  try {
    const r = await apiFetch(`/api/threads/${threadId}/roster`);
    if (r.ok) {
      const data = (await r.json()) as { roster?: Companion[] };
      return data.roster ?? [];
    }
  } catch {
    /* fall through */
  }
  return [];
}

/** Replace a thread's roster with exactly companionIds. Returns the resulting
 *  roster on success, or null on failure (the caller keeps its prior state). */
export async function setThreadRoster(
  threadId: string,
  companionIds: string[],
): Promise<Companion[] | null> {
  try {
    const r = await apiFetch(`/api/threads/${threadId}/roster`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companionIds }),
    });
    if (r.ok) {
      const data = (await r.json()) as { roster?: Companion[] };
      return data.roster ?? [];
    }
  } catch {
    /* fall through */
  }
  return null;
}
