import type { ServerMessage, ClientMessage, Message, Canvas, ThreadSummary, PresenceStatus, SystemStatus, MessageSegment, ThoughtKind, CommandRegistryEntry } from '@bytelight/shared';
import { setSystemStatus } from './settings.svelte';
import { handleStarBroadcast } from './stars.svelte';
import { showToast } from './toast.svelte';
import { acknowledgePending, readOutbox, upsertPending, writeOutbox, type PendingMessage } from '../message-outbox';

// Connection state
let wsInstance: WebSocket | null = $state(null);
let connectionState = $state<'connected' | 'disconnecting' | 'disconnected' | 'reconnecting'>('disconnected');
let reconnectAttempt = $state(0);
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
let staleStreamTimeout: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;
let intentionalClose = $state(false);
let closeReason = $state<'manual' | 'heartbeat_timeout' | 'socket_error' | 'network' | 'unknown'>('unknown');
let reconnectInFlight: Promise<void> | null = null;
let lastPongTime = $state<number>(Date.now());
let tabVisible = $state<boolean>(typeof document !== 'undefined' ? !document.hidden : true);

// Data state
let messages = $state<Message[]>([]);
let threads = $state<ThreadSummary[]>([]);
let activeThreadId = $state<string | null>(null);
// The routing ("Home") thread — where Discord/Telegram/wakes land (reference implementation port)
let routingThreadId = $state<string | null>(null);
let presence = $state<PresenceStatus>('offline');
let unreadCounts = $state<Record<string, number>>({});

// Streaming state
let streamingMessageId = $state<string | null>(null);
let streamingThreadId = $state<string | null>(null);
let streamingTokens = $state<string>('');
let lastTokenAt = $state<number | null>(null);

// Stale stream watchdog: clear streaming if no activity for 5 minutes (matches backend timeout)
const STALE_STREAM_TIMEOUT_MS = 5 * 60 * 1000;
// Hard cap for the grace path below — matches the backend's absolute agent
// timeout (agent.ts AGENT_TIMEOUT_MS, 20 min). A turn older than this is
// dead server-side no matter what; stop extending and clean up.
const STALE_STREAM_HARD_CAP_MS = 20 * 60 * 1000;
// When the current stream started (set on stream_start). Used only by the
// watchdog's hard-cap check.
let streamStartedAt = 0;

function clearStaleStreamWatchdog(): void {
  if (staleStreamTimeout) {
    clearTimeout(staleStreamTimeout);
    staleStreamTimeout = null;
  }
}

function resetStaleStreamWatchdog(): void {
  clearStaleStreamWatchdog();
  if (!streamingMessageId) return;
  staleStreamTimeout = setTimeout(() => {
    if (streamingMessageId) {
      // Codex-lane quiet stretches: the foreign lane buffers its final text
      // to turn-end, so a working turn can go silent between tool phases
      // (long model reasoning, no open tools → no tool_progress ticks). If
      // this stream has shown real activity (tool or thinking events) and
      // is still inside the backend's absolute 20-min turn window, extend
      // instead of hard-killing — the backend's own 5-min safety timer
      // broadcasts generation_stopped/agent_timeout if the turn truly died,
      // and both of those clear this state through their own handlers. The
      // Claude lane streams tokens constantly, so it never reaches 5 min of
      // silence while healthy — no regression there.
      const hasActivity =
        (toolEvents[streamingMessageId]?.length ?? 0) > 0 ||
        (thinkingEvents[streamingMessageId]?.length ?? 0) > 0;
      if (hasActivity && Date.now() - streamStartedAt < STALE_STREAM_HARD_CAP_MS) {
        console.warn('[ws:lifecycle] Stream quiet for 5min but has tool/thinking activity — extending watchdog');
        resetStaleStreamWatchdog();
        return;
      }
      console.warn('[ws:lifecycle] Stale stream detected — clearing stuck streaming state');
      // Clean up tool/thinking state for the stale stream
      if (toolOffsets[streamingMessageId]) {
        const { [streamingMessageId]: _, ...rest } = toolOffsets;
        toolOffsets = rest;
      }
      if (thinkingEvents[streamingMessageId]) {
        const { [streamingMessageId]: __, ...rest2 } = thinkingEvents;
        thinkingEvents = rest2;
      }
      streamingMessageId = null;
      streamingThreadId = null;
      streamingTokens = '';
      lastError = { code: 'stale_stream', message: 'Stream timed out. Please try again.' };
      setTimeout(() => { lastError = null; }, 10000);
    }
  }, STALE_STREAM_TIMEOUT_MS);
}

// Tool events per message
export type ToolEvent = {
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
  isComplete: boolean;
  timestamp: string;
  elapsed?: number;
};
let toolEvents = $state<Record<string, ToolEvent[]>>({});
let toolOffsets = $state<Record<string, Array<{ toolId: string; textOffset: number }>>>({});

// Thinking events per streaming message. `kind` is the reference implementation
// thought-semantics classification (Slice 3) — absent on legacy events.
export type ThinkingEvent = { content: string; summary: string; textOffset: number; kind?: ThoughtKind };
let thinkingEvents = $state<Record<string, ThinkingEvent[]>>({});

// Voice state
let voiceModeEnabled = $state(false);
let transcriptionStatus = $state<'idle' | 'processing' | 'complete' | 'error'>('idle');
let transcriptionText = $state<string | null>(null);
let transcriptionError = $state<string | null>(null);
let transcriptionProsody = $state<Record<string, number> | null>(null);
// recordingId + prosodyStatus carry through from the backend's
// transcription_status frame. The live-call recorder correlates a completed
// transcription to the exact turn it started (protocol already stamps these;
// the read path just needs to surface them).
let transcriptionRecordingId = $state<string | null>(null);
let transcriptionProsodyStatus = $state<'complete' | 'unavailable' | null>(null);

// TTS playback state
let ttsPlaying = $state(false);
let ttsMessageId = $state<string | null>(null);
let ttsAudioQueue = $state<Array<{ messageId: string; data: string; final: boolean }>>([]);

// Context usage state
let contextUsage = $state<{ percentage: number; tokensUsed: number; contextWindow: number } | null>(null);
let compactionNotice = $state<{ preTokens: number; message: string; isComplete: boolean } | null>(null);
let compactionTimeout: ReturnType<typeof setTimeout> | null = null;

// Rate limit state
let rateLimitInfo = $state<{ status: string; resetsAt?: number; rateLimitType?: string } | null>(null);
let rateLimitTimeout: ReturnType<typeof setTimeout> | null = null;

// Rewind state
let rewindResult = $state<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string } | null>(null);

// Command state
let commandRegistry = $state<CommandRegistryEntry[]>([]);
let lastCommandResult = $state<{ name: string; success: boolean; data?: Record<string, unknown>; error?: string; display?: string } | null>(null);
let commandResultTimeout: ReturnType<typeof setTimeout> | null = null;

// Canvas state
let canvases = $state<Canvas[]>([]);
let activeCanvasId = $state<string | null>(null);

// Memory-block live-update signal — bumped on every `memory_block_updated`
// broadcast (a companion or the operator edited a block). The Memory panel reads this
// via getMemoryBlockVersion() inside an $effect and re-fetches when it changes.
let memoryBlockVersion = $state(0);

// Notification state
let notificationPermission = $state<NotificationPermission>(
  typeof Notification !== 'undefined' ? Notification.permission : 'default'
);

function showLocalNotification(title: string, body: string): void {
  if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
  if (!document.hidden) return; // Only when tab is not focused
  // Check real browser permission, not stale state (permission may have been
  // granted via push subscription flow without updating our state variable)
  const permission = Notification.permission;
  if (permission !== 'granted') return;

  new Notification(title, {
    body,
    icon: '/icons/icon-192.png',
    tag: 'bytelight-local',
  });
}

export function getNotificationPermission(): NotificationPermission {
  // Return live browser value when available, state as fallback (SSR)
  if (typeof Notification !== 'undefined') {
    return Notification.permission;
  }
  return notificationPermission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  const result = await Notification.requestPermission();
  notificationPermission = result;
  return result;
}

// Error state
let lastError = $state<{ code: string; message: string } | null>(null);
const outboxStorage = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
let pendingMessages = $state<PendingMessage[]>(readOutbox(outboxStorage));

function persistPendingMessages(): void {
  writeOutbox(pendingMessages, outboxStorage);
}

// Last seen sequence for sync
let lastSeenSequence = $state(0);

// Search-jump state. When a search result jumps to a message older than the
// last 50, we load a window CENTERED on that message (loadThreadAround) rather
// than the tail. `isViewingAround` marks that the current `messages` slice is a
// window view, so the chat page can avoid auto-scrolling to bottom and can let
// pagination reconcile on the next normal load. `pendingJumpMessageId` guards
// the auto-scroll effects so they don't yank the view to the bottom before the
// jump lands on the target.
let isViewingAround = $state(false);
let pendingJumpMessageId = $state<string | null>(null);

function getWebSocketUrl(): string {
  if (typeof window === 'undefined') return '';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = import.meta.env.DEV ? 'localhost:3002' : window.location.host;
  return `${protocol}//${host}/ws`;
}

function getReconnectDelay(): number {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
  const baseDelay = delays[Math.min(reconnectAttempt, delays.length - 1)];
  // Add jitter: +/- 20% to avoid reconnect stampedes
  const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

function clearTimers() {
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  clearStaleStreamWatchdog();
}

// Heartbeat policy:
// - Foreground (visible): ping every 30s, timeout 5s
// - Background (hidden): ping every 60s, timeout 90s (relaxed to tolerate mobile sleep)
function startHeartbeat() {
  scheduleNextHeartbeat();
}

function scheduleNextHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

  const intervalMs = tabVisible ? 30000 : 60000;

  heartbeatInterval = setInterval(() => {
    if (wsInstance?.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify({ type: 'ping' }));
      // Foreground gets 12s (not 5s): the backend event loop can stall briefly
      // while generating, and a too-tight window kills healthy connections mid-stream.
      const timeoutMs = tabVisible ? 12000 : 90000;
      if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
      heartbeatTimeout = setTimeout(() => {
        console.warn(`[ws:lifecycle] Heartbeat timeout (${timeoutMs}ms, visible=${tabVisible}) — no pong received`);
        closeReason = 'heartbeat_timeout';
        wsInstance?.close();
      }, timeoutMs);
    }
  }, intervalMs);
}

// Health probe: check if socket is alive before triggering reconnect on visibility change
function sendHealthProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }

    // If we received a pong recently (within 12s), socket is healthy.
    // Matches the foreground heartbeat tolerance so "is it alive?" is judged
    // consistently everywhere; if it's older we still actively probe below.
    if (Date.now() - lastPongTime < 12000) {
      resolve(true);
      return;
    }

    const originalPong = handlePong;

    // Unified cleanup: restore handler and resolve
    const finish = (healthy: boolean) => {
      clearTimeout(probeTimeout);
      handlePong = originalPong;
      resolve(healthy);
    };

    // Send probe ping and wait for pong
    const probeTimeout = setTimeout(() => {
      console.log('[ws:lifecycle] Health probe timeout — socket unresponsive');
      finish(false);
    }, 3000);

    handlePong = () => {
      originalPong(); // Update lastPongTime + clear heartbeat timeout
      finish(true);
    };

    wsInstance.send(JSON.stringify({ type: 'ping' }));
  });
}

// Separated pong handler for probe interception
let handlePong = () => {
  lastPongTime = Date.now();
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
};

// Single-flight reconnect scheduler with backoff and jitter
function scheduleReconnect() {
  if (reconnectInFlight) {
    console.log('[ws:lifecycle] Reconnect already in flight — skipping');
    return;
  }

  reconnectAttempt++;
  const delay = getReconnectDelay();
  console.log(`[ws:lifecycle] scheduling reconnect in ${delay}ms (attempt ${reconnectAttempt})`);

  reconnectInFlight = new Promise<void>((resolve) => {
    reconnectTimeout = setTimeout(() => {
      connectionState = 'reconnecting';
      connect();
      reconnectInFlight = null;
      resolve();
    }, delay);
  });
}

function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case 'pong':
        handlePong();
        break;

      case 'connected':
        // Initial connection — receive thread list and presence
        threads = msg.threads;
        presence = msg.sessionStatus;
        // Only set activeThreadId on fresh connect — on reconnect, preserve whatever
        // thread the user was viewing (prevents mobile app-switch from silently
        // switching to today's daily thread while showing old messages)
        if (msg.activeThreadId && !activeThreadId) activeThreadId = msg.activeThreadId;
        routingThreadId = msg.routingThreadId ?? null;
        // Build unread counts from thread list
        for (const t of msg.threads) {
          unreadCounts[t.id] = t.unread_count;
        }
        // Command registry
        if (msg.commands) commandRegistry = msg.commands;
        // Reconnect ghost-stream cleanup: if the socket dropped mid-stream, the
        // stream_end broadcast was missed — clear stale streaming state silently
        // (no lastError toast; unlike the stale-stream watchdog path)
        if (streamingMessageId) {
          console.warn('[ws:lifecycle] Reconnected with stale streaming state — clearing ghost stream');
          if (toolOffsets[streamingMessageId]) {
            const { [streamingMessageId]: _, ...rest } = toolOffsets;
            toolOffsets = rest;
          }
          if (thinkingEvents[streamingMessageId]) {
            const { [streamingMessageId]: __, ...rest2 } = thinkingEvents;
            thinkingEvents = rest2;
          }
          streamingMessageId = null;
          streamingThreadId = null;
          streamingTokens = '';
          lastTokenAt = null;
          clearStaleStreamWatchdog();
        }
        break;

      case 'message':
        if (msg.message.thread_id === activeThreadId) {
          messages = [...messages, msg.message];
        }
        // Update last seen sequence
        if (msg.message.sequence > lastSeenSequence) {
          lastSeenSequence = msg.message.sequence;
        }
        // Update thread preview, then re-sort by last_activity_at DESC so the
        // touched thread climbs to the top of the non-pinned order immediately
        // (ThreadList re-extracts pinned by pinned_at and regroups the rest, so
        // this store order only feeds recency/grouping — safe to sort here).
        // Immutable sort (new array) so Svelte reactivity fires.
        threads = threads
          .map(t =>
            t.id === msg.message.thread_id
              ? { ...t, last_message_preview: msg.message.content.substring(0, 100), last_activity_at: msg.message.created_at }
              : t
          )
          .sort((a, b) => {
            const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
            const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : 0;
            return tb - ta;
          });
        // Local notification for companion messages (timers, system-injected)
        if (msg.message.role === 'companion') {
          const preview = msg.message.content.substring(0, 120).replace(/\n/g, ' ');
          showLocalNotification('Bytelight', preview);
        }
        break;

      case 'message_ack':
        pendingMessages = acknowledgePending(pendingMessages, msg.clientId);
        persistPendingMessages();
        break;

      case 'message_edited':
        messages = messages.map(m =>
          m.id === msg.messageId
            ? { ...m, content: msg.newContent, edited_at: msg.editedAt }
            : m
        );
        break;

      case 'message_deleted':
        messages = messages.map(m =>
          m.id === msg.messageId
            ? { ...m, deleted_at: new Date().toISOString() }
            : m
        );
        break;

      case 'stream_start':
        streamingMessageId = msg.messageId;
        streamingThreadId = msg.threadId;
        streamingTokens = '';
        lastTokenAt = Date.now();
        streamStartedAt = Date.now();
        // Idempotency for reconnect replay (ws.ts replays stream_start +
        // tool/thinking events + cumulative token to newly connected
        // sockets): drop any state already held for this message so the
        // replayed events can't double-paint chips on a client that kept
        // state across a fast reconnect. First-time stream_start is a
        // no-op here — these keys don't exist yet.
        if (toolEvents[msg.messageId]) {
          const { [msg.messageId]: _te, ...teRest } = toolEvents;
          toolEvents = teRest;
        }
        if (toolOffsets[msg.messageId]) {
          const { [msg.messageId]: _to, ...toRest } = toolOffsets;
          toolOffsets = toRest;
        }
        if (thinkingEvents[msg.messageId]) {
          const { [msg.messageId]: _th, ...thRest } = thinkingEvents;
          thinkingEvents = thRest;
        }
        resetStaleStreamWatchdog();
        break;

      case 'stream_token':
        if (streamingMessageId === msg.messageId) {
          streamingTokens = msg.token; // Replace with cumulative text from backend
          lastTokenAt = Date.now();
          resetStaleStreamWatchdog(); // Activity received — reset watchdog
        }
        break;

      case 'stream_end':
        clearStaleStreamWatchdog();
        if (msg.final) {
          const final = msg.final;
          // Always update target thread's metadata (last_message_preview / last_activity_at).
          // This is THREAD METADATA, not user activity — it must update whether or not the
          // user is currently viewing this thread, so the sidebar reflects new content.
          threads = threads.map(t =>
            t.id === final.thread_id
              ? { ...t, last_message_preview: final.content.substring(0, 100), last_activity_at: final.created_at }
              : t
          );
          if (final.thread_id === activeThreadId) {
            // Active thread: append to visible message list and advance sync cursor.
            messages = [...messages, final];
            if (final.sequence > lastSeenSequence) lastSeenSequence = final.sequence;
          } else if (final.role === 'companion') {
            // Non-active thread + companion message: bump unread so the operator sees something
            // landed in another thread. Switching INTO that thread refetches from DB
            // (loadThread) and sends a `read` event that clears the badge via unread_update.
            const prev = unreadCounts[final.thread_id] ?? 0;
            unreadCounts = { ...unreadCounts, [final.thread_id]: prev + 1 };
            threads = threads.map(t =>
              t.id === final.thread_id ? { ...t, unread_count: (t.unread_count ?? 0) + 1 } : t
            );
          }
        }
        // Local notification for streamed companion messages (unchanged — fires regardless of thread)
        if (msg.final?.role === 'companion') {
          const preview = msg.final.content.substring(0, 120).replace(/\n/g, ' ');
          showLocalNotification('Bytelight', preview);
        }
        // Clean up streaming offsets and thinking events (unchanged)
        if (streamingMessageId) {
          if (toolOffsets[streamingMessageId]) {
            const { [streamingMessageId]: _, ...rest } = toolOffsets;
            toolOffsets = rest;
          }
          if (thinkingEvents[streamingMessageId]) {
            const { [streamingMessageId]: __, ...rest2 } = thinkingEvents;
            thinkingEvents = rest2;
          }
        }
        streamingMessageId = null;
        streamingThreadId = null;
        streamingTokens = '';
        lastTokenAt = null;
        break;

      case 'presence':
        presence = msg.status;
        break;

      case 'unread_update':
        unreadCounts = { ...unreadCounts, [msg.threadId]: msg.count };
        threads = threads.map(t =>
          t.id === msg.threadId ? { ...t, unread_count: msg.count } : t
        );
        // Update read_at on messages in the current thread
        if (msg.threadId === activeThreadId && msg.count === 0) {
          const now = new Date().toISOString();
          messages = messages.map(m =>
            m.role === 'companion' && !m.read_at ? { ...m, read_at: now } : m
          );
        }
        break;

      case 'thread_created':
        threads = [{
          id: msg.thread.id,
          name: msg.thread.name,
          type: msg.thread.type,
          unread_count: 0,
          last_activity_at: msg.thread.created_at,
          last_message_preview: null,
          pinned_at: null,
        }, ...threads];
        break;

      case 'thread_list':
        threads = msg.threads;
        break;

      case 'thread_deleted':
        threads = threads.filter(t => t.id !== msg.threadId);
        if (activeThreadId === msg.threadId) {
          activeThreadId = threads.length > 0 ? threads[0].id : null;
          if (activeThreadId) loadThread(activeThreadId);
          else messages = [];
        }
        break;

      case 'thread_updated':
        threads = threads.map(t =>
          t.id === msg.thread.id ? { ...t, name: msg.thread.name, pinned_at: msg.thread.pinned_at } : t
        );
        break;

      case 'routing_thread_changed':
        routingThreadId = msg.threadId;
        break;

      case 'message_reaction_added': {
        const idx = messages.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) {
          const m = messages[idx];
          const meta = (m.metadata && typeof m.metadata === 'object') ? { ...m.metadata } : {};
          const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(meta.reactions) ? [...meta.reactions] : [];
          if (!reactions.some(r => r.emoji === msg.emoji && r.user === msg.user)) {
            reactions.push({ emoji: msg.emoji, user: msg.user, created_at: msg.createdAt });
            const updated = { ...m, metadata: { ...meta, reactions } };
            messages = [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
          }
        }
        break;
      }

      case 'message_reaction_removed': {
        const idx = messages.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) {
          const m = messages[idx];
          const meta = (m.metadata && typeof m.metadata === 'object') ? { ...m.metadata } : {};
          const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(meta.reactions) ? [...meta.reactions] : [];
          const filtered = reactions.filter(r => !(r.emoji === msg.emoji && r.user === msg.user));
          const updated = { ...m, metadata: { ...meta, reactions: filtered } };
          messages = [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
        }
        break;
      }

      case 'message_starred':
      case 'message_unstarred':
        handleStarBroadcast({ type: msg.type, messageId: msg.messageId, starredBy: msg.starredBy });
        break;

      case 'context_usage':
        contextUsage = { percentage: msg.percentage, tokensUsed: msg.tokensUsed, contextWindow: msg.contextWindow };
        break;

      case 'compaction_notice':
        compactionNotice = { preTokens: msg.preTokens, message: msg.message, isComplete: msg.isComplete };
        if (compactionTimeout) clearTimeout(compactionTimeout);
        if (msg.isComplete) {
          // Compaction finished — reset context usage and auto-hide after 8s
          contextUsage = null;
          compactionTimeout = setTimeout(() => { compactionNotice = null; }, 8000);
        }
        // When !isComplete (in-progress), no timeout — banner stays until completion
        break;

      case 'sync_response':
        if (msg.messages.length > 0) {
          // Merge missed messages, avoiding duplicates
          const existingIds = new Set(messages.map(m => m.id));
          const newMsgs = msg.messages.filter(m => !existingIds.has(m.id));
          if (newMsgs.length > 0) {
            messages = [...messages, ...newMsgs].sort((a, b) => a.sequence - b.sequence);
            const last = newMsgs[newMsgs.length - 1];
            if (last.sequence > lastSeenSequence) lastSeenSequence = last.sequence;
          }
        }
        break;

      case 'tool_use':
        resetStaleStreamWatchdog();
        if (streamingMessageId) {
          const events = toolEvents[streamingMessageId] || [];
          toolEvents = {
            ...toolEvents,
            [streamingMessageId]: [...events, {
              toolId: msg.toolId,
              toolName: msg.toolName,
              input: msg.input,
              isComplete: false,
              timestamp: new Date().toISOString(),
            }],
          };
          // Track text offset for interleaved rendering
          if (msg.textOffset !== undefined) {
            const offsets = toolOffsets[streamingMessageId] || [];
            toolOffsets = {
              ...toolOffsets,
              [streamingMessageId]: [...offsets, { toolId: msg.toolId, textOffset: msg.textOffset }],
            };
          }
        }
        break;

      case 'tool_result':
        resetStaleStreamWatchdog();
        if (streamingMessageId) {
          const currentEvents = toolEvents[streamingMessageId] || [];
          toolEvents = {
            ...toolEvents,
            [streamingMessageId]: currentEvents.map(e =>
              e.toolId === msg.toolId
                ? { ...e, output: msg.output, isError: msg.isError, isComplete: true }
                : e
            ),
          };
        }
        break;

      case 'thinking':
        resetStaleStreamWatchdog();
        if (streamingMessageId) {
          const existing = thinkingEvents[streamingMessageId] || [];
          thinkingEvents = {
            ...thinkingEvents,
            [streamingMessageId]: [...existing, {
              content: msg.content,
              summary: msg.summary,
              textOffset: streamingTokens.length,
              ...(msg.kind ? { kind: msg.kind } : {}),
            }],
          };
        }
        break;

      case 'voice_mode_ack':
        voiceModeEnabled = msg.enabled;
        break;

      case 'transcription_status':
        transcriptionStatus = msg.status;
        transcriptionRecordingId = msg.recordingId ?? null;
        if (msg.status === 'complete') {
          transcriptionText = msg.text ?? null;
          transcriptionProsody = msg.prosody ?? null;
          transcriptionProsodyStatus = msg.prosodyStatus ?? null;
          transcriptionError = null;
        } else if (msg.status === 'error') {
          transcriptionError = msg.error ?? 'Transcription failed';
          transcriptionText = null;
          transcriptionProsody = null;
          transcriptionProsodyStatus = null;
        } else {
          transcriptionText = null;
          transcriptionError = null;
          transcriptionProsody = null;
          transcriptionProsodyStatus = null;
        }
        break;

      case 'tts_start':
        ttsPlaying = true;
        ttsMessageId = msg.messageId;
        break;

      case 'tts_audio':
        ttsAudioQueue = [...ttsAudioQueue, { messageId: msg.messageId, data: msg.data, final: msg.final }];
        break;

      case 'tts_end':
        ttsMessageId = null;
        // ttsPlaying stays true until AudioAutoPlayer finishes playback
        break;

      case 'system_status':
        setSystemStatus(msg.status);
        break;

      case 'canvas_created':
        canvases = [msg.canvas, ...canvases];
        break;

      case 'canvas_updated': {
        canvases = canvases.map(c =>
          c.id === msg.canvasId
            ? {
                ...c,
                content: msg.content,
                updated_at: msg.updatedAt,
                ...(msg.title !== undefined && { title: msg.title }),
                ...(msg.tags !== undefined && { tags: msg.tags }),
              }
            : c
        );
        break;
      }

      case 'canvas_deleted':
        canvases = canvases.filter(c => c.id !== msg.canvasId);
        if (activeCanvasId === msg.canvasId) activeCanvasId = null;
        break;

      case 'canvas_list':
        canvases = msg.canvases;
        break;

      case 'memory_block_updated':
        // A memory block changed (companion tool edit, CLI, or the operator's panel).
        // Bump the version signal; the Memory panel re-fetches on the change.
        memoryBlockVersion++;
        break;

      case 'generation_stopped':
        clearStaleStreamWatchdog();
        streamingMessageId = null;
        streamingThreadId = null;
        streamingTokens = '';
        lastTokenAt = null;
        break;

      case 'rate_limit':
        rateLimitInfo = { status: msg.status, resetsAt: msg.resetsAt, rateLimitType: msg.rateLimitType };
        if (rateLimitTimeout) clearTimeout(rateLimitTimeout);
        // Warn, then get out of the way: a weekly-window reset can be DAYS
        // out, and holding the banner until then blocks the screen for the
        // whole wait. Two minutes is the ceiling; the Limits tab carries the
        // durable state.
        const clearMs = Math.min(
          msg.resetsAt ? Math.max(0, msg.resetsAt * 1000 - Date.now()) + 2000 : 30000,
          120_000,
        );
        rateLimitTimeout = setTimeout(() => { rateLimitInfo = null; }, clearMs);
        break;

      case 'limit_warning': {
        const reset = msg.resetsAt ? new Date(msg.resetsAt) : null;
        const resetNote = reset && !Number.isNaN(reset.getTime())
          ? ` · resets ${reset.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
          : '';
        showToast(`${msg.label} at ${msg.percent}%${resetNote}`, 'info', 120_000);
        break;
      }

      case 'tool_progress':
        resetStaleStreamWatchdog();
        if (streamingMessageId) {
          const currentEvents = toolEvents[streamingMessageId] || [];
          toolEvents = {
            ...toolEvents,
            [streamingMessageId]: currentEvents.map(e =>
              e.toolId === msg.toolId ? { ...e, elapsed: msg.elapsed } : e
            ),
          };
        }
        break;

      case 'mcp_status_updated':
        // Update system status MCP servers if we have a cached status
        setSystemStatus(null, msg.servers);
        break;

      case 'rewind_result':
        rewindResult = { canRewind: msg.canRewind, filesChanged: msg.filesChanged, insertions: msg.insertions, deletions: msg.deletions, error: msg.error };
        break;

      case 'command_result':
        lastCommandResult = { name: msg.name, success: msg.success, data: msg.data, error: msg.error, display: msg.display };
        // Inject as a system message in chat
        if (msg.display !== 'silent' && activeThreadId) {
          const text = msg.error
            ? `/${msg.name}: ${msg.error}`
            : (msg.data as Record<string, unknown>)?.message as string || `/${msg.name}: done`;
          const sysMsg: Message = {
            id: `cmd-${Date.now()}`,
            thread_id: activeThreadId,
            sequence: messages.length > 0 ? messages[messages.length - 1].sequence + 1 : 1,
            role: 'system',
            content: text,
            content_type: 'text',
            platform: 'web',
            // Carry the full command_result envelope so structured cards
            // (e.g. /subagents) can render in MessageBubble; plain toasts
            // ignore it and fall back to the system-text render.
            // Ported from reference implementation (reference implementation) — adapted for byte-light.
            metadata: {
              kind: 'command_result',
              commandName: msg.name,
              success: msg.success,
              data: msg.data ?? null,
            },
            companion_id: null,
            reply_to_id: null,
            reply_to_preview: null,
            original_content: null,
            created_at: new Date().toISOString(),
            edited_at: null,
            deleted_at: null,
            delivered_at: null,
            read_at: null,
            client_id: null,
          };
          messages = [...messages, sysMsg];
        }
        break;

      case 'error':
        console.error(`Server error [${msg.code}]: ${msg.message}`);
        lastError = { code: msg.code, message: msg.message };
        // Agent timeout means the stream is dead — clear stuck streaming state
        if (msg.code === 'agent_timeout' && streamingMessageId) {
          console.warn('[ws:lifecycle] Agent timeout — clearing streaming state');
          clearStaleStreamWatchdog();
          // Clean up tool/thinking state
          if (toolOffsets[streamingMessageId]) {
            const { [streamingMessageId]: _, ...rest } = toolOffsets;
            toolOffsets = rest;
          }
          if (thinkingEvents[streamingMessageId]) {
            const { [streamingMessageId]: __, ...rest2 } = thinkingEvents;
            thinkingEvents = rest2;
          }
          streamingMessageId = null;
          streamingThreadId = null;
          streamingTokens = '';
        }
        // Auto-clear error after 10 seconds
        setTimeout(() => { lastError = null; }, 10000);
        break;
    }
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
  }
}

export function connect() {
  if (wsInstance?.readyState === WebSocket.OPEN || wsInstance?.readyState === WebSocket.CONNECTING) return;

  clearTimers();
  const url = getWebSocketUrl();

  try {
    wsInstance = new WebSocket(url);
    connectionState = reconnectAttempt > 0 ? 'reconnecting' : 'disconnected';

    wsInstance.onopen = () => {
      console.log('[ws:lifecycle] connected');
      connectionState = 'connected';
      reconnectAttempt = 0;
      lastError = null;
      intentionalClose = false;
      closeReason = 'unknown';
      startHeartbeat();

      // Send initial tab visibility state
      tabVisible = !document.hidden;
      send({ type: 'visibility', visible: tabVisible });

      // Track tab visibility changes (single listener, cleaned up on disconnect)
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = async () => {
        const wasHidden = !tabVisible;
        tabVisible = !document.hidden;
        send({ type: 'visibility', visible: tabVisible });

        // Adjust heartbeat cadence based on visibility
        if (wsInstance?.readyState === WebSocket.OPEN) {
          scheduleNextHeartbeat();
        }

        // When becoming visible after being hidden, probe socket health.
        // The user is actively back, so reconnect WITHOUT backoff delay —
        // reset the attempt counter so any reconnect is immediate, not dawdling.
        if (tabVisible && wasHidden) {
          console.log('[ws:lifecycle] Tab visible — checking socket health');
          if (wsInstance?.readyState === WebSocket.OPEN) {
            const healthy = await sendHealthProbe();
            if (!healthy) {
              // Socket is open but unresponsive — close it and let onclose reconnect fast
              console.log('[ws:lifecycle] Socket unhealthy after resume — closing');
              closeReason = 'heartbeat_timeout';
              reconnectAttempt = 0; // skip backoff — user is right here
              wsInstance?.close();
            }
          } else if (wsInstance?.readyState === WebSocket.CLOSED || !wsInstance) {
            // Socket already closed while suspended — reconnect immediately
            console.log('[ws:lifecycle] Socket closed while hidden — reconnecting now');
            if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
            reconnectInFlight = null;
            reconnectAttempt = 0;
            connectionState = 'reconnecting';
            connect();
          }
          // If CONNECTING, do nothing — already in progress
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);

      // Sync if reconnecting
      if (lastSeenSequence > 0 && activeThreadId) {
        send({
          type: 'sync',
          lastSeenSequence,
          threadId: activeThreadId,
        });
      }

      // Retry every unacknowledged message. Keep it in the outbox until the
      // backend confirms the durable database row.
      if (pendingMessages.length > 0) {
        const socket = wsInstance;
        if (!socket) return;
        for (const msg of pendingMessages) {
          socket.send(JSON.stringify(msg));
        }
      }
    };

    wsInstance.onmessage = handleMessage;

    wsInstance.onclose = (event: CloseEvent) => {
      const reason = closeReason;
      console.log(`[ws:lifecycle] closed (intentional=${intentionalClose}, reason=${reason}, code=${event.code}, wasClean=${event.wasClean}, serverReason="${event.reason || ''}")`);
      connectionState = 'disconnected';
      clearTimers();

      if (intentionalClose) {
        intentionalClose = false;
        closeReason = 'unknown';
        return;
      }

      scheduleReconnect();
    };

    wsInstance.onerror = (err) => {
      closeReason = 'socket_error';
      console.error('[ws:lifecycle] WebSocket error:', err);
    };
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    connectionState = 'disconnected';
  }
}

export function disconnect(reason: 'manual' = 'manual') {
  clearTimers();
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  if (wsInstance) {
    intentionalClose = true;
    closeReason = reason;
    console.log(`[ws:lifecycle] intentional disconnect (reason=${reason})`);
    connectionState = 'disconnecting';
    wsInstance.close();
    wsInstance = null;
  }
  connectionState = 'disconnected';
  reconnectAttempt = 0;
  reconnectInFlight = null;
  closeReason = 'unknown';
}

export function send(msg: ClientMessage) {
  // Stamp every outgoing user message with a clientId so the backend can
  // dedupe retries (reconnect drains, double-clicks, transient socket
  // hiccups). Reuse caller-provided ids when present (e.g. on drain).
  if (msg.type === 'message' && !msg.clientId) {
    msg.clientId = crypto.randomUUID();
  }
  if (msg.type === 'message') {
    const pending = msg as PendingMessage;
    pendingMessages = upsertPending(pendingMessages, pending);
    persistPendingMessages();
  }
  if (wsInstance?.readyState === WebSocket.OPEN) {
    wsInstance.send(JSON.stringify(msg));
  } else if (msg.type === 'message') {
    console.warn('Message queued — will send on reconnect');
  } else {
    console.warn('Cannot send: WebSocket not connected');
  }
}

export async function loadThread(threadId: string) {
  activeThreadId = threadId;
  // A normal thread load restores the tail view — leaving any prior
  // around-window mode so pagination behaves normally again.
  isViewingAround = false;
  try {
    const response = await fetch(`/api/threads/${threadId}/messages`);
    if (!response.ok) throw new Error('Failed to load messages');
    const data = await response.json();
    messages = data.messages || [];
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.sequence > lastSeenSequence) lastSeenSequence = last.sequence;
    }
    // Mark as read (best-effort — don't block thread loading if WS is down)
    if (messages.length > 0) {
      try { send({ type: 'read', threadId, beforeId: messages[messages.length - 1].id }); } catch {}
    }
  } catch (err) {
    console.error('Failed to load thread:', err);
    messages = [];
  }
}

// Load older messages (pagination — prepend to existing)
// Returns true if there were more messages, false if we've reached the beginning
export async function loadOlderMessages(threadId: string): Promise<boolean> {
  if (messages.length === 0) return false;
  const oldestMessage = messages[0];
  try {
    const response = await fetch(`/api/threads/${threadId}/messages?before=${oldestMessage.id}&limit=50`);
    if (!response.ok) throw new Error('Failed to load older messages');
    const data = await response.json();
    const older = data.messages || [];
    if (older.length === 0) return false;
    messages = [...older, ...messages];
    return older.length >= 50; // If we got a full page, there might be more
  } catch (err) {
    console.error('Failed to load older messages:', err);
    return false;
  }
}

// Load a window of messages centered on a specific message id. Used by
// search-result jumps so a hit on a message older than the loaded tail can be
// scrolled to without paging through every batch in between. Switches the
// active thread if needed, replaces `messages` with the window, and sets
// `isViewingAround` so the chat page's pagination doesn't immediately fire and
// clobber the window.
export async function loadThreadAround(threadId: string, messageId: string, windowSize = 50): Promise<void> {
  if (activeThreadId !== threadId) activeThreadId = threadId;
  try {
    const response = await fetch(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=${windowSize}`);
    if (!response.ok) throw new Error('Failed to load thread around message');
    const data = await response.json();
    messages = data.messages || [];
    isViewingAround = true;
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.sequence > lastSeenSequence) lastSeenSequence = last.sequence;
    }
  } catch (err) {
    console.error('Failed to load thread around message:', err);
    messages = [];
    isViewingAround = false;
  }
}

export function isViewingAroundWindow(): boolean { return isViewingAround; }

// Pending-jump guard: while set, the chat page suppresses its auto-scroll-to-
// bottom effects so they don't override the scroll onto the search target.
export function setPendingJump(id: string | null): void { pendingJumpMessageId = id; }
export function getPendingJump(): string | null { return pendingJumpMessageId; }

export async function loadThreads() {
  try {
    const response = await fetch('/api/threads');
    if (!response.ok) throw new Error('Failed to load threads');
    const data = await response.json();
    threads = data.threads || [];
  } catch (err) {
    console.error('Failed to load threads:', err);
    threads = [];
  }
}

// Getters for reactive state
export function getConnectionState() { return connectionState; }
export function getMessages() { return messages; }
export function getThreads() { return threads; }
export function getActiveThreadId() { return activeThreadId; }
export function getRoutingThreadId() { return routingThreadId; }
export function getPresence() { return presence; }
export function getUnreadCounts() { return unreadCounts; }
export function getStreamingState() {
  return { messageId: streamingMessageId, threadId: streamingThreadId, tokens: streamingTokens };
}
export function getLastError() { return lastError; }
export function getPendingCount() { return pendingMessages.length; }
export function clearError() { lastError = null; }
export function getToolEvents() { return toolEvents; }
export function getLastTokenAt() { return lastTokenAt; }

// Compute interleaved segments for the currently streaming message
export function getStreamingSegments(): MessageSegment[] | null {
  if (!streamingMessageId) return null;
  const offsets = toolOffsets[streamingMessageId] || [];
  const thinking = thinkingEvents[streamingMessageId] || [];
  if (offsets.length === 0 && thinking.length === 0) return null;

  const events = toolEvents[streamingMessageId] || [];
  const eventMap = new Map(events.map(e => [e.toolId, e]));

  // Merge all insertions into one sorted list
  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; toolId: string }
    | { kind: 'thinking'; content: string; summary: string; thoughtKind?: ThoughtKind }
  );

  const allInsertions: Insertion[] = [
    ...offsets.map(o => ({ textOffset: o.textOffset, kind: 'tool' as const, toolId: o.toolId })),
    ...thinking.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, content: t.content, summary: t.summary, thoughtKind: t.kind })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const text = streamingTokens;
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of allInsertions) {
    const offset = Math.min(ins.textOffset, text.length);
    if (offset > cursor) {
      segments.push({ type: 'text', content: text.slice(cursor, offset) });
    }
    if (ins.kind === 'tool') {
      const ev = eventMap.get(ins.toolId);
      segments.push({
        type: 'tool',
        toolId: ins.toolId,
        toolName: ev?.toolName || 'unknown',
        input: ev?.input,
        output: ev?.output,
        isError: ev?.isError,
      });
    } else {
      // Kindless events build the exact legacy segment shape (no `kind`
      // key) so streaming render matches pre-Slice-3 persisted output.
      segments.push({
        type: 'thinking',
        content: ins.content,
        summary: ins.summary,
        ...(ins.thoughtKind ? { kind: ins.thoughtKind } : {}),
      });
    }
    cursor = offset;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', content: text.slice(cursor) });
  }

  return segments;
}

// Voice getters
export function getVoiceModeEnabled() { return voiceModeEnabled; }
export function getTranscriptionStatus() { return transcriptionStatus; }
export function getTranscriptionText() { return transcriptionText; }
export function getTranscriptionError() { return transcriptionError; }
export function getTranscriptionProsody() { return transcriptionProsody; }
export function getTranscriptionRecordingId() { return transcriptionRecordingId; }
export function getTranscriptionProsodyStatus() { return transcriptionProsodyStatus; }
export function clearTranscription() {
  transcriptionStatus = 'idle';
  transcriptionText = null;
  transcriptionError = null;
  transcriptionProsody = null;
  transcriptionRecordingId = null;
  transcriptionProsodyStatus = null;
}

// TTS getters
export function getTtsPlaying() { return ttsPlaying; }
export function getTtsAudioQueue() { return ttsAudioQueue; }
export function dequeueTtsAudio() {
  if (ttsAudioQueue.length === 0) return null;
  const [item, ...rest] = ttsAudioQueue;
  ttsAudioQueue = rest;
  return item;
}
export function setTtsPlaying(playing: boolean) { ttsPlaying = playing; }

// Context usage getters
export function getContextUsage() { return contextUsage; }
export function getCompactionNotice() { return compactionNotice; }

// Canvas getters & actions
export function getCanvases() { return canvases; }
export function getActiveCanvasId() { return activeCanvasId; }

// Memory-block live-update signal (see memoryBlockVersion above).
export function getMemoryBlockVersion() { return memoryBlockVersion; }
export function setActiveCanvasId(id: string | null) { activeCanvasId = id; }
export function sendCanvasCreate(title: string, contentType: 'markdown' | 'code' | 'text' | 'html', language?: string, threadId?: string, tags?: string[]) {
  send({ type: 'canvas_create', title, contentType, language, threadId, tags });
}
export function sendCanvasUpdate(canvasId: string, content: string) {
  send({ type: 'canvas_update', canvasId, content });
  // Optimistically update local store (server broadcasts to others via broadcastExcept)
  canvases = canvases.map(c =>
    c.id === canvasId
      ? { ...c, content, updated_at: new Date().toISOString() }
      : c
  );
}
export function sendCanvasUpdateTitle(canvasId: string, title: string) {
  send({ type: 'canvas_update_title', canvasId, title });
}
export function sendCanvasUpdateTags(canvasId: string, tags: string[]) {
  send({ type: 'canvas_update_tags', canvasId, tags });
  canvases = canvases.map(c =>
    c.id === canvasId
      ? { ...c, tags, updated_at: new Date().toISOString() }
      : c
  );
}
export function sendCanvasDelete(canvasId: string) {
  send({ type: 'canvas_delete', canvasId });
}

// Stop generation
export function sendStopGeneration() {
  // Clear local state immediately so UI recovers even if websocket is dead
  streamingMessageId = null;
  streamingThreadId = null;
  streamingTokens = '';
  // Attempt to tell backend (may fail if disconnected, but that's okay now)
  send({ type: 'stop_generation' });
}
export function isStreaming() { return streamingMessageId !== null; }

// Rate limit
export function getRateLimitInfo() { return rateLimitInfo; }

// MCP control
export function sendMcpReconnect(serverName: string) {
  send({ type: 'mcp_reconnect', serverName });
}
export function sendMcpToggle(serverName: string, enabled: boolean) {
  send({ type: 'mcp_toggle', serverName, enabled });
}

// File rewind
export function sendRewindFiles(userMessageId: string, dryRun?: boolean) {
  send({ type: 'rewind_files', userMessageId, dryRun });
}
export function getRewindResult() { return rewindResult; }

// Command system
export function getCommandRegistry() { return commandRegistry; }
export function getLastCommandResult() { return lastCommandResult; }
export function clearCommandResult() { lastCommandResult = null; }
export function sendCommand(name: string, args?: string, threadId?: string) {
  send({ type: 'command', name, args, threadId });
}
