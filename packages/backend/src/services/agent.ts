import { query, AbortError, listSessions, type Options, type Query, type McpServerConfig, type ListSessionsOptions, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerInfo, Message } from '@bytelight/shared';
import { resolveEffortForModel, normalizeModelRef, type ModelRef } from '@bytelight/shared';
import { createMessage, updateThreadSession, clearAllThreadSessions, getThread, updateThreadActivity, createSessionRecord, endSessionRecord, recordUsageEvent, getProviderSession, setProviderSession, clearProviderSessionsForThread, hasAnyProviderSessionForThread, getMostRecentProviderSession, getMessages, getConfig as getDbConfig, setConfig as setDbConfig } from './db.js';
import { buildBridgeBlock, decideBridge, shouldRecycleCodexSession } from './agent-bridge.js';
// Slice 3b seam: runtime doors + provider-key mapping + canonical-consumer helpers.
import { resolveRuntimeForRef } from './runtimes/index.js';
import type { NormalizedImage, NormalizedMessage, ToolDefinition } from './runtimes/types.js';
import { sidecarProviderFor } from './agent/sidecar.js';
// Slice 5a: turn-time model resolution through companion_settings
// (thread > companion > system > config) — tag wiring template
// stable-pre-rollback-2026-06-20 agent.ts:20/651.
import { resolveModelForTurn } from './agent/model-resolution.js';
import { buildAgentTurnInput } from './agent/turn-input.js';
import { attachImagesToLatestUserMessage } from './agent/attachment-images.js';
import { rewriteCodexSkillInvocation } from './agent/codex-skill-invocation.js';
import { computeContextUsageUpdate } from './agent/context-usage.js';
import { buildUsageEventRow } from './agent/usage-event-row.js';
import { getManagedServerConfigs, getRouterTools, type ToolSchema } from './mcp-bridge.js';
import { runtimeNeedsRouterToolPayload } from './runtime-tool-delivery.js';
import { ambientRecall, unfiledNoticings } from './heartbeat/whisper.js';
import { scanSkills } from './skills.js';
import { runWithBeltContext } from './chat-tool-belt.js';
import { estimateCost } from './usage-pricing.js';
import { registry } from './registry.js';
import { createHooks, buildOrientationContext, summarizeInput, type HookContext, type ToolInsertion } from './hooks.js';
import type { MessageSegment, ThoughtKind } from '@bytelight/shared';
import type { PushService } from './push.js';
import { getBytelightConfig } from '../config.js';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { stickerRefsToImageBlocks, capImageBlocks, fileToImageBlock, isEmbeddableImage, normalizedImagesToImageBlocks, type ImageBlock } from './visual-blocks.js';
import { getFile } from './files.js';
import { drainQueuedImages } from './pending-visuals.js';
import { recordActivity } from './activity-ring.js';
// Reconnect catch-up: in-flight turns register here so the ws layer can
// replay stream state to sockets that (re)connect mid-turn.
import { registerActiveStream, unregisterActiveStream } from './active-streams.js';
import { getMemoryMcpServer } from './memory-mcp.js';

// Lazy-init: config isn't available at import time — defer until first use
let _initialized = false;
let claudeMdContent = '';
let AGENT_CWD = '';
const mcpServersFromConfig: Record<string, McpServerConfig> = {};

// Keywords that suggest Mind MCP tools are needed
const MIND_KEYWORDS = [
  'remember', 'forget', 'memory', 'memories',
  'feel', 'feeling', 'feelings', 'mood',
  'dream', 'journal', 'identity',
  'tension', 'resolve', 'sit with',
  'pattern', 'patterns', 'emotion', 'emotions',
  'weather', 'anchor', 'ground', 'grounding'
];

// Filter MCP servers based on context - excludes Mind MCP when not needed
// AND honors the persistent user-disabled list (mcp.disabled_servers in DB).
// The disable-list always wins, even on autonomous wakes / first message.
function filterMcpServers(
  servers: Record<string, McpServerConfig>,
  opts: { isAutonomous: boolean; isFirstMessage: boolean; userMessage?: string }
): Record<string, McpServerConfig> {
  // Strip user-disabled servers first — these never come back without a toggle
  const disabled = getDisabledMcpServers();
  let scoped: Record<string, McpServerConfig> = servers;
  if (disabled.size > 0) {
    scoped = {};
    for (const [name, config] of Object.entries(servers)) {
      if (disabled.has(name)) {
        console.log(`[MCP] Skipping "${name}" (disabled by user)`);
        continue;
      }
      scoped[name] = config;
    }
  }

  // Autonomous wakes need everything (orientation, memory access)
  if (opts.isAutonomous) return scoped;
  // First message of session needs everything (companion orienting)
  if (opts.isFirstMessage) return scoped;

  // Check if user message suggests Mind tools are needed
  const needsMind = opts.userMessage && MIND_KEYWORDS.some(kw =>
    opts.userMessage!.toLowerCase().includes(kw)
  );

  if (needsMind) return scoped;

  // Filter out Mind MCP servers (any server name containing 'mind', case insensitive)
  const filtered: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(scoped)) {
    if (!name.toLowerCase().includes('mind')) {
      filtered[name] = config;
    }
  }
  return filtered;
}

function ensureInit() {
  if (_initialized) return;
  _initialized = true;
  const config = getBytelightConfig();
  AGENT_CWD = config.agent.cwd;

  // Load CLAUDE.md
  const candidates = [
    config.agent.claude_md_path,
    join(AGENT_CWD, '.claude/CLAUDE.md'),
    join(AGENT_CWD, 'CLAUDE.md'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) {
      claudeMdContent = readFileSync(candidate, 'utf-8');
      console.log(`Loaded CLAUDE.md from: ${candidate} (${claudeMdContent.length} chars)`);
      break;
    }
  }

  // Load .mcp.json
  const mcpJsonPath = config.agent.mcp_json_path;
  if (existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpJson.mcpServers) {
        for (const [name, mcpCfg] of Object.entries(mcpJson.mcpServers) as [string, any][]) {
          if (mcpCfg.type === 'url' || mcpCfg.type === 'http') {
            mcpServersFromConfig[name] = { type: 'http', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (mcpCfg.type === 'sse') {
            mcpServersFromConfig[name] = { type: 'sse', url: mcpCfg.url, headers: mcpCfg.headers };
          } else if (!mcpCfg.type || mcpCfg.type === 'stdio') {
            mcpServersFromConfig[name] = { command: mcpCfg.command, args: mcpCfg.args, env: mcpCfg.env };
          }
        }
        console.log(`Loaded ${Object.keys(mcpServersFromConfig).length} MCP servers from .mcp.json: ${Object.keys(mcpServersFromConfig).join(', ')}`);
      }
    } catch (err) {
      console.warn('Failed to load .mcp.json:', err instanceof Error ? err.message : err);
    }
  }

  // In-process core-memory MCP server (Slice 3, ported from reference implementation's
  // memory-mcp.ts). Registered the same way reference implementation registers its own
  // memory server; the name is 'byte-memory' under identity quarantine. Gives
  // the claude-sdk lane the core_memory_view/append/replace/rethink tools. The
  // 'memory' substring means filterMcpServers' Mind-gate leaves it in only on
  // memory-relevant turns; that gate keys on the server NAME, and 'byte-memory'
  // does not contain 'mind', so it is never dropped — it is always available.
  mcpServersFromConfig['byte-memory'] = getMemoryMcpServer();
}

// ---------------------------------------------------------------------------
// Persistent MCP disable list — survives between queries, layered onto
// Bytelight's filterMcpServers above. Toggle UI writes here; query-start
// enforcement and getMcpStatus() read here.
// ---------------------------------------------------------------------------

function getDisabledMcpServers(): Set<string> {
  try {
    const raw = getDbConfig('mcp.disabled_servers');
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function setDisabledMcpServers(disabled: Set<string>): void {
  setDbConfig('mcp.disabled_servers', JSON.stringify([...disabled]));
}

// ---------------------------------------------------------------------------
// Model + thinking-effort resolution — checks DB config, YAML config, env, then defaults
// (MCP keyword-gating from reference implementation/587af7d + ee9bd89 skipped — Bytelight's
//  filterMcpServers above is the architecture-of-record for dynamic MCP filtering.
//  The disable-list above is layered into filterMcpServers, not into a parallel
//  buildMcpServersForQuery.)
// ---------------------------------------------------------------------------
// Slice 5a: no longer called by _processQuery (resolveModelForTurn owns
// turn-time resolution). Kept + exported as the parity ORACLE — the exact
// pre-5a chain (DB > YAML > env > default) that the resolver's
// systemFallback must reproduce with zero applicable companion_settings
// rows. Pinned by agent.model-resolution-parity.test.ts.
export function getConfiguredModel(isAutonomous: boolean): string {
  const dbKey = isAutonomous ? 'agent.model_autonomous' : 'agent.model';
  const dbValue = getDbConfig(dbKey);
  if (dbValue) return dbValue;

  const cfg = getBytelightConfig();
  const yamlValue = isAutonomous ? cfg.agent.model_autonomous : cfg.agent.model;
  if (yamlValue) return yamlValue;

  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;

  return 'claude-sonnet-4-6';
}

// ---------------------------------------------------------------------------
// Runtime descriptor resolution — which engine executes a turn, and which
// provider it answers to. Resolved ONCE per _processQuery invocation and
// threaded to BOTH provider-session sidecar call sites (read + write) so the
// filing key cannot drift between them — parity by construction.
//
// Vocabulary aligns with the Ollama vertical slice (e600a13, flagged OFF,
// not in this tree's history): RuntimeId values 'claude-sdk' vs
// 'ollama-native' / 'openai-compat' / 'codex', gates spelled
// `runtime.id === 'claude-sdk'`. Provider stays 'anthropic' because that is
// what every existing sidecar row on disk is filed under — resume
// continuity for live threads outranks e600a13's catalog spelling
// ('claude'); reconcile when the model manifest lands (Slice 3+).
//
// Single-engine reality today: every routable model runs on the Claude
// Agent SDK against Anthropic, so this returns a constant regardless of
// `model`. When second engines arrive (Slices 3-4), this is the one seam
// that learns to map model → engine; both sidecar call sites inherit the
// mapping for free.
// ---------------------------------------------------------------------------
export interface RuntimeDescriptor {
  runtimeId: string;
  /** Raw ProviderId from the model manifest ('claude' for every live
   *  model today). Sidecar call sites map this through
   *  `sidecarProviderFor` ('claude' → 'anthropic') so on-disk filing
   *  stays byte-identical to the pre-3b constant descriptor. */
  provider: string;
  /** Typed ref — canonical `<provider>/<model>`, runtime lane,
   *  provider-native id. Consumed by the dual-path dispatch gate and
   *  the usage-attribution fields. */
  modelRef: ModelRef;
}

// Slice 3b: real resolution (was a `{ claude-sdk, anthropic }` constant
// stub). `normalizeModelRef` routes BARE model ids — which is every value
// `getConfiguredModel` can produce today ('claude-sonnet-4-6' defaults,
// MODEL_VARIANTS modelApiIds incl. dated + '[1m]' forms) — to the claude
// lane: manifest hit or legacy fallback, both yield runtime 'claude-sdk' /
// provider 'claude'. Pinned by agent.runtime-descriptor.test.ts.
// Exported for that test.
//
// resolveRuntimeForRef (the dispatcher) is deliberately NOT called here:
// it is called inside the foreign dispatch branch (inside the try) so a
// mis-set ref fails as a caught turn error, not as an uncaught throw
// before the try block. Claude refs never touch the dispatcher — the
// raw-SDK query() lane below is preserved verbatim.
export function resolveRuntimeDescriptor(model: string): RuntimeDescriptor {
  const modelRef = normalizeModelRef(model);
  return { runtimeId: modelRef.runtime, provider: modelRef.provider, modelRef };
}

/**
 * Get the configured thinking effort value for a given tier.
 *
 * Tier resolution rules:
 * - `'interactive'`: reads `agent.thinking_effort` (DB > YAML > 'auto').
 *   This is the historical field; semantics are unchanged for users who
 *   haven't set the autonomous override.
 * - `'autonomous'`: reads `agent.thinking_effort_autonomous` first
 *   (DB > YAML), falls back to the global `agent.thinking_effort`
 *   (DB > YAML > 'auto') when the autonomous override is unset.
 *   Back-compat: an unset autonomous override means "match chat" —
 *   identical behavior to before this field existed.
 *
 * Returns the configured value verbatim. The actual resolution to a
 * concrete SDK effort level (handling 'auto', validating per model)
 * happens in `resolveEffortForModel()` at the call site, after the
 * tier's model has been resolved.
 */
function getConfiguredThinkingEffort(tier: 'interactive' | 'autonomous'): string {
  const cfg = getBytelightConfig();

  if (tier === 'autonomous') {
    // Autonomous-specific override wins if explicitly set.
    const dbAutoValue = getDbConfig('agent.thinking_effort_autonomous');
    if (dbAutoValue) return dbAutoValue;
    const yamlAutoValue = cfg.agent.thinking_effort_autonomous;
    if (yamlAutoValue) return String(yamlAutoValue);
    // Fall through to the global value — preserves pre-PR-#10 behavior.
  }

  const dbValue = getDbConfig('agent.thinking_effort');
  if (dbValue) return dbValue;
  // Default 'auto' — see PR #8/9 commentary above.
  return cfg.agent.thinking_effort || 'auto';
}


// Presence state
let presenceStatus: 'active' | 'dormant' | 'waking' | 'offline' = 'offline';

// Context window tracking
let contextTokensUsed = 0;
let contextWindowSize = 0;

// Active query tracking (for abort, MCP control, rewind)
let activeAbortController: AbortController | null = null;
let activeQuery: Query | null = null;

// Safety timeout: abort hung queries after 5 minutes of no stream activity
const AGENT_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

function resetSafetyTimer(): void {
  if (safetyTimer) clearTimeout(safetyTimer);
  if (!activeAbortController) return;
  safetyTimer = setTimeout(() => {
    if (activeAbortController) {
      console.error('[Agent] Safety timeout — aborting hung query (no activity for 5 minutes)');
      activeAbortController.abort();
      registry.broadcast({ type: 'generation_stopped' });
    }
  }, AGENT_SAFETY_TIMEOUT_MS);
}

function clearSafetyTimer(): void {
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Transient SDK Socket Error Handling
// Handles EPIPE/ECONNRESET from Claude Agent SDK control stream
// ---------------------------------------------------------------------------

const TRANSIENT_AGENT_SOCKET_ERRORS = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_STREAM_WRITE_AFTER_END',
]);

function isTransientAgentSocketError(err: unknown): boolean {
  const anyErr = err as any;
  const code = anyErr?.code;
  const message = anyErr?.message || String(err);

  return (
    TRANSIENT_AGENT_SOCKET_ERRORS.has(code) ||
    /EPIPE|ECONNRESET|ECONNABORTED|ETIMEDOUT|write after end|socket|stream|Query closed before response received/i.test(message)
  );
}

let transientAgentSocketErrorCount = 0;
let transientAgentSocketErrorWindowStartedAt = Date.now();

function recordTransientAgentSocketError(context: string, err: unknown): void {
  const now = Date.now();
  const oneHourMs = 60 * 60 * 1000;

  if (now - transientAgentSocketErrorWindowStartedAt > oneHourMs) {
    transientAgentSocketErrorCount = 0;
    transientAgentSocketErrorWindowStartedAt = now;
  }

  transientAgentSocketErrorCount += 1;

  const anyErr = err as any;

  console.warn('[Agent] Transient SDK socket error suppressed:', {
    context,
    countThisHour: transientAgentSocketErrorCount,
    code: anyErr?.code,
    message: anyErr?.message || String(err),
  });
}

function mapMcpStatuses(statuses: Awaited<ReturnType<Query['mcpServerStatus']>>): McpServerInfo[] {
  return statuses.map(s => ({
    name: s.name,
    status: s.status,
    error: s.error,
    toolCount: s.tools?.length ?? 0,
    tools: s.tools?.map(t => ({ name: t.name, description: t.description })),
    scope: s.scope,
  }));
}

async function refreshMcpStatusSafely(queryRef: Query, label: string): Promise<void> {
  try {
    const statuses = await queryRef.mcpServerStatus();
    cachedMcpStatus = mapMcpStatuses(statuses);
    persistMcpStatus();
    console.log(`MCP status refreshed: ${cachedMcpStatus.length} servers`);
  } catch (err) {
    if (isTransientAgentSocketError(err)) {
      recordTransientAgentSocketError(`mcpServerStatus:${label}`, err);
      return;
    }
    console.warn('Failed to get MCP status:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// QueryQueue — priority-based queue replacing boolean queryLock
// Agent SDK V1 can only run one query at a time, so we queue excess requests
// ---------------------------------------------------------------------------

const PRIORITIES = {
  web_interactive: 0,    // Owner typing in UI
  discord_owner: 1,      // Owner on Discord
  discord_other: 2,      // Other users
  autonomous: 3,         // Orchestrator wakes
} as const;

const MAX_QUEUE_DEPTH = 5;
const QUEUE_TIMEOUT_MS = 90_000;

// Slice 4A: every turn this service runs belongs to the resident shared brain
// (Companion A + Companion B are two picker seats over one brain — companions registry).
// Remote companions (Companion C) never stream through this service; their turns are
// relayed by the Living Room dispatcher and stamped with their own id there.
const LOCAL_COMPANION_ID = 'companion-a-b';

interface QueueEntry {
  priority: number;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  execute: () => Promise<string>;
  enqueuedAt: number;
}

class QueryQueue {
  private queue: QueueEntry[] = [];
  private running = false;

  get isProcessing(): boolean {
    return this.running;
  }

  get depth(): number {
    return this.queue.length;
  }

  async enqueue(priority: number, execute: () => Promise<string>): Promise<string> {
    // If idle, run immediately
    if (!this.running && this.queue.length === 0) {
      this.running = true;
      try {
        return await execute();
      } finally {
        this.running = false;
        this.processNext();
      }
    }

    // Queue is full — reject
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      const cfg = getBytelightConfig();
      return `[${cfg.identity.companion_name} is busy — please try again in a moment]`;
    }

    // Enqueue with priority
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ priority, resolve, reject, execute, enqueuedAt: Date.now() });
      // Sort by priority (lower number = higher priority)
      this.queue.sort((a, b) => a.priority - b.priority);
    });
  }

  private async processNext(): Promise<void> {
    // Prune timed-out entries
    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
        entry.resolve('[Request timed out in queue]');
        return false;
      }
      return true;
    });

    if (this.queue.length === 0) return;

    const next = this.queue.shift()!;
    this.running = true;

    try {
      const result = await next.execute();
      next.resolve(result);
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      this.processNext();
    }
  }
}

const queryQueue = new QueryQueue();

// Extract a short summary from thinking text (first sentence, capped at ~120 chars).
// Exported for the heartbeat idle outbox watcher (heartbeat/runtime.ts), which
// builds the same thinking-segment metadata for out-of-turn deliveries.
export function extractThinkingSummary(text: string): string {
  const trimmed = text.replace(/^\s+/, '');
  // Find first sentence boundary
  const match = trimmed.match(/^(.+?(?:\.\s|!\s|\?\s|\n))/);
  if (match) {
    const sentence = match[1].trim();
    if (sentence.length <= 120) return sentence;
    return sentence.slice(0, 117) + '...';
  }
  // No sentence boundary found — take first 120 chars
  if (trimmed.length <= 120) return trimmed;
  return trimmed.slice(0, 117) + '...';
}

// Exported for tests (agent.segments.test.ts) — not part of the service API.
export interface ThinkingInsertion {
  textOffset: number;
  content: string;
  summary: string;
  /** reference implementation thought-semantics kind (Slice 3). Absent = legacy/unclassified;
   *  the persisted segment then carries no `kind` key, byte-identical to
   *  pre-Slice-3 metadata. */
  kind?: ThoughtKind;
}

// Build interleaved text/tool/thinking segments from response text + insertions.
// Exported for tests (agent.segments.test.ts).
export function buildSegments(fullResponse: string, toolInsertions: ToolInsertion[], thinkingBlocks: ThinkingInsertion[] = []): MessageSegment[] {
  if (toolInsertions.length === 0 && thinkingBlocks.length === 0) return [];

  // Merge all insertions into one sorted list
  type Insertion = { textOffset: number } & (
    | { kind: 'tool'; data: ToolInsertion }
    | { kind: 'thinking'; data: ThinkingInsertion }
  );

  const allInsertions: Insertion[] = [
    ...toolInsertions.map(t => ({ textOffset: t.textOffset, kind: 'tool' as const, data: t })),
    ...thinkingBlocks.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, data: t })),
  ].sort((a, b) => a.textOffset - b.textOffset);

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const ins of allInsertions) {
    const offset = Math.min(ins.textOffset, fullResponse.length);
    if (offset > cursor) {
      segments.push({ type: 'text', content: fullResponse.slice(cursor, offset) });
    }
    if (ins.kind === 'tool') {
      segments.push({
        type: 'tool',
        toolId: ins.data.toolId,
        toolName: ins.data.toolName,
        input: ins.data.input,
        output: ins.data.output,
        isError: ins.data.isError,
      });
    } else {
      // Conditional spread: a kindless insertion persists the exact
      // pre-Slice-3 segment shape (no `kind` key) — old readers and
      // fixtures see byte-identical metadata.
      segments.push({
        type: 'thinking',
        content: ins.data.content,
        summary: ins.data.summary,
        ...(ins.data.kind ? { kind: ins.data.kind } : {}),
      });
    }
    cursor = offset;
  }

  // Trailing text after last insertion
  if (cursor < fullResponse.length) {
    segments.push({ type: 'text', content: fullResponse.slice(cursor) });
  }

  return segments;
}

export function shouldDiscardEmptyTurn(input: {
  fullResponse: string;
  stoppedByUser: boolean;
  agentTimedOut: boolean;
  endedSilently: boolean;
  hasDurableArtifacts: boolean;
}): boolean {
  if (input.fullResponse.trim()) return false;
  if (input.stoppedByUser || input.agentTimedOut) return true;
  return input.endedSilently && !input.hasDurableArtifacts;
}

// Cached MCP server status (refreshed on each query, seeded from config on first
// access, persisted to disk so the Settings panel shows real status + tools even
// after a restart).
let cachedMcpStatus: McpServerInfo[] = [];
let mcpStatusSeeded = false;
let cachedMcpStatusUpdatedAt: string | null = null;
const MCP_STATUS_PATH = './data/mcp-status.json';

function persistMcpStatus(): void {
  try {
    cachedMcpStatusUpdatedAt = new Date().toISOString();
    const payload = JSON.stringify({ updatedAt: cachedMcpStatusUpdatedAt, servers: cachedMcpStatus }, null, 2);
    writeFileSync(MCP_STATUS_PATH, payload, 'utf-8');
  } catch (err) {
    console.warn('Failed to persist MCP status:', err instanceof Error ? err.message : err);
  }
}

function loadPersistedMcpStatus(): void {
  try {
    if (!existsSync(MCP_STATUS_PATH)) return;
    const raw = readFileSync(MCP_STATUS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { updatedAt: string; servers: McpServerInfo[] };
    if (Array.isArray(data.servers)) {
      // Apply current disabled list to persisted state — toggles taken since last persist must win
      const disabled = getDisabledMcpServers();
      cachedMcpStatus = data.servers.map(s => ({
        ...s,
        status: disabled.has(s.name) ? 'disabled' : s.status,
      }));
      cachedMcpStatusUpdatedAt = data.updatedAt;
      console.log(`Loaded persisted MCP status (${cachedMcpStatus.length} servers, last updated ${data.updatedAt})`);
    }
  } catch (err) {
    console.warn('Failed to load persisted MCP status:', err instanceof Error ? err.message : err);
  }
}

function seedMcpStatusIfNeeded(): void {
  if (mcpStatusSeeded || cachedMcpStatus.length > 0) return;
  // Try persisted state first — gives real status + tool counts on cold boot
  loadPersistedMcpStatus();
  if (cachedMcpStatus.length > 0) {
    mcpStatusSeeded = true;
    return;
  }
  mcpStatusSeeded = true;
  const disabled = getDisabledMcpServers();
  // DB-managed servers seed alongside .mcp.json ones so the status panel lists
  // them before their first live connection. Once a query runs, the live SDK
  // status (mapMcpStatuses) covers both kinds — this is pre-connection only.
  let managedNames: string[] = [];
  try {
    managedNames = getManagedServerConfigs().map(s => s.name);
  } catch { /* table may not exist yet in edge boot orders — seed config servers only */ }
  const names = new Set([...Object.keys(mcpServersFromConfig), ...managedNames]);
  cachedMcpStatus = [...names].map(name => ({
    name,
    status: disabled.has(name) ? 'disabled' : 'pending',
    toolCount: 0,
  }));
}

export class AgentService {
  private pushService: PushService | null = null;

  setPushService(service: PushService): void {
    this.pushService = service;
  }

  getPresenceStatus(): 'active' | 'dormant' | 'waking' | 'offline' {
    return presenceStatus;
  }

  isProcessing(): boolean {
    return queryQueue.isProcessing;
  }

  getQueueDepth(): number {
    return queryQueue.depth;
  }

  getMcpStatus(): McpServerInfo[] {
    ensureInit();
    seedMcpStatusIfNeeded();
    const disabled = getDisabledMcpServers();
    // Merge disabled state into cached status
    const status = cachedMcpStatus.map(s => ({
      ...s,
      status: disabled.has(s.name) ? 'disabled' : s.status,
    }));
    // Add any disabled servers not in cache (e.g., never connected this session)
    for (const name of disabled) {
      if (!status.find(s => s.name === name)) {
        // Check if it exists in config
        if (mcpServersFromConfig[name]) {
          status.push({ name, status: 'disabled', toolCount: 0 });
        }
      }
    }
    return status;
  }

  getMcpStatusUpdatedAt(): string | null {
    return cachedMcpStatusUpdatedAt;
  }

  getContextUsage(): { tokensUsed: number; contextWindow: number } {
    return { tokensUsed: contextTokensUsed, contextWindow: contextWindowSize };
  }

  stopGeneration(): boolean {
    if (activeAbortController) {
      activeAbortController.abort();
      return true;
    }
    return false;
  }

  async reconnectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
    if (!activeQuery) {
      return { success: false, error: 'No active session — will apply on next message' };
    }
    try {
      await activeQuery.reconnectMcpServer(name);
      // Refresh cached status
      const statuses = await activeQuery.mcpServerStatus();
      cachedMcpStatus = mapMcpStatuses(statuses);
      persistMcpStatus();
      return { success: true };
    } catch (err) {
      if (isTransientAgentSocketError(err)) {
        recordTransientAgentSocketError('reconnectMcpServer', err);
        return { success: false, error: 'Claude control stream closed — try again on the next message' };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async toggleMcpServer(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if already in desired state — prevent duplicate calls
      const disabled = getDisabledMcpServers();
      const isCurrentlyDisabled = disabled.has(name);
      if (enabled && !isCurrentlyDisabled) return { success: true }; // already enabled
      if (!enabled && isCurrentlyDisabled) return { success: true }; // already disabled

      // Persist to DB — takes effect on next query, even if agent is idle
      if (enabled) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }
      setDisabledMcpServers(disabled);

      // Update cached status immediately so UI reflects the change
      const serverInCache = cachedMcpStatus.find(s => s.name === name);
      if (serverInCache) {
        serverInCache.status = enabled ? 'pending' : 'disabled';
        if (!enabled) serverInCache.toolCount = 0;
      } else if (!enabled) {
        // Server not in cache yet (never connected) — add it as disabled
        cachedMcpStatus.push({ name, status: 'disabled', toolCount: 0 });
      }

      // If there's an active query, also toggle in the live session (best-effort)
      if (activeQuery) {
        try {
          await activeQuery.toggleMcpServer(name, enabled);
          const statuses = await activeQuery.mcpServerStatus();
          cachedMcpStatus = mapMcpStatuses(statuses);
          persistMcpStatus();
        } catch { /* best-effort */ }
      }

      // Re-enabling requires a fresh session to fully reconnect SDK-managed servers.
      // Clear all active sessions so the next message starts clean. Cross-model
      // continuity is preserved by agent-bridge.ts (history injection on fresh session).
      if (enabled) {
        try {
          clearAllThreadSessions();
          console.log(`[MCP] Cleared sessions to force MCP reconnect on next message`);
        } catch { /* best-effort */ }
      }

      console.log(`[MCP] ${name} ${enabled ? 'enabled' : 'disabled'} (persistent)`);
      return { success: true };
    } catch (err) {
      if (isTransientAgentSocketError(err)) {
        recordTransientAgentSocketError('toggleMcpServer', err);
        return { success: false, error: 'Claude control stream closed — try again on the next message' };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async rewindFiles(userMessageId: string, dryRun?: boolean): Promise<{ canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }> {
    if (!activeQuery) {
      return { canRewind: false, error: 'No active session' };
    }
    try {
      return await activeQuery.rewindFiles(userMessageId, { dryRun });
    } catch (err) {
      if (isTransientAgentSocketError(err)) {
        recordTransientAgentSocketError('rewindFiles', err);
        return { canRewind: false, error: 'Claude control stream closed — try again on the next message' };
      }
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSessions(limit = 50): Promise<unknown[]> {
    ensureInit();
    try {
      const sessions = await listSessions({ dir: AGENT_CWD, limit });
      return sessions;
    } catch (err) {
      console.error('Failed to list sessions:', err);
      return [];
    }
  }

  async processMessage(threadId: string, content: string, threadMeta?: { name: string; type: 'daily' | 'named' }, opts?: {
    platform?: 'web' | 'discord' | 'telegram' | 'api';
    platformContext?: string;
    discordChannelId?: string;
    discordGuildId?: string;
    discordMessageId?: string;
    images?: NormalizedImage[];
    /** Slice 4A: dispatch turn id minted by the roster dispatcher (ws.ts). */
    turnId?: string;
  }): Promise<string> {
    // Determine priority based on platform
    const platform = opts?.platform || 'web';
    let priority: number;
    if (platform === 'web') {
      priority = PRIORITIES.web_interactive;
    } else if (platform === 'telegram') {
      // Telegram is owner-only — always high priority
      priority = PRIORITIES.discord_owner;
    } else if (platform === 'discord') {
      // Check if it's the owner by inspecting platformContext
      // Discord messages from the owner get higher priority
      const isOwner = opts?.platformContext?.includes('owner');
      priority = isOwner ? PRIORITIES.discord_owner : PRIORITIES.discord_other;
    } else {
      priority = PRIORITIES.web_interactive;
    }

    return queryQueue.enqueue(priority, async () => {
      presenceStatus = 'waking';
      registry.broadcast({ type: 'presence', status: 'waking' });
      return this._processQuery(threadId, content, false, threadMeta, opts);
    });
  }

  async processAutonomous(threadId: string, prompt: string): Promise<string> {
    return queryQueue.enqueue(PRIORITIES.autonomous, async () => {
      return this._processQuery(threadId, prompt, true);
    });
  }

  private async _processQuery(threadId: string, content: string, isAutonomous = false, threadMeta?: { name: string; type: 'daily' | 'named' }, platformOpts?: {
    platform?: 'web' | 'discord' | 'telegram' | 'api';
    platformContext?: string;
    discordChannelId?: string;
    discordGuildId?: string;
    discordMessageId?: string;
    images?: NormalizedImage[];
    turnId?: string;
  }, _retryWithoutResume = false): Promise<string> {
    ensureInit();
    const thread = getThread(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);

    // Memory-burst tripwire breadcrumb — which turn was running when RSS spiked.
    recordActivity('agent-turn', `thread=${threadId} platform=${platformOpts?.platform ?? (isAutonomous ? 'autonomous' : 'web')}`);

    const cfg = getBytelightConfig();

    // /clear runs as SDK passthrough (commands.ts SDK_COMMANDS) — the
    // SDK will start a fresh internal session, but it has no knowledge
    // of our sidecar. Wipe the thread's sidecar rows here so post-/clear
    // turns don't try to resume orphaned session ids.
    if (/^\s*\/clear(\s|$)/.test(content)) {
      const cleared = clearProviderSessionsForThread(threadId);
      if (cleared > 0) {
        console.log(`[Session] /clear wiped ${cleared} provider session row(s) for thread "${thread.name}"`);
      }
    }

    // Stream message placeholder
    const streamMsgId = crypto.randomUUID();

    // Response and tool tracking (declared early so hookContext can reference)
    let fullResponse = '';
    // PR #11 / chip #38: track compaction in-flight from the moment the
    // PreCompact hook fires (banner-show signal) through the
    // `compact_boundary` message (banner-hide signal). The flag lives at
    // this scope (rather than inside the stream-loop block lower down)
    // so the hookContext below can capture it via the onCompactionStart
    // callback. Bot review on PR #11 caught the race window: PreCompact
    // fires earlier than the SDK's `system: compacting` message, so
    // setting the flag only on the latter could miss aborts in between.
    let isCompactionInProgress = false;
    const toolInsertions: ToolInsertion[] = [];
    const thinkingBlocks: ThinkingInsertion[] = [];
    const requestStartMs = Date.now();
    let currentThinkingAccum = '';
    let agentTimedOut = false;
    let agentTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    // Slice 2 (composer freedom): when the operator explicitly stops mid-turn and no
    // partial response landed, we skip the '[No response]' corpse instead
    // of persisting a useless empty message. The safety timeout (agentTimedOut)
    // gets the same treatment: an internal wake that ends its turn without an
    // outbox line must NOT leave a '[No response]' corpse in the thread. Both
    // empty-abort paths skip persistence; a partial stream still persists.
    let stoppedByUser = false;
    // Heartbeat silent-completion sentinel (runtime.ts): a turn that ends
    // cleanly (finishReason 'stop') with no text is an intentional silent
    // finish — suppress the empty-message persistence, same as the stop paths.
    let endedSilently = false;
    // The shiver: ambient memory recall that surfaced on this turn (emitted
    // once by the heartbeat runtime's whisper). Folded into the reply message's
    // metadata so the owner can SEE recall happened. Null when nothing surfaced
    // or the runtime doesn't whisper.
    let surfacedRecall: {
      cards: Array<{ excerpt: string; date?: string; domain?: string; relevance?: number }>;
      dejavu: boolean;
    } | null = null;

    // Build hook context
    const platform = platformOpts?.platform || 'web';
    const hookContext: HookContext = {
      threadId,
      threadName: threadMeta?.name ?? thread.name,
      threadType: threadMeta?.type ?? thread.type,
      streamMsgId,
      isAutonomous,
      registry,
      sessionId: thread.current_session_id || null,
      platform,
      platformContext: platformOpts?.platformContext,
      toolInsertions,
      getTextLength: () => fullResponse.length,
      // PR #11 / chip #38: PreCompact hook calls this the moment it
      // broadcasts the in-progress banner. Closes the race window where
      // an abort could fire between the hook and the SDK's first
      // `system: compacting` message and miss the cleanup.
      onCompactionStart: () => { isCompactionInProgress = true; },
    };

    // First message of this session — include static orientation content (tools, skills, vault)
    const isFirstMessage = !thread.current_session_id;

    // Build query options — V1 API (full config support)
    // Two-tier model: autonomous wakes use cheaper model (configurable)
    // Interactive queries use primary model (configurable)
    //
    // Slice 5a (the steering wheel): model resolution goes through
    // resolveModelForTurn — companion_settings precedence
    // (thread > companion > system row > config fallback) — following the
    // tag's wiring at stable-pre-rollback-2026-06-20 agent.ts:651. The
    // resolver's systemFallback delegates to the same DB > YAML config
    // chain getConfiguredModel implements (see companion-resolver.ts), so
    // with zero applicable rows the resolved model is byte-identical to
    // the pre-5a getConfiguredModel output (parity-pinned by
    // agent.model-resolution-parity.test.ts).
    const { tierConfig, model, modelRef: resolvedModelRef } = resolveModelForTurn({
      isAutonomous,
      threadId,
    });
    // One descriptor per turn: resolved here, consumed by the sidecar READ
    // (bridge block below) and the sidecar WRITE (finally block). Never
    // re-derive at a call site. The stale-session retry path recurses into
    // _processQuery and re-resolves naturally — no stale capture.
    //
    // SLICE-5a ADAPTATION: built from the resolver's ModelRef instead of
    // calling resolveRuntimeDescriptor(model). resolveModelForTurn already
    // normalized `${tierConfig.provider}/${tierConfig.model}` into a canonical
    // ref; re-normalizing the bare model id here would drop the resolved
    // provider (a thread row naming openai-codex/gpt-5.5 must produce a
    // codex-lane descriptor, not a claude-lane one). Same shape as
    // resolveRuntimeDescriptor's return — the descriptor consumers below
    // are untouched. resolveRuntimeDescriptor stays exported as the
    // bare-id oracle (agent.runtime-descriptor.test.ts).
    const runtimeDescriptor: RuntimeDescriptor = {
      runtimeId: resolvedModelRef.runtime,
      provider: resolvedModelRef.provider,
      modelRef: resolvedModelRef,
    };
    // Effort resolves AFTER model selection so `auto` can pick the right
    // value per model class (high for Opus/Sonnet, medium for Haiku).
    // Tier-aware lookup (PR #10): autonomous reads `thinking_effort_autonomous`
    // when set, falls back to global `thinking_effort` otherwise. Lets users
    // run Chat on Opus + Max while Autonomous stays on Sonnet + a valid level.
    //
    // SLICE-5a ADAPTATION (effort): the tag fed `tierConfig.effort` verbatim
    // into its runtime, whose mapThinkingConfig treated 'auto' as "adaptive,
    // no effort override" (tag claude-sdk.ts:149). Main's live semantics
    // resolve 'auto' via getConfiguredThinkingEffort + resolveEffortForModel.
    // Hybrid: an explicit (non-'auto') effort on a companion_settings row —
    // what the picker writes — wins; the resolver's 'auto' sentinel falls
    // through to today's config chain, keeping wake-day effort behavior
    // byte-identical when no row sets an explicit effort.
    const configuredEffort = getConfiguredThinkingEffort(isAutonomous ? 'autonomous' : 'interactive');
    const effort = resolveEffortForModel(
      model,
      tierConfig.effort === 'auto' ? configuredEffort : tierConfig.effort,
    );
    console.log(
      `[Agent] Model: ${model} ` +
      `(provider=${tierConfig.provider}, ` +
      `tier=${isAutonomous ? 'autonomous' : 'interactive'}, ` +
      `source=${tierConfig.source}, effort: ${effort})`
    );

    // Merge DB-managed MCP servers into config so SDK sessions can see them too.
    // These are HTTP servers added via Settings UI — they get the same
    // filterMcpServers treatment (disable-list included) as .mcp.json servers.
    // Name collision: .mcp.json wins (the operator's hand-edit outranks the DB).
    // Empty mcp_servers table ⇒ allMcpServers === mcpServersFromConfig, byte-identical path.
    // Ported from the reference implementation's SDK-lane injection, Apache 2.0.
    const allMcpServers: Record<string, McpServerConfig> = { ...mcpServersFromConfig };
    for (const managed of getManagedServerConfigs()) {
      if (!allMcpServers[managed.name]) {
        const headers: Record<string, string> = {};
        if (managed.apiKey) headers['Authorization'] = 'Bearer ' + managed.apiKey;
        allMcpServers[managed.name] = {
          type: 'http',
          url: managed.url,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        } as McpServerConfig;
      }
    }

    const options: Options = {
      model,
      systemPrompt: claudeMdContent
        ? { type: 'preset', preset: 'claude_code', append: claudeMdContent }
        : { type: 'preset', preset: 'claude_code' },
      cwd: AGENT_CWD,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,

      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: effort as any,
      hooks: createHooks(hookContext),
      // Plugin: native skill discovery from .claude/skills/
      plugins: [{ type: 'local' as const, path: join(AGENT_CWD, '.claude').replace(/\\/g, '/') }],
      // Explicitly pass MCP servers — SDK isolation mode doesn't auto-discover .mcp.json
      // Dynamically filter Mind MCP when not needed (saves ~8-13k tokens on casual messages)
      // allMcpServers = .mcp.json + DB-managed servers (merged above, .mcp.json wins)
      ...(Object.keys(allMcpServers).length > 0 && {
        mcpServers: filterMcpServers(allMcpServers, {
          isAutonomous,
          isFirstMessage,
          userMessage: content,
        }),
      }),
    };

    // Per-(runtime, provider, model) session sidecar resume.
    //
    // Adapted from reference implementation/main 1c82243, hardened: NO fallback to
    // thread.current_session_id. That column has no model tag, so
    // reusing it across a model swap is the bug we're fixing. Sidecar
    // miss = fresh session.
    //
    // Pre-migration threads lose one resume continuity boundary on
    // their first post-port turn; they immediately write a sidecar
    // row after that turn and resume normally thereafter. Accepted
    // tradeoff — correctness beats reusing an untyped legacy pointer.
    // Self-clears on next turn — sidecar row gets written at line ~950
    // after the first post-switch turn completes, so future turns under
    // the same model take the 'resume' branch and skip the bridge.
    let bridgePrior: Message[] | null = null;
    let recycleCodexSession = false;
    {
      const providerSession = _retryWithoutResume
        ? null
        : getProviderSession({
            threadId: thread.id,
            runtimeId: runtimeDescriptor.runtimeId,
            // Slice 3b: DB filing key maps 'claude' → 'anthropic' (legacy
            // sidecar spelling; every live row is filed under it). Same
            // mapping at the write site below — parity by construction.
            provider: sidecarProviderFor(runtimeDescriptor.provider),
            modelRef: model,
          });
      // Recency signal (Slice 1.5): did a DIFFERENT (runtime, provider,
      // model) triple carry this thread more recently than the hit row?
      // If so, plain resume would wake this model amnesiac about that era.
      // ISO-8601 strings compare lexicographically, so > is chronological.
      const newestRow = providerSession ? getMostRecentProviderSession(thread.id) : null;
      const newerForeignSessionExists = Boolean(
        providerSession && newestRow &&
        newestRow.last_used_at > providerSession.last_used_at &&
        (newestRow.runtime_id !== providerSession.runtime_id ||
          newestRow.provider !== providerSession.provider ||
          newestRow.model_ref !== providerSession.model_ref),
      );
      const decision = decideBridge({
        retry: _retryWithoutResume,
        sidecarHitForCurrentModel: providerSession !== null,
        anyPriorSidecarRow: hasAnyProviderSessionForThread(thread.id),
        newerForeignSessionExists,
      });
      recycleCodexSession = Boolean(
        providerSession
        && runtimeDescriptor.runtimeId === 'codex-cli'
        && shouldRecycleCodexSession(providerSession.last_used_at),
      );
      if (decision === 'resume' && providerSession) {
        options.resume = providerSession.session_id;
      } else if (decision === 'resume+bridge' && providerSession) {
        // Returning to a previously-used model: resume its session AND
        // bridge only the era it missed — messages created after this
        // row's last_used_at. getMessages returns chronological (DESC
        // SQL + .reverse(), newest 15 kept), which is what
        // buildBridgeBlock expects.
        options.resume = providerSession.session_id;
        bridgePrior = getMessages({
          threadId: thread.id,
          limit: 15,
          since: providerSession.last_used_at,
        });
      } else if (decision === 'bridge') {
        bridgePrior = getMessages({ threadId: thread.id, limit: 15 });
      }
      // The replacement thread receives the canonical durable tail below;
      // do not also inject the model-swap bridge into the same live turn.
      if (recycleCodexSession) bridgePrior = null;
    }

    registry.broadcast({
      type: 'stream_start',
      messageId: streamMsgId,
      threadId,
      // Slice 4A turn envelope: local turns are always the resident pair's
      // brain; the dispatch turnId rides through when the dispatcher minted one.
      companionId: LOCAL_COMPANION_ID,
      ...(platformOpts?.turnId ? { turnId: platformOpts.turnId } : {}),
    });

    // Reconnect catch-up: register this in-flight turn so a socket that
    // (re)connects mid-turn gets the stream state replayed (ws.ts). The
    // closure reads the live locals — tool/thinking arrays mutate in place
    // and fullResponse reassigns, so every snapshot is current, including
    // after the compaction reset that truncates them. Unregistered in the
    // `finally` below.
    registerActiveStream(threadId, () => ({
      messageId: streamMsgId,
      threadId,
      fullResponse,
      toolInsertions,
      thinkingBlocks,
    }));

    let sessionId: string | null = null;

    try {
      presenceStatus = 'active';
      registry.broadcast({ type: 'presence', status: 'active' });

      // Write thread ID for CLI tool integration (only if cwd dir exists)
      try {
        const threadFilePath = join(cfg.agent.cwd, '.bytelight-thread');
        if (existsSync(cfg.agent.cwd)) {
          writeFileSync(threadFilePath, threadId);
        }
      } catch {}

      // Build orientation context (thread, time, gap, status, vault)
      // Prepended to prompt because SessionStart hooks don't fire in V1 query()
      // Static content (CHAT TOOLS, skills, vault path) only on first message of session
      const orientation = await buildOrientationContext(hookContext, isFirstMessage, content, resolvedModelRef.canonical);
      const bridgeBlock = bridgePrior ? buildBridgeBlock(bridgePrior) : '';
      if (bridgePrior && bridgePrior.length > 0) {
        console.log(`[Agent] Bridge injected: ${bridgePrior.length} prior turns (model swap to ${model})`);
      }
      let enrichedPrompt = `${bridgeBlock}[Context]\n${orientation}\n[/Context]\n\n${content}`;

      // Extract sticker images from user message so companions can SEE them
      const stickerImages = stickerRefsToImageBlocks(content);
      const attachmentImages = normalizedImagesToImageBlocks(platformOpts?.images ?? []);
      // Our own freshly-generated images, queued by the image-gen route — shown
      // to us once so we actually SEE what we made and can react to it.
      const generatedImages: ImageBlock[] = [];
      for (const fid of drainQueuedImages(threadId)) {
        const f = getFile(fid);
        if (f && isEmbeddableImage(f.path)) {
          const b = fileToImageBlock(f.path);
          if (b) generatedImages.push(b);
        }
      }
      if (generatedImages.length > 0) {
        enrichedPrompt += `\n\n(Shown below: the image${generatedImages.length > 1 ? 's' : ''} you just generated and sent — this is what came out, so you can see it and react to what's actually there.)`;
      }
      const { kept: imageBlocks, dropped: imagesDropped } = capImageBlocks([
        ...attachmentImages,
        ...stickerImages,
        ...generatedImages,
      ]);
      if (imagesDropped > 0) {
        console.log(`[Agent] Dropped ${imagesDropped} prompt images (cap reached)`);
      }

      // Build prompt — multimodal if stickers present, text-only otherwise
      // SDK expects AsyncIterable<SDKUserMessage> for multimodal content
      const promptInput: string | AsyncIterable<SDKUserMessage> = imageBlocks.length > 0
        ? (async function* () {
            yield {
              type: 'user' as const,
              message: {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: enrichedPrompt }, ...imageBlocks],
              },
              parent_tool_use_id: null,
            };
          })()
        : enrichedPrompt;

      // Abort controller for stop_generation support
      activeAbortController = new AbortController();
      options.abortController = activeAbortController;
      resetSafetyTimer();

      // Safety timeout — abort if agent hangs for more than 20 minutes
      const AGENT_TIMEOUT_MS = 20 * 60 * 1000;
      agentTimeoutHandle = setTimeout(() => {
        console.warn('[Agent] Timeout: aborting hung session after 20 minutes');
        agentTimedOut = true;
        activeAbortController?.abort();
      }, AGENT_TIMEOUT_MS);

      // File checkpointing for rewind support
      options.enableFileCheckpointing = true;

      // ── Slice 3b dual-path dispatch ────────────────────────────────
      // Foreign lane: non-claude-sdk refs dispatch through the runtime
      // doors (runtimes/index.ts) and consume the canonical
      // AgentRuntimeEvent stream, mapping events to the same side
      // effects the Claude loop below performs (WS broadcasts, usage
      // recording, session capture; message persistence + stream_end
      // happen in the shared tail after the finally block). LIVE since
      // Slice 5a: the June thread-override picker produces non-Claude
      // refs (gpt-5.4 turns are billed + attributed against her key),
      // so this lane runs in production — it is no longer dormant.
      // (The runtime-descriptor default still routes bare Claude ids to
      // claude-sdk, pinned by agent.runtime-descriptor.test.ts.) The
      // Claude lane in the else branch is byte-untouched — brace-wrapped,
      // not reindented.
      // Consumer shape mirrors the June canonical consumer (tag
      // stable-pre-rollback-2026-06-20 agent.ts) using the ported
      // helpers buildAgentTurnInput / computeContextUsageUpdate /
      // buildUsageEventRow.
      if (runtimeDescriptor.modelRef.runtime !== 'claude-sdk') {
        const dispatchPacket = resolveRuntimeForRef(runtimeDescriptor.modelRef);
        // History for runtimes without native resume — June consumer
        // shape: last 50 rows, role-mapped to NormalizedMessage.
        let recent: NormalizedMessage[] = getMessages({ threadId, limit: 50 }).map((m) => ({
          role: m.role === 'companion'
            ? ('assistant' as const)
            : m.role === 'system'
              ? ('system' as const)
              : ('user' as const),
          content: m.content,
          createdAt: m.created_at,
        }));
        // Autonomous wake prompts are never persisted as messages; without
        // this the CLI runtimes (extractLatestUserPrompt) re-deliver the
        // last stored user message instead of the wake prompt.
        if (isAutonomous) {
          recent.push({ role: 'user' as const, content, createdAt: new Date().toISOString() });
        }
        let effectiveContent = content;
        if (
          runtimeDescriptor.runtimeId === 'codex' ||
          runtimeDescriptor.runtimeId === 'codex-cli'
        ) {
          const skillPrompt = rewriteCodexSkillInvocation(
            content,
            runtimeDescriptor.runtimeId,
            new Set(scanSkills().map((skill) => skill.dirName)),
          );
          if (skillPrompt !== content) {
            effectiveContent = skillPrompt;
            // Normal sends persist the user row first; palette dispatch calls
            // the agent directly. Append only when no current row exists.
            const latestMessage = recent[recent.length - 1];
            if (latestMessage?.role === 'user' && latestMessage.content === content) {
              recent[recent.length - 1] = {
                ...latestMessage,
                content: skillPrompt,
              };
            } else {
              recent.push({
                role: 'user' as const,
                content: skillPrompt,
                createdAt: new Date().toISOString(),
              });
            }
          }
        }
        // Do this after any current-turn prompt rewrite so the images cannot
        // land on an older history row or be separated from the current user.
        recent = attachImagesToLatestUserMessage(recent, platformOpts?.images ?? [], effectiveContent);
        // H1 "hands": resolve the MCP tool surface for this foreign turn.
        // Lazy + foreign-path only — zero new work on the Claude lane
        // (it runs MCP servers natively). Map ToolSchema[] (mcp-bridge's
        // shape: input_schema) → ToolDefinition[] (runtime shape:
        // inputSchema). Bridge failure must not kill the turn: on throw
        // OR empty, proceed tool-less exactly as before H1.
        let turnTools: ToolDefinition[] | undefined;
        if (runtimeNeedsRouterToolPayload(runtimeDescriptor.runtimeId)) {
          try {
            const routerTools = await getRouterTools();
            if (routerTools.length > 0) {
              turnTools = routerTools.map((t: ToolSchema) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.input_schema,
              }));
            }
          } catch (toolErr) {
            console.warn('[Agent] getRouterTools failed; proceeding tool-less:', (toolErr as Error).message);
          }
        }
        // The whisper crosses lanes (H4 leg 1): ambient recall + the
        // Archivist's unfiled noticings ride foreign turns the same way they
        // ride the heartbeat lane. whisper.ts already bounds, dedups (keyed
        // per runtime+thread), and timeboxes everything; a slow or
        // unreachable Cortex costs the turn its recall and nothing else.
        // Deviation from the heartbeat port, documented: no fitRecallToCap
        // pass — foreign lanes have no 150k delivery cap; the whisper's own
        // internal budget is the bound.
        let foreignRecallBlock = '';
        try {
          const laneKey = `${runtimeDescriptor.runtimeId}:${thread.id}`;
          let unfiledBlock = '';
          try { unfiledBlock = unfiledNoticings(); } catch { /* never delay a turn */ }
          const recall = await ambientRecall(effectiveContent || content, laneKey, false);
          foreignRecallBlock = recall.block + unfiledBlock;
          // The shiver: only claim recall on the reply when the block
          // actually rode the turn.
          if (recall.surfaced && recall.block.length > 0) {
            surfacedRecall = recall.surfaced;
          }
        } catch { /* never delay a turn */ }
        const turnInput = buildAgentTurnInput({
          thread: { id: thread.id, name: thread.name, type: thread.type, current_session_id: thread.current_session_id },
          tier: isAutonomous ? 'autonomous' : 'interactive',
          modelRef: runtimeDescriptor.modelRef,
          platform,
          isAutonomous,
          orientation: foreignRecallBlock ? orientation + '\n' + foreignRecallBlock : orientation,
          systemPromptText: claudeMdContent,
          messages: recent,
          cwd: AGENT_CWD,
          abortSignal: activeAbortController?.signal,
          thinkingEffort: effort,
          tools: turnTools,
        });
        // Sidecar resume: options.resume was set by the bridge block
        // above from THIS descriptor's sidecar row — same key.
        if (options.resume) turnInput.sessionId = options.resume;
        if (recycleCodexSession) {
          turnInput.sessionRecycle = { reason: 'idle', historyLimit: 30 };
        }

        // H1 "hands": tool_result carries `output` as `unknown` on the
        // canonical stream (runtimes/types.ts:249), whereas the Claude
        // hook path already hands us strings. Coerce to a string for the
        // tool-card output field (frontend ToolEvent.output is `string`),
        // guarding JSON.stringify against throws (circular refs, BigInt)
        // by falling back to String(). (tool_start input goes through
        // hooks' summarizeInput instead — Claude-lane bounding parity.)
        const stringifyToolField = (v: unknown): string => {
          if (typeof v === 'string') return v;
          if (v === undefined || v === null) return '';
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        };

        // H2 "hands": enter the turn-scoped chat-tool-belt context around the
        // runtime's runTurn consumption. The belt's executeRouterTool path
        // reads threadId back from this store (AsyncLocalStorage), so a belt
        // tool (voice note / image / history search) lands in THIS thread even when
        // other threads run turns concurrently — without touching any file
        // under runtimes/ (the executeTool callback is bound there at
        // construction with no per-turn context). See chat-tool-belt.ts.
        await runWithBeltContext({
          threadId,
          discordChannelId: platformOpts?.discordChannelId,
          discordGuildId: platformOpts?.discordGuildId,
          discordMessageId: platformOpts?.discordMessageId,
        }, async () => {
        for await (const event of dispatchPacket.runtime.runTurn(turnInput)) {
          resetSafetyTimer();
          switch (event.type) {
            case 'session':
              if (event.sessionId !== sessionId) {
                sessionId = event.sessionId;
                hookContext.sessionId = sessionId;
              }
              break;
            case 'text_delta':
              // Append-exactly contract (runtimes/types.ts) — producer
              // owns spacing; broadcast carries the cumulative buffer
              // like the Claude loop's stream_token.
              fullResponse += event.text;
              registry.broadcast({ type: 'stream_token', messageId: streamMsgId, token: fullResponse });
              break;
            case 'text_snapshot':
              fullResponse = event.text;
              registry.broadcast({ type: 'stream_token', messageId: streamMsgId, token: fullResponse });
              break;
            case 'thinking_delta':
              // Slice 3 (thought semantics): the adapter's `kind` rides the
              // insertion into buildSegments AND the WS broadcast unchanged.
              // Conditional spread keeps the wire/persisted shape identical
              // to pre-Slice-3 when an adapter emits no kind.
              thinkingBlocks.push({
                textOffset: fullResponse.length,
                content: event.text,
                summary: event.summary ?? '',
                ...(event.kind ? { kind: event.kind } : {}),
              });
              registry.broadcast({
                type: 'thinking',
                content: event.text,
                summary: event.summary ?? '',
                ...(event.kind ? { kind: event.kind } : {}),
              });
              break;
            case 'memory_surface':
              // The shiver. Capture what surfaced so it can ride the reply
              // message's metadata (folded in at persistence, below).
              surfacedRecall = { cards: event.cards, dejavu: event.dejavu };
              break;
            case 'context_usage': {
              const update = computeContextUsageUpdate(event);
              contextTokensUsed = update.tokensUsed;
              contextWindowSize = update.contextWindow;
              if (update.logMessage) console.log(update.logMessage);
              if (update.broadcastPayload) registry.broadcast(update.broadcastPayload);
              break;
            }
            case 'usage':
              try {
                recordUsageEvent(buildUsageEventRow({
                  event,
                  toolInsertions,
                  model,
                  modelRef: runtimeDescriptor.modelRef,
                  streamMsgId,
                  threadId,
                  platform,
                  isAutonomous,
                  requestStartMs,
                  contextTokensUsed,
                  contextWindowSize,
                  randomId: () => crypto.randomUUID(),
                  nowIso: () => new Date().toISOString(),
                  nowMs: () => Date.now(),
                  estimateCost,
                }));
              } catch (usageErr) {
                console.warn('[Usage] Failed to record usage event:', (usageErr as Error).message);
              }
              break;
            case 'rate_limit':
              registry.broadcast({
                type: 'rate_limit',
                status: event.status ?? 'unknown',
                resetsAt: event.resetsAt as unknown as number | undefined,
                rateLimitType: event.rateLimitType,
                utilization: event.utilization,
              });
              console.log(`[Agent] Rate limit: ${event.status}, type: ${event.rateLimitType}, resets: ${event.resetsAt}`);
              break;
            case 'tool_start': {
              // H1 "hands": surface a foreign-lane tool call the SAME way
              // the Claude lane does — push into the shared toolInsertions
              // array (so the tail's buildSegments persists a tool card
              // into the message) and broadcast the identical `tool_use`
              // WS shape (mirrors hooks.ts:420-435 buildPreToolUse). No new
              // WS type, no frontend change. textOffset = current text
              // length for interleaved rendering, matching the Claude
              // lane's ctx.getTextLength() (agent.ts:845). Input is bounded
              // by the SAME summarizeInput the Claude lane runs at
              // hooks.ts:415 (event.input is the parsed argument object,
              // matching its `unknown` parameter) — ~80-120 chars / one
              // meaningful field, never the raw argument blob.
              const textOffset = fullResponse.length;
              const inputStr = summarizeInput(event.name, event.input);
              toolInsertions.push({
                textOffset,
                toolId: event.id,
                toolName: event.name,
                input: inputStr || undefined,
              });
              registry.broadcast({
                type: 'tool_use',
                toolId: event.id,
                toolName: event.name,
                input: inputStr,
                isComplete: false,
                textOffset,
              });
              break;
            }
            case 'tool_result': {
              // H1 "hands": complete the tool card — update the matching
              // insertion's output/isError and broadcast the identical
              // `tool_result` WS shape (mirrors hooks.ts:498-510 /
              // 555-567). Output is stringified (event.output is unknown
              // on the canonical stream vs the Claude hook's already-string
              // output); truncation bounds match the Claude lane (500 for
              // the persisted insertion, 2000 for the broadcast).
              const outputStr = stringifyToolField(event.output);
              const insertion = toolInsertions.find(t => t.toolId === event.id);
              if (insertion) {
                insertion.output = outputStr.substring(0, 500);
                insertion.isError = event.isError ?? false;
              }
              registry.broadcast({
                type: 'tool_result',
                toolId: event.id,
                output: outputStr.substring(0, 2000),
                isError: event.isError ?? false,
              });
              break;
            }
            case 'tool_progress':
              registry.broadcast({ type: 'tool_progress', toolId: event.toolId, toolName: event.toolName, elapsed: event.elapsedSeconds });
              break;
            case 'auth_required':
              // Clean not-configured degrade — the runtime emits this
              // instead of throwing (e.g. Codex OAuth absent).
              console.warn(`[Agent] Runtime auth required (${event.provider}): ${event.message}`);
              fullResponse = fullResponse || `[${event.message}]`;
              break;
            case 'provider_diagnostic':
              console.log(`[Runtime:${runtimeDescriptor.runtimeId}] ${event.code}: ${event.message}`);
              break;
            case 'error':
              // Recoverable: log-and-continue (matches the Claude loop's
              // non-success result subtype handling). Unrecoverable: capture
              // and surface it — do NOT throw. The "Codex never comes back"
              // bug was this handler throwing an unrecoverable runtime error
              // mid-stream, stranding the turn (the throw unwound past the
              // normal finalize path). Every runtime error-emit site yields a
              // terminal `done` (or the generator returns) right after, so a
              // `break` lets the loop finish and the shared tail persist the
              // surfaced message + clean up the session exactly like the
              // auth_required degrade just above. The 5-min safety timer
              // (resetSafetyTimer) remains the backstop if a runtime ever
              // hangs instead of terminating.
              console.error(`[Agent] Runtime error (recoverable=${event.recoverable}): ${event.message}`);
              if (!event.recoverable) {
                // Mirror the auth_required degrade shape so finalization
                // persists this as the companion/system message the same way.
                fullResponse = fullResponse || `⚠ ${event.message}`;
              }
              break;
            case 'done':
              if (event.finishReason === 'aborted') {
                if (agentTimedOut) {
                  console.warn('[Agent] Session terminated by safety timeout');
                  registry.broadcast({ type: 'error', code: 'agent_timeout', message: 'Agent session timed out and was reset. Please try again.' });
                } else {
                  console.log('[Agent] Generation stopped by user');
                  registry.broadcast({ type: 'generation_stopped' });
                }
              } else if (event.finishReason === 'stop' && !fullResponse.trim()) {
                // Clean stop with no text = heartbeat silent-completion
                // sentinel. Mark it so finalization skips the '[No response]'
                // corpse instead of persisting an empty message.
                endedSilently = true;
              }
              break;
            default:
              // 'start', 'compaction_notice', 'suppressed' — no side
              // effects here (compaction is Claude-SDK-only; start is a
              // lifecycle marker). tool_start/tool_result are handled
              // above as of H1 (they surface tool cards to the UI).
              break;
          }
        }
        }); // runWithBeltContext (H2)
      } else {

      // V1 query — single params object with prompt and options
      const result = query({ prompt: promptInput, options });
      activeQuery = result;

      // Enforce MCP server preferences on query start
      const disabledServers = getDisabledMcpServers();
      result.mcpServerStatus().then(async (statuses) => {
        for (const s of statuses) {
          if (disabledServers.has(s.name) && s.status !== 'disabled') {
            // Disable servers that should be off
            try {
              await result.toggleMcpServer(s.name, false);
              console.log(`[MCP] Disabled "${s.name}" on query start (persistent preference)`);
            } catch { /* best-effort */ }
          } else if (!disabledServers.has(s.name) && s.status === 'disabled') {
            // Re-enable servers that should be on (were disabled in a previous message)
            try {
              await result.toggleMcpServer(s.name, true);
              await result.reconnectMcpServer(s.name);
              console.log(`[MCP] Re-enabled "${s.name}" on query start (persistent preference)`);
            } catch { /* best-effort */ }
          }
        }
      }).catch(() => {});

      // Refresh MCP server status (non-blocking — caches for settings panel)
      void refreshMcpStatusSafely(result, 'query-start');

      // Simplified stream loop — hooks handle tool activity, audit, images
      // Inner try/catch for AbortError (stop_generation)
      try {
      for await (const msg of result) {
        // Capture session ID from any message
        if (msg && typeof msg === 'object' && 'session_id' in msg) {
          const newSessionId = msg.session_id as string;
          if (newSessionId && newSessionId !== sessionId) {
            sessionId = newSessionId;
            // Update hook context so hooks log the correct session
            hookContext.sessionId = sessionId;
          }
        }

        if (!msg || typeof msg !== 'object' || !('type' in msg)) continue;
        resetSafetyTimer(); // Any stream activity resets the hung-query watchdog

        const msgType = (msg as any).type;

        // Capture thinking from raw stream events (SDK strips them from assistant messages)
        if (msgType === 'stream_event') {
          const streamEvent = (msg as any).event;
          if (streamEvent?.type === 'content_block_start' && streamEvent?.content_block?.type === 'thinking') {
            currentThinkingAccum = '';
          } else if (streamEvent?.type === 'content_block_delta' && streamEvent?.delta?.type === 'thinking_delta') {
            const thinkingText = streamEvent.delta.thinking || '';
            if (thinkingText) {
              currentThinkingAccum += thinkingText;
            }
          } else if (streamEvent?.type === 'content_block_stop' && currentThinkingAccum) {
            const summary = extractThinkingSummary(currentThinkingAccum);
            // Slice 3 (thought semantics): same classification the runtime
            // adapter applies (claude-sdk.ts) — extended thinking is native
            // model telemetry → kind 'provider'.
            thinkingBlocks.push({
              textOffset: fullResponse.length,
              content: currentThinkingAccum,
              summary,
              kind: 'provider',
            });
            registry.broadcast({ type: 'thinking', content: currentThinkingAccum, summary, kind: 'provider' });
            currentThinkingAccum = '';
          }
        }

        if (msgType === 'assistant') {
          const assistantMsg = msg as any;
          if (assistantMsg.message?.content) {
            for (const block of assistantMsg.message.content) {
              if (block.type === 'text' && block.text) {
                if (fullResponse) fullResponse += '\n\n' + block.text;
                else fullResponse = block.text;

                registry.broadcast({
                  type: 'stream_token',
                  messageId: streamMsgId,
                  token: fullResponse,
                });
              }
              // Thinking blocks are captured from stream_event, not here (avoids duplicates)
            }
          }
        } else if (msgType === 'result') {
          const resultMsg = msg as any;

          // Extract context window usage from result
          if (resultMsg.usage || resultMsg.model_usage) {
            const usage = resultMsg.usage || {};
            const modelUsage = resultMsg.model_usage;

            // Get context window size from model usage if available
            if (modelUsage) {
              for (const model of Object.values(modelUsage) as any[]) {
                if (model?.context_window) {
                  contextWindowSize = model.context_window;
                }
                if (model?.input_tokens) {
                  contextTokensUsed = model.input_tokens + (model.output_tokens || 0);
                }
              }
            } else if (usage.input_tokens) {
              contextTokensUsed = usage.input_tokens + (usage.output_tokens || 0);
            }

            if (contextWindowSize > 0 && contextTokensUsed > 0) {
              const percentage = Math.round((contextTokensUsed / contextWindowSize) * 100);
              console.log(`Context usage: ${contextTokensUsed} / ${contextWindowSize} (${percentage}%)`);
              registry.broadcast({
                type: 'context_usage',
                percentage,
                tokensUsed: contextTokensUsed,
                contextWindow: contextWindowSize,
              });
            }

            // Record usage event for cost tracking
            try {
              const inputTokens = usage.input_tokens || 0;
              const outputTokens = usage.output_tokens || 0;
              const cacheReadTokens = usage.cache_read_input_tokens || 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

              // Build tool usage list from toolInsertions
              const toolCallList: Array<{ name: string; count: number }> = [];
              for (const ti of toolInsertions) {
                const existing = toolCallList.find(t => t.name === ti.toolName);
                if (existing) existing.count++;
                else toolCallList.push({ name: ti.toolName, count: 1 });
              }

              const costUsd = estimateCost({
                model,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
              });

              recordUsageEvent({
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                threadId,
                messageId: streamMsgId,
                platform,
                mode: isAutonomous ? 'autonomous' : 'interactive',
                wakeType: null,
                model,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheCreationTokens,
                toolCalls: toolCallList.length > 0 ? toolCallList : undefined,
                costUsd,
                contextWindow: contextWindowSize || null,
                contextTokens: contextTokensUsed || null,
                durationMs: Date.now() - requestStartMs,
                // Slice 3b: provider attribution from the turn's
                // descriptor (columns via migration 012; nullable-safe).
                provider: runtimeDescriptor.modelRef.provider,
                runtime: runtimeDescriptor.modelRef.runtime,
                modelRef: runtimeDescriptor.modelRef.canonical,
              });
            } catch (usageErr) {
              console.warn('[Usage] Failed to record usage event:', (usageErr as Error).message);
            }
          }

          if (resultMsg.subtype !== 'success') {
            console.error('Agent error:', resultMsg.subtype, resultMsg.errors);
          }
        } else if (msgType === 'system') {
          const systemMsg = msg as any;
          // Detect compaction boundary
          if (systemMsg.subtype === 'compact_boundary' && systemMsg.compact_metadata) {
            const preTokens = systemMsg.compact_metadata.pre_tokens || contextTokensUsed;
            console.log(`[Compaction] Context compacted. Pre-tokens: ${preTokens}`);
            isCompactionInProgress = false;  // PR #11: clear flag — boundary completed normally
            registry.broadcast({
              type: 'compaction_notice',
              preTokens,
              message: `Context compacted (was ${Math.round(preTokens / 1000)}K tokens)`,
              isComplete: true,
            });
            // Reset tracking — new context window after compaction
            contextTokensUsed = 0;
            // Reset response buffer — pre-compaction text was incomplete and post-compaction
            // re-grounding monologue must not leak into Discord/phone replies
            if (fullResponse) {
              console.log(`[Compaction] Resetting fullResponse (was ${fullResponse.length} chars, platform: ${platform})`);
              fullResponse = '';
            }
            toolInsertions.length = 0;
            thinkingBlocks.length = 0;
          } else if (systemMsg.status === 'compacting') {
            console.log('[Compaction] Compacting in progress...');
            isCompactionInProgress = true;  // PR #11: set flag — abort path needs to know
          }
        } else if (msgType === 'rate_limit_event') {
          const rle = msg as any;
          const info = rle.rate_limit_info;
          if (info && (info.status === 'rejected' || info.status === 'allowed_warning')) {
            registry.broadcast({
              type: 'rate_limit',
              status: info.status,
              resetsAt: info.resetsAt,
              rateLimitType: info.rateLimitType,
              utilization: info.utilization,
            });
            console.log(`[Agent] Rate limit: ${info.status}, type: ${info.rateLimitType}, resets: ${info.resetsAt}`);
          }
        } else if (msgType === 'tool_progress') {
          const tp = msg as any;
          registry.broadcast({
            type: 'tool_progress',
            toolId: tp.tool_use_id,
            toolName: tp.tool_name,
            elapsed: tp.elapsed_time_seconds,
          });
        }
      }
      } catch (abortErr) {
        if (abortErr instanceof AbortError || (abortErr instanceof Error && abortErr.name === 'AbortError')) {
          // PR #11 / chip #38: if compaction was in flight when the abort fired,
          // broadcast a synthetic completion notice so the frontend banner exits
          // via the existing auto-hide path. Without this, an abort during
          // compaction never sees the SDK's compact_boundary message and the
          // banner stays pinned until page reload. Applies to both timeout and
          // user-cancel paths.
          if (isCompactionInProgress) {
            console.log('[Compaction] Abort during compaction — clearing banner');
            registry.broadcast({
              type: 'compaction_notice',
              preTokens: contextTokensUsed,
              message: 'Context compaction interrupted',
              isComplete: true,
            });
            isCompactionInProgress = false;
          }
          if (agentTimedOut) {
            console.warn('[Agent] Session terminated by safety timeout');
            registry.broadcast({ type: 'error', code: 'agent_timeout', message: 'Agent session timed out and was reset. Please try again.' });
          } else {
            console.log('[Agent] Generation stopped by user');
            stoppedByUser = true;
            registry.broadcast({ type: 'generation_stopped' });
          }
        } else if (isTransientAgentSocketError(abortErr)) {
          recordTransientAgentSocketError('stream', abortErr);
          fullResponse = fullResponse || '[Connection to Claude closed unexpectedly. Please try again.]';
        } else {
          throw abortErr; // Re-throw non-abort errors to outer catch
        }
      }
      } // end claude-sdk lane (Slice 3b dual-path — see branch open above)
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Agent query error:', errMsg, error);

      // Stale session recovery: if Claude Code can't find the session, clear it and retry fresh
      if (errMsg.includes('No conversation found with session ID') && thread.current_session_id && !_retryWithoutResume) {
        console.warn('[Agent] Stale session detected — clearing and retrying fresh');
        updateThreadSession(threadId, null);
        // Clean up before retry
        if (agentTimeoutHandle) clearTimeout(agentTimeoutHandle);
        clearSafetyTimer();
        activeAbortController = null;
        activeQuery = null;
        presenceStatus = 'dormant';
        // Retry without resume
        return this._processQuery(threadId, content, isAutonomous, threadMeta, platformOpts, true);
      }

      fullResponse = fullResponse || `[Agent error: ${errMsg}]`;
    } finally {
      // Reconnect catch-up: turn is over (or retrying) — stop replaying it.
      // Runs before the stream_end broadcast below; a socket connecting in
      // that gap misses the replay but gets the final message via normal
      // thread load. The stale-session retry path re-registers on re-entry.
      unregisterActiveStream(threadId);
      if (agentTimeoutHandle) clearTimeout(agentTimeoutHandle);
      // Clean up active query tracking
      clearSafetyTimer();
      activeAbortController = null;
      activeQuery = null;
      // Track session transition and update for future resume
      if (sessionId) {
        const previousSessionId = thread.current_session_id;
        const now = new Date().toISOString();

        // End the previous session record (if tracked)
        if (previousSessionId && previousSessionId !== sessionId) {
          try {
            endSessionRecord({ sessionId: previousSessionId, endedAt: now, endReason: 'resumed' });
          } catch { /* Previous session may not have a record yet */ }
        }

        // Create a record for the new session
        if (sessionId !== previousSessionId) {
          try {
            createSessionRecord({
              id: crypto.randomUUID(),
              threadId,
              sessionId,
              sessionType: (thread.session_type as 'v1' | 'v2') || 'v2',
              startedAt: now,
            });
          } catch (err) {
            if (!(err instanceof Error && err.message.includes('UNIQUE'))) {
              console.warn('Failed to create session record:', err);
            }
          }
        }

        updateThreadSession(threadId, sessionId);
        // Per-provider sidecar write. The sidecar is authoritative for
        // future resume lookups; threads.current_session_id is kept as
        // a denormalized signal (UI/orchestrator "has activity" checks,
        // session_history bookkeeping, stale-session retry guard) but
        // NOT consulted for resume.
        setProviderSession({
          threadId,
          runtimeId: runtimeDescriptor.runtimeId,
          // Slice 3b: same 'claude' → 'anthropic' filing map as the read
          // site — see sidecarProviderFor (agent/sidecar.ts).
          provider: sidecarProviderFor(runtimeDescriptor.provider),
          modelRef: model,
          sessionId,
        });
      }
      presenceStatus = 'dormant';
      registry.broadcast({ type: 'presence', status: 'dormant' });
    }

    // Build segments for interleaved tool/thinking display
    const segments = buildSegments(fullResponse, toolInsertions, thinkingBlocks);
    const metadataParts: Record<string, unknown> = {};
    if (segments.length > 0) metadataParts.segments = segments;
    // The shiver rides in message metadata (a JSON column that already flows
    // backend→ws→store→MessageBubble), so no new ws event or shared type is
    // needed — the existing `{type:'message'}` / `stream_end.final` path
    // carries it. See MessageBubble's surfaced-memory shimmer.
    if (surfacedRecall) metadataParts.surfacedMemory = surfacedRecall;
    const messageMetadata: Record<string, unknown> | undefined =
      Object.keys(metadataParts).length > 0 ? metadataParts : undefined;

    // Slice 2 (composer freedom): if the operator explicitly stopped the turn and
    // nothing landed, skip the '[No response]' corpse. We still broadcast
    // stream_end (without `final`) so the frontend cleans up streaming
    // state; the frontend already guards `if (msg.final)`.
    //
    // Same for a safety-timeout abort with an empty stream: an internal wake
    // that never wrote an outbox line hit the 5-min timer (agentTimedOut) —
    // don't persist a '[No response]' corpse. The `agent_timeout` error was
    // already broadcast on the abort path, so the UI still learns the turn
    // died. A partial stream (fullResponse has text) still persists below.
    // A clean Codex stop can legitimately contain no final prose after doing
    // useful autonomous work. Keep that tool/thinking trail as a durable
    // message instead of throwing it away with the transient stream state.
    // Truly empty silent turns remain invisible, as do empty user-stop and
    // safety-timeout corpses.
    const hasDurableArtifacts =
      toolInsertions.length > 0 || thinkingBlocks.length > 0 || surfacedRecall !== null;
    const isEmptyStreamEnd = shouldDiscardEmptyTurn({
      fullResponse,
      stoppedByUser,
      agentTimedOut,
      endedSilently,
      hasDurableArtifacts,
    });

    if (isEmptyStreamEnd) {
      registry.broadcast({
        type: 'stream_end',
        messageId: streamMsgId,
        companionId: LOCAL_COMPANION_ID,
        ...(platformOpts?.turnId ? { turnId: platformOpts.turnId } : {}),
      });
    } else {
      // Store final message
      const companionMessage = createMessage({
        id: streamMsgId,
        threadId,
        role: 'companion',
        // Tool-only / thinking-only autonomous turns deliberately persist an
        // empty text body; their visible content lives in metadata.segments.
        content: fullResponse || (hasDurableArtifacts ? '' : '[No response]'),
        contentType: 'text',
        platform,
        metadata: messageMetadata,
        createdAt: new Date().toISOString(),
        companionId: LOCAL_COMPANION_ID,
      });

      // End stream
      registry.broadcast({
        type: 'stream_end',
        messageId: streamMsgId,
        final: companionMessage,
        companionId: LOCAL_COMPANION_ID,
        ...(platformOpts?.turnId ? { turnId: platformOpts.turnId } : {}),
      });
    }

    // Push notification for offline user
    if (this.pushService && fullResponse) {
      const preview = fullResponse.substring(0, 120).replace(/\n/g, ' ');
      this.pushService.sendIfOffline({
        title: isAutonomous ? `${cfg.identity.companion_name} (autonomous)` : cfg.identity.companion_name,
        body: preview,
        threadId,
        tag: `msg-${streamMsgId}`,
        url: '/chat',
      }).catch(err => console.error('Push error:', err));
    }

    return fullResponse;
  }
}
