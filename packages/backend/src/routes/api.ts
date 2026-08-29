import { Router } from 'express';

// Middleware
import { authMiddleware } from '../middleware/auth.js';

// Services
import { getRecentAuditEntries } from '../services/audit.js';
import { listSessionHistory } from '../services/db.js';

// Config
import { getBytelightConfig } from '../config.js';

// Route modules
import { createPublicRoutes } from './public-routes.js';
import { createInternalRoutes } from './internal-routes.js';
import ccRoutes from './cc-routes.js';
import { createPreferencesRoutes } from './preferences-routes.js';
import { createProfilesRoutes } from './profiles-routes.js';
import { createCompanionSettingsRoutes } from './companion-settings-routes.js';
import { createRoomsRoutes } from './rooms-routes.js';
import { createChatRoutes } from './chat-routes.js';
import { createFilesRoutes } from './files-routes.js';
import { createCanvasRoutes } from './canvas-routes.js';
import { createPushRoutes } from './push-routes.js';
import { createOrchestratorRoutes } from './orchestrator-routes.js';
import { createDiscordRoutes } from './discord-routes.js';
import { createMindRoutes } from './mind-routes.js';
import { createMemoryRoutes } from './memory-routes.js';
import { createXrayRoutes } from './xray-routes.js';
import { createStickerRoutes } from './stickers-routes.js';
import runtimeAdminRoutes from './runtime-admin.js';
import messagesRouter from './messages.js';
import modelsRouter from './models.js';
import codexAuthRouter from './codex-auth.js';
import usageRouter from './usage.js';
import starredRouter from './starred.js';
import studioRouter from './studio.js';
import gifRouter from './gif.js';
import mcpServersRouter from './mcp-servers.js';
import secretsRouter from './secrets.js';

// ============================================================================
// API Router Composition
// ============================================================================

const router = Router();

// ----------------------------------------------------------------------------
// 1. Public routes (no auth required)
// ----------------------------------------------------------------------------
router.use(createPublicRoutes());

// ----------------------------------------------------------------------------
// 2. Internal routes (localhost-only, no auth)
// ----------------------------------------------------------------------------
router.use(createInternalRoutes());

// ----------------------------------------------------------------------------
// 3. Auth boundary (all routes below require authentication)
// ----------------------------------------------------------------------------
router.use(authMiddleware);

// ----------------------------------------------------------------------------
// 4. Command Center (feature-flagged)
// ----------------------------------------------------------------------------
router.use('/cc', (req, res, next) => {
  if (!getBytelightConfig().command_center.enabled) {
    res.status(404).json({ error: 'Command Center is disabled' });
    return;
  }
  next();
}, ccRoutes);

// ----------------------------------------------------------------------------
// 5. Protected concern routers
// ----------------------------------------------------------------------------
router.use(createPreferencesRoutes());
// Speaker profiles (companion-a/companion-b/user/fallback avatars + names) — ported from
// reference implementation. Sits with the other user-facing settings routers.
router.use(createProfilesRoutes());
// Companion settings — thread-override routes powering the chat-header
// model pill (Slice 5a resurrection). Tag position: directly after
// createPreferencesRoutes(), after authMiddleware above
// (stable-pre-rollback-2026-06-20 api.ts:71-72) — same relative slot here.
router.use(createCompanionSettingsRoutes());
// Rooms — companion registry + per-thread roster (Arc C Slice 2). Read/write
// plumbing for the Slice 3 picker; nothing reads the roster for dispatch yet.
// Mounted after authMiddleware above, beside its sibling
// companion-facing routers.
router.use(createRoomsRoutes());
router.use(createChatRoutes());
router.use(createFilesRoutes());
router.use(messagesRouter);
// Codex (ChatGPT OAuth) auth flow — tag position: directly after
// messagesRouter, after authMiddleware (Slice 3c port).
router.use(codexAuthRouter);

// Diagnostics: audit log
router.get('/audit', (req, res) => {
  try {
    const { limit } = req.query;
    const entries = getRecentAuditEntries(limit ? parseInt(limit as string, 10) : 50);
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Diagnostics: session lifecycle log (real session_history rows, newest-first).
// Cost/tokens are owned by the Usage tab (usage_events); not surfaced here.
router.get('/sessions', (req, res) => {
  try {
    const { limit } = req.query;
    const sessions = listSessionHistory(limit ? parseInt(limit as string, 10) : 50);
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.use(createCanvasRoutes());
router.use(createPushRoutes());
router.use(createOrchestratorRoutes());
router.use(createDiscordRoutes());
router.use(createMindRoutes());
// Memory Blocks — authenticated Letta-style core-memory API powering the
// Settings → Memory panel (Slice 2, ported from reference implementation). Mounted beside
// createMindRoutes, after authMiddleware above.
router.use(createMemoryRoutes());
router.use(createXrayRoutes());
router.use(createStickerRoutes());
router.use(usageRouter);
router.use(starredRouter);

// Studio — image-generation settings, reference drawers, and gallery
// (ported from reference implementation/reference implementation). Authed via authMiddleware above.
router.use(studioRouter);

// GIF Studio — authenticated ffmpeg editing pipeline.
router.use(gifRouter);

// Managed MCP servers — registry CRUD + test/discover (ported from the
// reference implementation, Apache 2.0). Authed via authMiddleware above.
router.use(mcpServersRouter);

// BYOK secrets store — DB-backed API keys/tokens (list/reveal/set/clear).
// Authed via authMiddleware above (Slice 2a).
router.use(secretsRouter);

// Phase 2 Step 3 — multi-provider model catalog. Catalog endpoint returns
// the union of Claude + (when configured) Ollama models. Status endpoint
// surfaces routing mode + provider connectivity for the Settings UI.
// (Slice 3c port; tag mounted after mcpServersRouter + usageRouter — same
// relative slot here, before main's post-rollback runtimeAdminRoutes.)
router.use(modelsRouter);

// Runtime health / SDK-refresh card (ported from reference implementation/reference implementation — light
// path, no agent.ts touch). Self-prefixed at /runtime; sits below
// authMiddleware above, so both GET /runtime/health and
// POST /runtime/update-sdk require auth.
router.use(runtimeAdminRoutes);

// ============================================================================
// Export
// ============================================================================

export default router;
