# CSRF Migration Inventory — Phase 1

**Date:** 2026-05-20
**Scope:** `packages/frontend/src` — all `fetch()` / `apiFetch()` call sites that perform state-changing requests (POST / PUT / PATCH / DELETE)
**Status:** Inventory only. No code migration in this pass.

## Background

byte-light's CSRF middleware (`packages/backend/src/middleware/csrf.ts:51,57`) reads `req.cookies` without `cookie-parser` ever being installed. `req.cookies` is undefined; the middleware early-returns on every state-changing request. **All POSTs/PUTs/PATCHes/DELETEs currently bypass CSRF entirely** — the protection is mounted but functionally inert.

The fix path (see Agent F program in cortex memory) requires migrating raw `fetch()` callers to `apiFetch()` (which attaches the `x-csrf-token` header from the `resonant_csrf` cookie) **before** wiring `cookie-parser` and flipping CSRF on. Skipping the migration would 401 large parts of the app on enablement.

## Methodology

Three greps against `packages/frontend/src/**/*.{svelte,ts}`:

1. `fetch(...{method: 'POST'|'PUT'|'PATCH'|'DELETE'})` — raw fetch with explicit state-changing method
2. `apiFetch(...{method: 'POST'|'PUT'|'PATCH'|'DELETE'})` — already CSRF-safe
3. `api.post/put/delete/patch(...)` — convenience helpers (none defined yet)

Additional context: 81 raw `fetch()` calls have no explicit method and are presumed GET reads. These don't need CSRF, but a deeper audit could surface any that pass `method` via a variable. Not blocking — flagged in Open Questions.

## Totals

| Category | Count | CSRF-safe? |
|---|---:|---|
| Raw `fetch()` with state-changing method | **32** | **NO — needs migration** |
| `apiFetch()` with state-changing method | **3** | yes |
| `api.<verb>()` convenience helpers | 0 | n/a |
| **Total state-changing requests** | **35** | **8.6% CSRF-safe** |
| Files with state-changing raw fetch | 10 | — |

## Files requiring migration (raw fetch → apiFetch)

| File | Sites | Concentration |
|---|---:|---|
| `packages/frontend/src/routes/cc/planner/+page.svelte` | 7 | Command Center planner tasks |
| `packages/frontend/src/routes/cc/lists/+page.svelte` | 6 | Command Center lists CRUD |
| `packages/frontend/src/lib/components/ThreadList.svelte` | 4 | thread archive/delete/pin |
| `packages/frontend/src/lib/components/DiscordPanel.svelte` | 3 | discord rules + pairings |
| `packages/frontend/src/lib/components/StickerManager.svelte` | 3 | sticker pack/sticker CRUD |
| `packages/frontend/src/routes/cc/cycle/+page.svelte` | 2 | cycle period start/end |
| `packages/frontend/src/routes/cc/DailyScratchpad.svelte` | 2 | scratchpad save |
| `packages/frontend/src/routes/cc/pets/+page.svelte` | 2 | pet records, meds |
| `packages/frontend/src/lib/components/NotificationsPanel.svelte` | 1 | push test |
| `packages/frontend/src/routes/cc/calendar/+page.svelte` | 1 | calendar event |
| `packages/frontend/src/routes/files/+page.svelte` | 1 | file delete |

10 files. The Command Center routes (`cc/*`) account for 19 of 32 sites (59%).

## Full callsite table

| # | File:line | Method | Endpoint | Migration target |
|---|---|---|---|---|
| 1 | `StickerManager.svelte:86` | DELETE | `/api/sticker-packs/${packId}` | `apiFetch` |
| 2 | `StickerManager.svelte:106` | POST | `/api/stickers` (multipart) | `apiFetch` — preserve `FormData` body, do NOT set Content-Type manually |
| 3 | `StickerManager.svelte:125` | DELETE | `/api/stickers/${stickerId}` | `apiFetch` |
| 4 | `NotificationsPanel.svelte:128` | POST | `/api/push/test` | `apiFetch` |
| 5 | `DiscordPanel.svelte:215` | DELETE | `/api/discord/rules/${type}/${id}` | `apiFetch` |
| 6 | `DiscordPanel.svelte:303` | POST | `/api/discord/pairings/${code}/approve` | `apiFetch` |
| 7 | `DiscordPanel.svelte:322` | DELETE | `/api/discord/pairings/${userId}` | `apiFetch` |
| 8 | `ThreadList.svelte:147` | POST | `/api/threads/${threadId}/archive` | `apiFetch` |
| 9 | `ThreadList.svelte:250` | DELETE | `/api/threads/${threadId}` | `apiFetch` |
| 10 | `ThreadList.svelte:296` | POST | `/api/threads/${threadId}/pin` | `apiFetch` |
| 11 | `ThreadList.svelte:305` | POST | `/api/threads/${threadId}/unpin` | `apiFetch` |
| 12 | `cc/DailyScratchpad.svelte:98` | (state-changing) | `${CC_API}/scratchpad/...` | `apiFetch` |
| 13 | `cc/DailyScratchpad.svelte:104` | (state-changing) | `${CC_API}/scratchpad/...` | `apiFetch` |
| 14 | `cc/calendar/+page.svelte:73` | (state-changing) | `${CC_API}/calendar/...` | `apiFetch` |
| 15 | `cc/cycle/+page.svelte:31` | POST | `${CC_API}/cycle/period/start` | `apiFetch` |
| 16 | `cc/cycle/+page.svelte:32` | POST | `${CC_API}/cycle/period/end` | `apiFetch` |
| 17 | `cc/lists/+page.svelte:35` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 18 | `cc/lists/+page.svelte:41` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 19 | `cc/lists/+page.svelte:46` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 20 | `cc/lists/+page.svelte:51` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 21 | `cc/lists/+page.svelte:57` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 22 | `cc/lists/+page.svelte:63` | (state-changing) | `${CC_API}/lists/...` | `apiFetch` |
| 23 | `cc/pets/+page.svelte:27` | POST | `${CC_API}/pets` | `apiFetch` |
| 24 | `cc/pets/+page.svelte:33` | POST | `${CC_API}/pets/medications/given` | `apiFetch` |
| 25 | `cc/planner/+page.svelte:107` | PUT | `${CC_API}/tasks/${task.id}/complete` | `apiFetch` |
| 26 | `cc/planner/+page.svelte:109` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 27 | `cc/planner/+page.svelte:116` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 28 | `cc/planner/+page.svelte:123` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 29 | `cc/planner/+page.svelte:128` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 30 | `cc/planner/+page.svelte:135` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 31 | `cc/planner/+page.svelte:142` | (state-changing) | `${CC_API}/tasks/...` | `apiFetch` |
| 32 | `files/+page.svelte:86` | DELETE | `/api/files/${fileId}` | `apiFetch` |

## Already CSRF-safe (reference)

| # | File:line | Notes |
|---|---|---|
| A | `ThreadList.svelte:169` | rename PATCH — already uses `apiFetch` |
| B | `lib/stores/auth.svelte.ts:81` | password change — already uses `apiFetch` |
| C | `lib/utils/api.ts:57` | helper internal — the `apiFetch` definition itself |

## Migration shape (per site)

Each site follows the same pattern:

```ts
// BEFORE
const res = await fetch('/api/something', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  credentials: 'include',
});

// AFTER
import { apiFetch } from '$lib/utils/api';
const res = await apiFetch('/api/something', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
// apiFetch attaches x-csrf-token from the resonant_csrf cookie automatically
// and defaults credentials: 'include' — no manual cookie config needed
```

**Special case — multipart uploads** (e.g. `StickerManager.svelte:106`): do NOT set `Content-Type` manually when passing `FormData` as body. The browser sets the multipart boundary correctly only when Content-Type is omitted. `apiFetch` does not override it.

## Open questions for Phase 2 planning

1. **`${CC_API}` base URL**: Command Center routes use a `${CC_API}` prefix. Confirm `apiFetch` accepts absolute URLs (it does — it just passes the URL through to `fetch`). No special handling needed.

2. **Variable-method `fetch()` calls**: The 81 no-explicit-method fetch calls are presumed GET, but a few may pass `method` via a variable. A Phase 2 sub-task: grep for `method:` immediately adjacent to a `fetch(` call where the method variable might be POST. Spot-check `lib/stores/websocket.svelte.ts` and `lib/utils/cc.ts` first.

3. **CSRF cookie issuance**: confirm `resonant_csrf` cookie is being set on the login response. If not, `apiFetch` reads `null` and skips the header — meaning migrated callers will work, but the CSRF backstop won't actually enforce. Auth flow needs to issue the cookie before Phase 3 wiring.

4. **`cookie-parser` install**: currently absent. Phase 3 will install it AND set up an explicit allow-list to avoid breaking unrelated route handlers that may incidentally rely on `req.cookies` being undefined. (Likely none, but worth a search.)

5. **Per-batch migration cadence**: 32 sites across 10 files is too many for one PR. Suggested batches:
   - **Batch CSRF-1**: ThreadList + StickerManager + DiscordPanel + NotificationsPanel + Files (5 files, 12 sites — core chat operations)
   - **Batch CSRF-2**: CC planner + CC lists (2 files, 13 sites — Command Center bulk)
   - **Batch CSRF-3**: CC cycle + CC pets + CC scratchpad + CC calendar (4 files, 7 sites — Command Center remainder)
   - After all three land cleanly: Phase 3 cookie-parser wiring + Phase 4 gated enablement

## What this inventory does NOT do

- No code migration. Phase 2 (the actual migration work) is a separate session.
- No `cookie-parser` install. Phase 3.
- No CSRF enablement. Phase 4.
- No backend route audit. Phase 1 is frontend-only.
- No GET-side review. Read endpoints are out of scope for CSRF.

## Next action

Phase 2 — port Batch CSRF-1 (5 files, 12 sites) in an isolated worktree. Smoke tested via manual checklist: archive/unarchive thread, pin/unpin, delete a sticker, send a push test, delete a Discord rule, delete a file. All should still succeed (CSRF middleware is currently inert so migration alone changes no behavior — but the header is now attached, ready for enablement).
