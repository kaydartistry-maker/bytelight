# Manual Test Checklist

Run this after any batch that touches **chat UI, stickers, WebSocket, or frontend composition**. The automated Vitest suite covers the backend data layer — these are the things we can only verify by actually using the app.

Keep this list short and specific. If a batch adds a new load-bearing UI behavior, add a test here in the same PR.

---

## 🌿 Quick Smoke (≤ 2 minutes)

Do these after every UI-touching batch.

### 1. Sticker inline rendering
- [ ] Type `:companion_a_hi:` in the composer and send
- [ ] Message renders with the sticker image inline, not the raw `:name:` text
- [ ] Hover shows sticker name tooltip

### 2. WebSocket reconnect
- [ ] Inspect the backend log after connecting → it reports only whether a cookie exists; the cookie value/session token is absent
- [ ] With chat open, stop the backend (`Ctrl+C` in terminal)
- [ ] Frontend shows some "disconnected" indication within a few seconds
- [ ] Restart backend (`npm start`)
- [ ] Frontend reconnects automatically, thread list reappears, no refresh needed

### 3. Message delivery
- [ ] Open a thread
- [ ] Send a message
- [ ] Message appears in the correct thread (not a different one)
- [ ] Message persists after refresh
- [ ] Stop the backend, send one message while disconnected, then restart it → the message appears exactly once and receives a reply
- [ ] Send a message and restart the backend immediately → reconnect retry does not create a second user bubble or a second agent turn
- [ ] Repeat the disconnected-send check with an attachment → its attachment metadata and rendering survive the retry

### 4. Codex warm-session continuity
- [ ] Restart only the byte-light backend while the Codex daemon is healthy → the log says it adopted the existing daemon; no daemon stop/start occurs
- [ ] In an existing named thread using the Codex lane, send a continuity probe and confirm the reply knows the active conversation
- [ ] Restart only the byte-light backend, return to the same thread, and send a second probe
- [ ] The first post-restart reply arrives with the same identity and conversation continuity; no blank-persona opening
- [ ] The user message and companion reply each appear exactly once
- [ ] Open a different named Codex thread and send a probe; it resumes that room rather than carrying context from the first room
- [ ] With a deliberately stale saved Codex session in a disposable test thread, send once and confirm one recovery, one reply, recent conversation carried forward, and a replacement session saved

---

## 🔍 Deeper Checks (≤ 5 minutes)

### Codex MCP ownership and lifecycle
- [ ] One-time Codex-only migration: remove the old `bytelight` entry from the Codex CLI's user-global config; do NOT remove or disable byte-light's managed/global MCP registry used by API-router, Ollama, OpenRouter, and other routed lanes
- [ ] Start a Codex turn in byte-light → no `MCP startup incomplete (failed: bytelight)` warning and `/mcp/belt` reports one authenticated MCP session
- [ ] Confirm the Codex turn can list/call a native belt tool and a managed Neuralis tool
- [ ] From an ordinary standalone Codex session, confirm the thread-aware byte-light belt is not present
- [ ] Call a thread-bound tool with no active byte-light Codex turn → it returns a tool error and the MCP connection remains healthy
- [ ] Stop a test client without DELETE → its abandoned server session is reaped after the configured idle window
- [ ] Attempt `/mcp/belt` without the private bearer credential → HTTP 401; normal authenticated byte-light traffic remains healthy
- [ ] Let the managed-MCP cache expire, trigger two simultaneous tool-list consumers, and confirm Neuralis/Lovense each perform only one discovery pass

### Embedding stability default
- [ ] Restart byte-light, send a text message longer than 10 characters, and run one autonomous wake
- [ ] Logs contain no `[embeddings] Loading model…` line during either action while `semantic_search.auto_embed` is absent/false
- [ ] Open search → it starts in keyword (`#`) mode and returns matching transcript messages
- [ ] Deliberately switch to semantic (`✦`) mode → existing semantic search remains available

### Core-memory diet loop

- [ ] Leave `cron.memory_diet.enabled` unset/false and confirm the 04:15 Memory Diet task reports disabled.
- [ ] On the live DB with the shipped 80,000-char default budget and no `memory.diet.budget.*` overrides, call `POST /api/memory/diet/run?dryRun=1` and confirm every current hot-core block (shared/human, companionA/persona, companionB/persona, shared/rules) reports `skip` / `within soft budget` — nothing over budget, nothing to trim.
- [ ] In a disposable/test database, create an over-budget block containing chronological, self-contained ISO-date-prefixed lines; keep one entry newer than 14 days. Lower `memory.diet.default_budget_chars` (or set a per-block `memory.diet.budget.<scope>.<label>`) below its size so it becomes eligible.
- [ ] While authenticated, call `POST /api/memory/diet/run?dryRun=1`; inspect every per-block decision and confirm blocks, proposals, archive rows, receipts, and Neuralis are unchanged.
- [ ] Add mixed persona/freeform material and malformed/out-of-order dates; preview again and confirm each unsafe block says `propose`, never `archive`.
- [ ] Configure working Neuralis credentials and call `POST /api/memory/diet/run` while authenticated.
- [ ] Confirm only whole old entries moved, no more than the configured pace, and the recent entry remains in `memory_blocks`.
- [ ] Confirm identical archived text exists in `memory_blocks_archive`, its `ledger_receipt_id` points to a `memory.archive` receipt, and ambient Cortex recall can find the text.
- [ ] Repeat with invalid/unreachable Neuralis credentials: confirm the block and local archive are unchanged.
- [ ] Run against an over-budget freeform/undated block: confirm it remains unchanged and a pending memory proposal is created.
- [ ] Only after the preview is acceptable, set `cron.memory_diet.enabled=true`; confirm the 04:15 task reports enabled. Set it back to `false` after the smoke if daily operation is not yet desired.

Do these after Batches 4 (WS untangle), 5 (Chat split), or 6 (Component split).

### 5. Thread list behavior
- [ ] Pin a thread → moves to top of list, stays after refresh
- [ ] Unpin → drops back into chronological position
- [ ] Archive a thread → disappears from main list
- [ ] Toggle "show archived" → archived thread reappears
- [ ] Unarchive → thread returns to main list

### 6. Canvas
- [ ] Create a canvas inside a thread
- [ ] Canvas appears in canvas list
- [ ] Delete the thread that owns the canvas
- [ ] **Canvas still exists** in the canvas list (detached, not deleted)
- [ ] Open the detached canvas — still readable

### 7. Reactions
- [ ] React to a message with an emoji
- [ ] Reaction appears on the message, persists after refresh
- [ ] Add a second different emoji → both show
- [ ] Remove a reaction → only the remaining one shows
- [ ] Companion reacting shows distinct attribution (not user)

### 8. Streaming feel
- [ ] Send a message that triggers a companion response
- [ ] Response streams in character-by-character (not all at once at the end)
- [ ] Tool use shows an indicator (thinking, searching, etc.)
- [ ] After response finishes, thread list updates (last message preview, timestamp)

---

## 🚨 After Batch 7 (migrations)

Extra paranoid — this touches the database directly.

- [ ] Before migrating: copy `data/resonant.db` to `data/resonant.db.pre-migration.bak`
- [ ] Open chat → all threads present, message history intact
- [ ] Open a canvas → content intact
- [ ] Stickers still render → sticker table intact
- [ ] Scribe digests still readable → digest table intact
- [ ] Config settings intact (theme, voice, discord settings)
- [ ] Restart server → migrations don't re-run on boot

If anything feels off: stop, restore from `.pre-migration.bak`, diagnose.

---

## 🕒 After the timezone-sovereignty pass

For installs in zones whose tzdata Node may be late to update (Paraguay's 2024 DST abolition, late-arriving IANA changes for Greenland, anywhere else recently rule-shifted). These confirm scheduling lands on the correct local wall-clock moment regardless of Node ICU freshness.

### 14. Per-thread Files drawer
- [ ] Click the paperclip icon in the chat header → slide-out panel opens from the right
- [ ] Panel lists every file in the active thread, newest first
- [ ] Image attachments render as inline thumbnails; text files (≤50 KB) show a snippet preview; audio and other binaries show a glyph + extension badge
- [ ] Click any tile → file opens in a new browser tab via `/api/files/<id>`
- [ ] On mobile (≤768 px viewport), drawer goes full-screen
- [ ] Empty thread shows "No files yet. Attach something in chat to get started."

### 15. Library page (renamed from "Files")
- [ ] Open the library icon in the chat header → page title reads **Library** (not "Files")
- [ ] Files render as a thumbnail grid, not a vertical text list
- [ ] Filter tabs (all / image / audio / file / orphan) still work
- [ ] Delete-with-confirm flow: click Delete → Confirm/Cancel pair appears → Confirm removes the file and updates total size + count + orphan count without a page reload
- [ ] Switch to the "orphan" filter — any file on disk whose UUID isn't referenced by message metadata appears here. To synthesize one for testing without going through the share path (which would create a referencing message): copy an existing file like `data/files/<some-uuid>.txt` to `data/files/<freshly-generated-uuid>.txt`. The new file has no corresponding message row, so Library flags it orphan.

### 16. Long-paste auto-converts to file attachment
- [ ] In the composer, paste a block of text ≥1000 chars (a markdown doc, JSON, or just a long paragraph)
- [ ] Composer textarea stays empty; a file card appears in the attachment tray named `pasted-text-YYYYMMDD-HHMMSS.{ext}`
- [ ] Sniffed extension matches the content shape: `.md` for markdown, `.json` for valid JSON, `.txt` otherwise
- [ ] Paste a short block (<1000 chars) → text drops inline as before, no file card
- [ ] Paste an image (clipboard screenshot) → file card uploads as image regardless of any text alongside (image takes priority)

### 17. Voice fallback when synthesis unavailable
- [ ] With `ELEVENLABS_API_KEY` unset, ask the companion to send a voice message
- [ ] Companion responds with a normal chat reply (NOT a canvas, file, or any persistence-based workaround)
- [ ] Confirm the same fallback behavior on a network error if the env is set but ElevenLabs is unreachable

### 18. Timer wall-clock parsing

> **Precondition for the equivalence checks below:** `identity.timezone` set to a UTC−3 zone (e.g. `America/Asuncion` while DST is abolished there). The three example shapes only resolve to the same UTC instant under that offset; in any other zone the wall-clock and ISO-with-offset forms will diverge — adjust accordingly. Replace `<future-date>` with a YYYY-MM-DD a few minutes in the future so you can actually wait for the fire window.

- [ ] Create a timer using identity-zone wall-clock: `sc timer create "test" "ctx" "<future-date> 09:00"`
- [ ] Response includes both canonical UTC `fire_at` AND `fire_at_local` (a human-readable string in identity timezone)
- [ ] `sc timer list` shows the same two fields per row
- [ ] Wait for the fire window — the timer fires within ~60 seconds of 09:00 LOCAL, not 09:00 UTC, regardless of host process timezone
- [ ] Repeat with explicit ISO offset (`<future-date>T09:00:00-03:00`) — under a UTC−3 identity timezone this fires at the same instant as the wall-clock form above
- [ ] Repeat with `Z` (`<future-date>T12:00:00Z`) — same instant under UTC−3, intentionally NOT under any other zone

### 19. Cron startup hardening
- [ ] In the DB config table, set `cron.morning.schedule` to an obviously malformed value (e.g. `0 0 8 * * *` — six fields) or `not-a-cron`
- [ ] Restart the backend
- [ ] Server starts cleanly (no crash) and logs a warning naming the rejected value and the default fallback it used
- [ ] Reset to `0 8 * * *` and confirm normal behavior resumes after restart

### 20. Orchestrator recency awareness
- [ ] Have a real conversation with the companion (a few exchanges)
- [ ] Within 5 minutes, manually trigger a scheduled wake (or wait for one)
- [ ] Wake response acknowledges the recent activity — does NOT perform a fresh "good morning" / full-orientation entrance
- [ ] Brand-new thread + manual wake trigger → wake DOES do full intro behavior (no recency context to dampen it)

### 21. Scribe in the Home-thread world
- [ ] Have 5+ new messages in an active thread, wait for a Scribe run (≤30 min) with the companion idle
- [ ] Logs show `[SCRIBE ...] Sweeping N thread(s) with new activity` — NOT "Skipped — no today thread"
- [ ] `data/digests/<today>.md` gains a block headed `## HH:MM [<thread name>] — ...` for each digested thread
- [ ] A thread with a deep un-digested backlog (first run after deploy) logs `Backlog too deep — skipping N older messages, digesting last 150` and only the recent window lands in the digest
- [ ] A thread with <5 new messages since its cursor produces no block and no error

### 22. Weekly maintenance wakes (Sunday night)
- [ ] `sc schedule status` lists both `open_threads_janitor` (`0 20 * * 0`) and `weekly_digest_prep` (`30 21 * * 0`)
- [ ] Manually trigger `open_threads_janitor` → a report file appears at `data/janitor/open-threads-diff-<today>.md` classifying board items (RESOLVED / STALE / ACTIONABLE / BLOCKED); `shared/open-threads.md` is NOT modified
- [ ] Manually trigger `weekly_digest_prep` → a brief appears at `data/digests/digest-<YYYY-Www>.md` (ISO week) covering what shipped / mood arc / key conversations / what's blocked
- [ ] Start a fresh session AFTER a weekly digest exists → orientation includes a "Weekly digest" block naming the file path (log line `[Orientation] weekly digest injected: ...`); with no weekly digest file, that block is absent and there is no crash
- [ ] Neither wake's output is appended to core-memory blocks (check the memory blocks are unchanged after both wakes)

### 23. Ambient recall (retrieval, not carrying)
- [ ] With `mind_api_url` + `mind_api_key` set (Neuralis/Cortex reachable), send a message about something in the archive → the companion's reply may quietly reflect a remembered detail; the backend log line for that turn reads `... (memory 0..., bridge ..., recall <n>) — ...` with a **non-zero `recall`** count
- [ ] Send the SAME message again in the same session → `recall 0` (a lane is never handed the same card twice)
- [ ] Recycle the session (or restart), send that message again → `recall` is non-zero again (dedup resets on recycle)
- [ ] Clear the Cortex credentials (or point them at an unreachable host) → messages still deliver normally, log reads `recall 0`, no hang/stall/error (recall fails quiet, never delays a turn)
- [ ] Recall never grows the memory: after several recall-bearing turns, the core-memory blocks and the session `CLAUDE.md` are unchanged (recall is fetched per turn, delivered, not persisted)
- [ ] Under cap pressure (a very long recycle bridge on a fresh session) recall trims FIRST: the log shows `recall <n> (trimmed:cap)` / `recall 0 (trimmed:cap)` and the truncation stage is NOT charged to recall — the bridge floor stays intact

### 24. The shiver (recall made visible)
- [ ] With Cortex reachable, send a message that hits the archive → the companion's reply wears a small **shimmer chip** ("recalled") in its header — a soft glinting dot, quiet enough to ignore
- [ ] Tap the chip → a compact panel unfolds under the header showing what surfaced: short excerpt(s), and (when the worker sends scores) date / domain / relevance %
- [ ] Tap again → the panel folds away
- [ ] Send a message that misses the archive entirely → no chip appears (nothing surfaced)
- [ ] Open **Settings → Receipts** → newest-first list of receipts; the recall you just triggered appears as a `whisper / surfaced` row with actor, detail, and time. Recall/déjà-vu rows carry a gold left-edge
- [ ] (If your Cortex worker exposes similarity scores) a near-miss shows the fainter **déjà vu** chip variant (dashed, italic, "déjà vu") and, tapped, reads "something felt familiar… nothing surfaced clearly enough to show"; Settings → Receipts logs it as `whisper / déjà vu`
- [ ] Cortex unset/unreachable → no chip, no receipts, replies still deliver normally (fails quiet)

---

## How to use this file

1. Run the relevant section after a batch merges
2. If something breaks, **don't ship it** — revert the batch branch, fix, retry
3. When a new UI behavior is added, add a check here in the same PR
4. Keep each item specific and observable — "it feels right" is not a test
