import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { listTriggers, getMostRecentActiveThread, listThreads } from '../services/db.js';
import { buildOrientationParts, getNativeClaudeMemoryDir, type HookContext } from '../services/hooks.js';
import { registry } from '../services/registry.js';
import { getBytelightConfig } from '../config.js';

// ============================================
// X-RAY PANEL — See behind the scenes
// ============================================

export function createXrayRoutes(): Router {
  const router = Router();

  // X-Ray: Identity (CLAUDE.md)
  router.get('/xray/identity', async (_req, res) => {
    try {
      const claudeMdPath = resolve(process.cwd(), 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        res.json({ content: null, error: 'CLAUDE.md not found' });
        return;
      }
      const content = readFileSync(claudeMdPath, 'utf-8');
      res.json({ content, path: claudeMdPath });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Identity update
  router.put('/xray/identity', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content required' });
        return;
      }
      const claudeMdPath = resolve(process.cwd(), 'CLAUDE.md');
      // Backup before writing
      if (existsSync(claudeMdPath)) {
        const backup = readFileSync(claudeMdPath, 'utf-8');
        const backupPath = claudeMdPath + '.backup';
        writeFileSync(backupPath, backup, 'utf-8');
      }
      writeFileSync(claudeMdPath, content, 'utf-8');
      res.json({ success: true, path: claudeMdPath });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Memory (MEMORY.md index + memory files)
  router.get('/xray/memory', async (_req, res) => {
    try {
      const config = getBytelightConfig();
      const repoMemoryDir = resolve(process.cwd(), '.claude/memory');
      const nativeMemoryDir = getNativeClaudeMemoryDir(config.agent.cwd);

      const readMemory = (memoryDir: string) => {
        const memoryMdPath = join(memoryDir, 'MEMORY.md');
        let index: string | null = null;
        const files: Array<{ name: string; path: string; content: string }> = [];
        if (existsSync(memoryMdPath)) index = readFileSync(memoryMdPath, 'utf-8');
        if (existsSync(memoryDir)) {
          for (const entry of readdirSync(memoryDir)) {
            if (entry.endsWith('.md') && entry !== 'MEMORY.md') {
              const filePath = join(memoryDir, entry);
              files.push({ name: entry, path: filePath, content: readFileSync(filePath, 'utf-8') });
            }
          }
        }
        return { index, files, memoryDir };
      };

      const native = readMemory(nativeMemoryDir);
      const repo = readMemory(repoMemoryDir);
      // Keep the old fields as the repo view for clients that have not learned
      // the two-source response yet; new clients should use native/repo.
      res.json({ ...repo, native, repo });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Memory file update
  router.put('/xray/memory/:filename', async (req, res) => {
    try {
      const { content } = req.body;
      const { filename } = req.params;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content required' });
        return;
      }
      const memoryDir = resolve(process.cwd(), '.claude/memory');
      const filePath = join(memoryDir, filename);

      // Security: ensure we're staying within memory dir
      if (!filePath.startsWith(memoryDir)) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      // Backup before writing
      if (existsSync(filePath)) {
        const backup = readFileSync(filePath, 'utf-8');
        writeFileSync(filePath + '.backup', backup, 'utf-8');
      }

      writeFileSync(filePath, content, 'utf-8');
      res.json({ success: true, path: filePath });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Wake prompts
  router.get('/xray/wakes', async (_req, res) => {
    try {
      const config = getBytelightConfig();
      const wakePath = config.orchestrator.wake_prompts_path;

      let rawContent: string | null = null;
      const prompts: Record<string, string> = {};

      if (existsSync(wakePath)) {
        rawContent = readFileSync(wakePath, 'utf-8');

        // Parse sections (## section_name)
        let currentSection: string | null = null;
        const lines: string[] = [];

        for (const line of rawContent.split('\n')) {
          const sectionMatch = line.match(/^##\s+(\w+)/);
          if (sectionMatch) {
            if (currentSection) {
              prompts[currentSection] = lines.join('\n').trim();
            }
            currentSection = sectionMatch[1].toLowerCase();
            lines.length = 0;
          } else if (currentSection) {
            lines.push(line);
          }
        }
        if (currentSection) {
          prompts[currentSection] = lines.join('\n').trim();
        }
      }

      res.json({ rawContent, prompts, path: wakePath });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Wake prompts update
  router.put('/xray/wakes', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content required' });
        return;
      }
      const config = getBytelightConfig();
      const wakePath = config.orchestrator.wake_prompts_path;

      // Backup before writing
      if (existsSync(wakePath)) {
        const backup = readFileSync(wakePath, 'utf-8');
        writeFileSync(wakePath + '.backup', backup, 'utf-8');
      }

      writeFileSync(wakePath, content, 'utf-8');
      res.json({ success: true, path: wakePath });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Context injection — LIVE preview of the real [Context] block.
  // Calls the same buildOrientationParts() that feeds every message, against a
  // representative thread, so the panel is a true mirror (not a static legend).
  // Query params let the operator dial fidelity:
  //   ?platform=web|discord|telegram|api  (default web) — channel framing
  //   ?includeStatic=true|false           (default true) — first-message vs mid-thread
  router.get('/xray/context', async (req, res) => {
    try {
      const config = getBytelightConfig();

      const PLATFORMS = ['web', 'discord', 'telegram', 'api'] as const;
      const platformParam = String(req.query.platform ?? 'web');
      const platform = (PLATFORMS as readonly string[]).includes(platformParam)
        ? (platformParam as (typeof PLATFORMS)[number])
        : 'web';
      // Default true; only an explicit "false" flips to a mid-thread preview.
      const includeStatic = String(req.query.includeStatic ?? 'true') !== 'false';

      // Pick a representative thread: the user's active one, else most recent,
      // else a synthetic placeholder so the preview still renders on an empty DB.
      const thread = getMostRecentActiveThread() ?? listThreads({ limit: 1 })[0] ?? null;

      const ctx: HookContext = {
        threadId: thread?.id ?? 'xray-preview',
        threadName: thread?.name ?? 'Preview',
        threadType: thread?.type ?? 'daily',
        streamMsgId: 'xray-preview',
        isAutonomous: false,
        registry,
        sessionId: null,
        platform,
        toolInsertions: [],
        getTextLength: () => 0,
      };

      // includeStatic=true mirrors a first-message turn (skills + chat-tools blocks);
      // false mirrors a mid-thread turn (those static blocks drop out).
      const parts = await buildOrientationParts(ctx, includeStatic);
      const raw = parts.map((p) => p.content).join('\n');

      res.json({
        parts,
        raw,
        identity: {
          companion_name: config.identity.companion_name,
          user_name: config.identity.user_name,
          timezone: config.identity.timezone,
        },
        meta: {
          threadName: ctx.threadName,
          platform: ctx.platform,
          includeStatic,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // X-Ray: Hooks (triggers and watchers)
  router.get('/xray/hooks', async (_req, res) => {
    try {
      const triggers = listTriggers();
      res.json({ triggers });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
