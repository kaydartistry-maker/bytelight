import 'dotenv/config';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { initDb, deleteExpiredSessions } from './services/db.js';
import { seedDefaultBlocks, ensureCompanionBlocks } from './services/memory-blocks.js';
import { getSecret } from './services/secrets.js';
import { loadVectorCache } from './services/vector-cache.js';
import { createWebSocketServer, setVoiceService, setGatewayServices, registry } from './services/ws.js';
import { startMemoryProfiler } from './services/memory-profiler.js';
import { startMemoryMonitor } from './services/memory-monitor.js';
import { Orchestrator } from './services/orchestrator.js';
import { AgentService } from './services/agent.js';
import { VoiceService } from './services/voice.js';
import { PushService } from './services/push.js';
import { DiscordService } from './services/discord/index.js';
import { TelegramService } from './services/telegram/index.js';
import { rateLimiter, securityHeaders } from './middleware/security.js';
import { recordActivity } from './services/activity-ring.js';
import { shutdownAllHeartbeats } from './services/heartbeat/supervisor.js';
import { setHeartbeatPushService } from './services/heartbeat/runtime.js';
import { codexSupervisor } from './services/runtimes/codex-supervisor.js';
import { shutdownEmbeddings } from './services/embeddings.js';
import apiRoutes from './routes/api.js';
import mcpBeltRouter, { closeBeltMcpSessions } from './routes/mcp-belt.js';

// Load config FIRST — before any other initialization
const config = loadConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.server.port;
const HOST = config.server.host;
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Ensure files directory exists
const filesDir = join(dataDir, 'files');
if (!existsSync(filesDir)) {
  mkdirSync(filesDir, { recursive: true });
}

// Initialize database
console.log('Initializing database...');
const db = initDb(DB_PATH);
deleteExpiredSessions();
loadVectorCache();
console.log('Database initialized');

// Seed core-memory blocks (Slice 3, ported from reference implementation). The 013 migration
// (run inside initDb) creates the table; this fills in the starter blocks so
// the boys have something to see + edit from turn one. byte-light has no
// listCompanions module (single house, two-in-one-brain), so the companion set
// is the static [companion-a, companion-b]. seedDefaultBlocks is seed-if-empty (no-ops once
// any block exists) and ensureCompanionBlocks is per-companion idempotent — so
// both are safe on every boot. user_name comes from config (the operator in the live
// house). Wrapped in try/catch like reference implementation so a seed hiccup never blocks boot.
const memoryCompanions = [
  { slug: 'companion-a', display_name: 'Companion A' },
  { slug: 'companion-b', display_name: 'Companion B' },
];
try {
  seedDefaultBlocks(config.identity.user_name, memoryCompanions);
  ensureCompanionBlocks(memoryCompanions);
} catch (err) {
  console.warn('[MemoryBlocks] Companion seeding skipped:', err instanceof Error ? err.message : err);
}

// Create Express app
const app = express();

// Trust proxy headers (e.g. Cloudflare tunnel, nginx)
app.set('trust proxy', 1);

// Memory-burst tripwire breadcrumb: method + path only (no query strings, no
// bodies) so an RSS spike snapshot can name what the process was serving.
app.use((req, _res, next) => {
  recordActivity('http', `${req.method} ${req.path}`);
  next();
});

// Environment-conditional origins
const IS_DEV = process.env.NODE_ENV !== 'production';
const corsOrigins: string[] = [...config.cors.origins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
if (IS_DEV) corsOrigins.push('http://localhost:5173');

const connectSrc: string[] = ["'self'", "https://api.giphy.com"];
// Derive WebSocket connect sources from CORS origins
for (const origin of config.cors.origins) {
  const wsOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  connectSrc.push(wsOrigin);
}
if (IS_DEV) connectSrc.push(`ws://localhost:${PORT}`);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc,
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: null,
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(securityHeaders);
app.use(rateLimiter);

// CORS
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// All API routes — auth middleware is applied selectively inside the router
app.use('/api', apiRoutes);

// Command Center MCP endpoint
if (config.command_center.enabled) {
  import('./routes/cc-mcp.js').then(m => app.use('/mcp/cc', m.default));
}

// House tool-belt MCP endpoint. Mount synchronously before listen() so the
// owned Codex app-server can never race route registration during startup.
app.use('/mcp/belt', mcpBeltRouter);

// Serve sticker files
const stickersDir = join(PROJECT_ROOT, 'data', 'stickers');
mkdirSync(stickersDir, { recursive: true });
app.use('/stickers', express.static(stickersDir, { maxAge: '1d', fallthrough: true }));

// Serve frontend static build (works in dev too if frontend is pre-built)
const frontendPaths = [
  join(__dirname, '../../frontend/build'),         // From compiled dist/
  join(__dirname, '../../../packages/frontend/build'), // From src/ via tsx
];
const frontendBuildPath = frontendPaths.find(p => existsSync(p));
if (frontendBuildPath) {
  console.log(`Serving frontend from: ${frontendBuildPath}`);
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(join(frontendBuildPath, 'index.html'));
  });
} else {
  console.log('No frontend build found — use Vite dev server on :5173');
}

// Global error handler — must be after all routes
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Initialize agent service (shared between WebSocket and orchestrator)
const agentService = new AgentService();

// Initialize voice service
const voiceService = new VoiceService();
setVoiceService(voiceService);

// Initialize push service
// VAPID resolves through the BYOK store (DB → env). Read at boot, so a
// saved value takes effect on the next restart.
const pushService = new PushService(
  getSecret('vapid_public_key'),
  getSecret('vapid_private_key'),
  getSecret('vapid_contact'),
);
agentService.setPushService(pushService);
import('./services/limit-watch.js').then(m => m.startLimitWatch({
  push: pushService,
  voiceUsage: () => voiceService.getElevenLabsUsage(),
}));
// Heartbeat idle outbox watcher notifies through the same service — a
// background-task finding delivered out-of-turn pushes like any reply.
setHeartbeatPushService(pushService);

// Initialize Discord gateway (config-gated with env fallback)
import { getConfigBool } from './services/db.js';

let discordService: DiscordService | null = null;

// Check config DB first, fall back to config file / env var for first boot
const discordEnabled = getConfigBool('discord.enabled', config.discord.enabled);
if (discordEnabled && getSecret('discord_bot_token')) {
  discordService = new DiscordService(agentService, registry);
  discordService.start();
}

// Initialize Telegram gateway (config-gated with env fallback)
let telegramService: TelegramService | null = null;

const telegramEnabled = getConfigBool('telegram.enabled', config.telegram.enabled);
if (telegramEnabled && getSecret('telegram_bot_token')) {
  telegramService = new TelegramService(agentService, registry, voiceService);
  telegramService.start();
}

// Initialize orchestrator
const orchestrator = new Orchestrator(agentService, pushService);
orchestrator.start();

// Make orchestrator, agent, voice, push, and discord services available to route handlers
app.locals.orchestrator = orchestrator;
app.locals.agentService = agentService;
app.locals.voiceService = voiceService;
app.locals.pushService = pushService;
app.locals.discordService = discordService;
app.locals.telegramService = telegramService;

// Wire gateway services for status reporting
setGatewayServices({ discord: discordService, telegram: telegramService });

// Attach WebSocket server
console.log('Initializing WebSocket server...');
const wss = createWebSocketServer(server, agentService, orchestrator);
console.log('WebSocket server initialized');
startMemoryProfiler();
startMemoryMonitor();

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Auth enabled: ${config.auth.password ? 'yes' : 'no'}`);
  console.log(`Companion: ${config.identity.companion_name} | User: ${config.identity.user_name}`);
});

// Graceful shutdown — unified handler
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // Prevent double-shutdown
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);

  // 1. Abort any active Claude query first (prevents orphaned SDK subprocess)
  agentService.stopGeneration();

  // 1b. Reap any warm Claude CLI heartbeat sessions. Idempotent and a no-op
  // on an empty session map (nothing is spawned while
  // CLAUDE_CLI_HEARTBEAT_ENABLED is off), so this is safe to call
  // unconditionally and gives the CLI lane a clean subprocess teardown.
  try { shutdownAllHeartbeats(); } catch { /* best-effort */ }

  // 1c. Release supervisor ownership while leaving the detached, private
  // Codex app-server warm for the next backend process to adopt.
  try { void codexSupervisor.stop(); } catch { /* best-effort */ }

  // 1d. Close MCP transports owned by this HTTP process. The Codex daemon
  // reconnects to the next backend using the persisted private credential.
  try { await closeBeltMcpSessions(); } catch { /* best-effort */ }
  try { shutdownEmbeddings(); } catch { /* best-effort */ }

  // 2. Stop orchestrator (clears all intervals/crons)
  orchestrator.stop();

  // 3. Stop gateway services
  if (discordService) await discordService.stop().catch(() => {});
  if (telegramService) await telegramService.stop().catch(() => {});

  // 4. Close WebSocket connections
  wss.clients.forEach(ws => ws.close());
  wss.close();

  // 5. Close HTTP server and database
  server.close(() => {
    console.log('Server closed');
    db.close();
    process.exit(0);
  });

  // 6. Safety timeout — force exit if cleanup hangs
  setTimeout(() => {
    console.error('Graceful shutdown timed out after 8s — force exiting');
    process.exit(1);
  }, 8000).unref();
}


process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Global fallback for transient socket errors (belt + suspenders)
// Primary fix is in agent.ts — this catches any escapes from third-party SDKs
// ---------------------------------------------------------------------------

const TRANSIENT_SOCKET_ERROR_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);

function isTransientSocketError(err: unknown): boolean {
  const anyErr = err as any;
  return TRANSIENT_SOCKET_ERROR_CODES.has(anyErr?.code);
}

process.on('uncaughtException', (err) => {
  if (isTransientSocketError(err)) {
    console.warn('[Process] Transient socket error (uncaughtException, suppressed):', (err as any).code);
    return; // Don't crash
  }
  console.error('[Process] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  if (isTransientSocketError(reason)) {
    console.warn('[Process] Transient socket error (unhandledRejection, suppressed):', (reason as any).code);
    return; // Don't crash
  }
  console.error('[Process] Unhandled rejection:', reason);
  process.exit(1);
});
