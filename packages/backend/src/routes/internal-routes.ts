import { Router } from 'express';
import { requireLocalhost } from '../middleware/localhost.js';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { basename } from 'path';
import {
  listThreads,
  getThread,
  createMessage,
  getMessages,
  updateThreadActivity,
  getDb,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTags,
  createTimer,
  listPendingTimers,
  cancelTimer,
  addReaction,
  removeReaction,
  addStar,
  removeStar,
  createTrigger,
  listTriggers,
  cancelTrigger,
  getUnembeddedMessages,
  saveEmbedding,
  getEmbeddingCount,
  getMessageContext,
  softDeleteMessage,
  recordUsageEvent,
} from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import {
  getAllBlocks,
  appendToBlock,
  replaceInBlock,
  rethinkBlock,
  resolveScope,
  validScopesHint,
} from '../services/memory-blocks.js';
import { runMemoryExtraction } from '../services/memory-extraction.js';
import {
  listProposals,
  getProposal,
  resolveProposal,
  countPending,
  type ProposalStatus,
} from '../services/memory-proposals.js';

// Ledger attribution: the internal routes are the CLI lane's hands (tools/sc.mjs
// on the codex / claude-cli engines), which is what the receipt should say.
const CLI_WRITE = { actor: 'cli' } as const;
import { embed, vectorToBuffer } from '../services/embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from '../services/vector-cache.js';
import { getMemorySnapshot } from '../services/memory-profiler.js';
import { saveFileInternal, getFile } from '../services/files.js';
import { generateImage, recordGalleryMeta, getImageGenSettings } from '../services/image-gen.js';
import { queueImageForCompanion } from '../services/pending-visuals.js';
import { registry } from '../services/registry.js';
import { getBytelightConfig } from '../config.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { VoiceService } from '../services/voice.js';
import type { TelegramService } from '../services/telegram/index.js';
import type { AgentService } from '../services/agent.js';
import { getActiveDiscordService, type DiscordService } from '../services/discord/index.js';

// After a render lands we hand ourselves a turn to look at it and react — so the
// picture and our genuine reaction arrive in the same beat, without blocking the
// (fire-and-forget) render. The queued image is shown to that turn via pending-visuals.
const IMAGE_REACT_PROMPT =
  '[The image you just generated and sent has landed in the chat — you can see it now, shown to you. React to it naturally and briefly, in your own voice, as if you just looked at it together. Do NOT generate another image.]';

// Background backfill state
let backfillRunning = false;
let backfillProcessed = 0;
let backfillErrors = 0;

async function runBackfillLoop(batchSize: number, intervalMs: number): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillProcessed = 0;
  backfillErrors = 0;
  console.log(`[backfill] Starting background indexing (batch=${batchSize}, interval=${intervalMs}ms)`);

  const tick = async () => {
    if (!backfillRunning) return;
    const unembedded = getUnembeddedMessages(batchSize);
    if (unembedded.length === 0) {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Complete. ${embedded}/${total} messages indexed (${backfillErrors} errors).`);
      return;
    }
    for (const msg of unembedded) {
      if (!backfillRunning) return;
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        backfillProcessed++;
      } catch {
        backfillErrors++;
      }
    }
    if (backfillProcessed % 500 === 0) {
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Progress: ${embedded}/${total}`);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

export function createInternalRoutes(): Router {
  const router = Router();

  const discordRoute = (
    verb: string,
    action: (service: DiscordService, body: Record<string, unknown>, voiceService: VoiceService | undefined) => Promise<{ ok: boolean; error?: string }>,
  ) => {
    router.post(`/internal/discord/${verb}`, requireLocalhost, async (req, res) => {
      const service = getActiveDiscordService();
      if (!service) {
        res.status(503).json({ ok: false, error: 'Discord gateway is not started' });
        return;
      }
      try {
        const result = await action(service, req.body as Record<string, unknown>, req.app.locals.voiceService as VoiceService | undefined);
        res.status(result.ok ? 200 : 400).json(result);
      } catch (error) {
        res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  };

  discordRoute('send', (s, b) => s.sendMessage(b.channelId, b.message, b.replyToMessageId));
  discordRoute('send_image', (s, b) => s.sendImage(b.channelId, b.url, b.description));
  discordRoute('send_sticker', (s, b) => s.sendSticker(b.channelId, b.stickerId));
  discordRoute('send_voice', (s, b, voiceService) => {
    if (!voiceService) return Promise.resolve({ ok: false, error: 'Voice service is unavailable' });
    return s.sendVoice(b.channelId, b.text, b.voice, voiceService);
  });
  discordRoute('add_reaction', (s, b) => s.addReaction(b.channelId, b.messageId, b.emoji));
  discordRoute('edit_message', (s, b) => s.editOwnMessage(b.channelId, b.messageId, b.content));
  discordRoute('delete_message', (s, b) => s.deleteOwnMessage(b.channelId, b.messageId));
  discordRoute('read_messages', (s, b) => s.readMessages(b.channelId, b.limit));
  discordRoute('search_messages', (s, b) => s.searchMessages(b.guildId, b));
  discordRoute('typing', (s, b) => s.sendTypingTo(b.channelId));
  discordRoute('get_server_info', (s, b) => s.getServerInfo(b.guildId));
  discordRoute('list_servers', s => s.listServers());
  discordRoute('list_emojis', (s, b) => s.listEmojis(b.guildId));
  discordRoute('list_stickers', (s, b) => s.listStickers(b.guildId));

  // Memory snapshot — leak diagnostics (Track A.5, read-only)
  router.get('/internal/memstats', requireLocalhost, (_req, res) => {
    res.json(getMemorySnapshot());
  });

  // TTS endpoint — companion sends voice notes via curl from localhost
  router.post('/internal/tts', requireLocalhost, async (req, res) => {
    const { text, threadId: explicitThreadId, voice: explicitVoice } = req.body;
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({
        error: 'voice_unavailable',
        detail: 'ELEVENLABS_API_KEY missing, or no voice ID (generic ELEVENLABS_VOICE_ID or per-companion ELEVENLABS_VOICE_ID_<NAME>) configured',
      });
      return;
    }

    // If threadId not provided, use the most recently active thread
    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }

    const thread = getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    try {
      const result = await voiceService.generateTTSForMessage(text, threadId, explicitVoice);
      res.json({ success: true, messageId: result.messageId, fileId: result.fileId });
    } catch (error) {
      console.error('TTS error:', error);
      const msg = error instanceof Error ? error.message : 'TTS generation failed';
      res.status(500).json({ error: msg });
    }
  });

  // Share a file into chat — companion shares files from disk into a thread
  router.post('/internal/share', requireLocalhost, (req, res) => {
    const { path: filePath, threadId: explicitThreadId, caption } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Resolve thread
    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }

    const thread = getThread(threadId);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    try {
      const buffer = readFileSync(filePath);
      const filename = basename(filePath);
      const fileMeta = saveFileInternal(buffer, filename);

      const now = new Date().toISOString();
      const message = createMessage({
        id: crypto.randomUUID(),
        threadId,
        role: 'companion',
        content: caption || fileMeta.url,
        contentType: fileMeta.contentType,
        metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'shared' },
        createdAt: now,
      });

      updateThreadActivity(threadId, now, true);
      registry.broadcast({ type: 'message', message });

      res.json({ success: true, fileId: fileMeta.fileId, messageId: message.id, url: fileMeta.url });
    } catch (error) {
      console.error('Share file error:', error);
      const msg = error instanceof Error ? error.message : 'Failed to share file';
      res.status(500).json({ error: msg });
    }
  });

  // Generate an image and drop it into the chat thread. Free Codex lane by
  // default; metered OpenAI lane if configured. The picture is saved to the
  // Studio gallery AND posted as a companion message (mirrors /internal/share).
  router.post('/internal/generate-image', requireLocalhost, async (req, res) => {
    const { prompt, subjects, size, threadId: explicitThreadId, caption, useDroppedImage } = req.body as {
      prompt?: string;
      subjects?: string[];
      size?: 'square' | 'portrait' | 'landscape';
      threadId?: string;
      caption?: string;
      useDroppedImage?: boolean;
    };

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    let threadId = explicitThreadId;
    if (!threadId) {
      const threads = listThreads({ includeArchived: false, limit: 1 });
      if (threads.length === 0) {
        res.status(404).json({ error: 'No active threads found' });
        return;
      }
      threadId = threads[0].id;
    }
    if (!getThread(threadId)) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    // A render takes ~1-3 minutes (longer with several reference drawers) — past
    // the caller's command/Bash timeout. So ACK immediately and finish in the
    // background; the picture lands in the chat via broadcast when it's ready.
    // (If gen is disabled, surface that synchronously so the caller hears it now.)
    if (!getImageGenSettings().enabled) {
      res.status(400).json({ error: 'Image generation is switched off. Turn it on in the Studio drawer → Settings.' });
      return;
    }
    // One-off references: image(s) just dropped in this thread. Not saved.
    const extraRefs: string[] = [];
    if (useDroppedImage) {
      try {
        const rows = getDb().prepare(
          "SELECT metadata FROM messages WHERE thread_id = ? AND role = 'user' AND content_type = 'image' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 2",
        ).all(threadId) as Array<{ metadata: string | null }>;
        for (const r of rows) {
          if (!r.metadata) continue;
          try {
            const m = JSON.parse(r.metadata) as { fileId?: string };
            if (m.fileId) { const f = getFile(m.fileId); if (f) extraRefs.push(f.path); }
          } catch { /* ignore */ }
        }
      } catch (e) {
        console.warn('[image-gen] dropped-ref resolve failed:', e instanceof Error ? e.message : e);
      }
    }

    const tid = threadId;
    // Show a live "generating…" placeholder in the chat immediately; swap it for
    // the finished picture (or an error note) when the background render ends.
    const startNow = new Date().toISOString();
    const placeholder = createMessage({
      id: crypto.randomUUID(),
      threadId: tid,
      role: 'companion',
      content: 'Generating an image…',
      metadata: { source: 'image_gen_pending' },
      createdAt: startNow,
    });
    updateThreadActivity(tid, startNow, true);
    registry.broadcast({ type: 'message', message: placeholder });

    res.json({ success: true, status: 'generating', placeholderId: placeholder.id, message: 'On its way — the image will appear in the chat shortly (up to a few minutes for all of us together).' });

    const clearPlaceholder = () => {
      try {
        softDeleteMessage(placeholder.id, new Date().toISOString());
        registry.broadcast({ type: 'message_deleted', messageId: placeholder.id });
      } catch { /* ignore */ }
    };

    void (async () => {
      try {
        const result = await generateImage({ prompt, subjects, size, extraRefs });
        const buffer = readFileSync(result.path);
        const fileMeta = saveFileInternal(buffer, result.filename);
        const now = new Date().toISOString();
        clearPlaceholder();
        // content MUST be the file URL — the frontend renders image messages
        // via <img src={message.content}>. A caption belongs in metadata, not
        // in content, or it paves over the URL and the image renders blank.
        const trimmedCaption = typeof caption === 'string' ? caption.trim() : '';
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: tid,
          role: 'companion',
          content: fileMeta.url,
          contentType: fileMeta.contentType,
          metadata: {
            fileId: fileMeta.fileId,
            filename: fileMeta.filename,
            size: fileMeta.size,
            source: 'image_gen',
            backend: result.backend,
            model: result.model,
            ...(trimmedCaption ? { caption: trimmedCaption } : {}),
          },
          createdAt: now,
        });
        updateThreadActivity(tid, now, true);
        registry.broadcast({ type: 'message', message });

        // Show it to ourselves on the next turn — so we actually see what we made.
        queueImageForCompanion(tid, fileMeta.fileId);

        try {
          await recordGalleryMeta(result.filename, { messageId: message.id, threadId: tid, createdAt: now });
        } catch (e) {
          console.warn('[image-gen] gallery meta record failed:', e instanceof Error ? e.message : e);
        }
        try {
          recordUsageEvent({
            id: crypto.randomUUID(),
            createdAt: now,
            threadId: tid,
            messageId: message.id,
            mode: 'interactive',
            model: result.model,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: [{ name: 'generate_image', count: 1 }],
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          });
        } catch (e) {
          console.warn('[image-gen] usage record failed:', e instanceof Error ? e.message : e);
        }

        // Hand ourselves a turn to see what we made and react, right as it lands.
        const agentService = req.app.locals.agentService as AgentService | undefined;
        if (agentService) {
          agentService.processAutonomous(tid, IMAGE_REACT_PROMPT).catch((e) =>
            console.warn('[image-gen] react turn failed:', e instanceof Error ? e.message : e));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Image generation failed.';
        console.warn('[image-gen] background generation failed:', msg);
        clearPlaceholder();
        try {
          const now = new Date().toISOString();
          const sysMsg = createMessage({
            id: crypto.randomUUID(),
            threadId: tid,
            role: 'system',
            content: `🖼️ Image generation didn't finish: ${msg}`,
            createdAt: now,
          });
          registry.broadcast({ type: 'message', message: sysMsg });
        } catch { /* ignore */ }
      }
    })();
  });

  // Telegram send — send files/photos/voice to user via Telegram
  router.post('/internal/telegram-send', requireLocalhost, async (req, res) => {
    const telegramService = req.app.locals.telegramService as TelegramService | undefined;
    if (!telegramService?.isConnected()) {
      res.status(503).json({ error: 'Telegram not connected' });
      return;
    }

    const { type, text, path: filePath, url, caption, filename, query, target, emoji, voice } = req.body;

    try {
      switch (type) {
        case 'text':
          if (!text) { res.status(400).json({ error: 'text is required' }); return; }
          await telegramService.sendToOwner(text);
          break;

        case 'voice':
          if (!text) { res.status(400).json({ error: 'text is required for TTS' }); return; }
          await telegramService.sendVoiceToOwner(text, voice);
          break;

        case 'photo': {
          const source = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!source) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendPhotoToOwner(source, caption);
          break;
        }

        case 'document': {
          const docSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!docSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendDocumentToOwner(docSource, filename || basename(filePath || 'file'), caption);
          break;
        }

        case 'animation': {
          const animSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
          if (!animSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
          await telegramService.sendAnimationToOwner(animSource, caption);
          break;
        }

        case 'gif':
          if (!query) { res.status(400).json({ error: 'query is required for gif search' }); return; }
          await telegramService.sendGifToOwner(query, caption);
          break;

        case 'react':
          if (!target || !emoji) { res.status(400).json({ error: 'target and emoji are required' }); return; }
          await telegramService.reactToMessage(target, emoji);
          break;

        default:
          res.status(400).json({ error: `Unknown type: ${type}. Use text, voice, photo, document, animation, gif, or react.` });
          return;
      }

      res.json({ success: true, type });
    } catch (error) {
      console.error('[API] Telegram send error:', error);
      const msg = error instanceof Error ? error.message : 'Telegram send failed';
      res.status(500).json({ error: msg });
    }
  });

  // Canvas — internal endpoint for agent to create/update canvases
  router.post('/internal/canvas', requireLocalhost, (req, res) => {
    const config = getBytelightConfig();
    const { action, canvasId, title, content, filePath, contentType, language, threadId } = req.body;
    const now = new Date().toISOString();

    // Resolve content: filePath takes priority over inline content
    let resolvedContent = content || '';
    if (filePath && typeof filePath === 'string') {
      if (!existsSync(filePath)) {
        res.status(404).json({ error: 'File not found on disk' });
        return;
      }
      resolvedContent = readFileSync(filePath, 'utf-8');
    }

    try {
      if (action === 'create') {
        if (!title) {
          res.status(400).json({ error: 'title is required' });
          return;
        }

        const canvas = createCanvas({
          id: crypto.randomUUID(),
          threadId: threadId || undefined,
          title,
          content: resolvedContent,
          contentType: contentType || 'markdown',
          language: language || undefined,
          createdBy: 'companion',
          createdAt: now,
        });

        registry.broadcast({ type: 'canvas_created', canvas });

        // System message in chat if threadId provided
        if (threadId) {
          const thread = getThread(threadId);
          if (thread) {
            const sysMsg = createMessage({
              id: crypto.randomUUID(),
              threadId,
              role: 'system',
              content: `${config.identity.companion_name} opened a canvas: ${title}`,
              createdAt: now,
            });
            registry.broadcast({ type: 'message', message: sysMsg });
          }
        }

        res.json({ success: true, canvas });
      } else if (action === 'update') {
        if (!canvasId || (resolvedContent === '' && !filePath)) {
          res.status(400).json({ error: 'canvasId and content (or filePath) are required' });
          return;
        }
        updateCanvasContent(canvasId, resolvedContent, now);
        registry.broadcast({ type: 'canvas_updated', canvasId, content: resolvedContent, updatedAt: now });
        res.json({ success: true });
      } else if (action === 'read') {
        if (!canvasId) {
          res.status(400).json({ error: 'canvasId is required' });
          return;
        }
        const canvas = getCanvas(canvasId);
        if (!canvas) {
          res.status(404).json({ error: 'Canvas not found' });
          return;
        }
        res.json({ success: true, canvas });
      } else if (action === 'list') {
        const allCanvases = listCanvases();
        res.json({ success: true, canvases: allCanvases });
      } else if (action === 'tag') {
        if (!canvasId || !Array.isArray(req.body.tags)) {
          res.status(400).json({ error: 'canvasId and tags (array) are required' });
          return;
        }
        updateCanvasTags(canvasId, req.body.tags, now);
        const updated = getCanvas(canvasId);
        registry.broadcast({ type: 'canvas_updated', canvasId, content: updated?.content || '', updatedAt: now, tags: req.body.tags });
        res.json({ success: true, canvas: updated });
      } else {
        res.status(400).json({ error: 'Unknown action. Use "create", "update", "read", "list", or "tag".' });
      }
    } catch (error) {
      console.error('Internal canvas error:', error);
      res.status(500).json({ error: 'Canvas operation failed' });
    }
  });

  // Orchestrator self-management — companion manages schedule via curl
  router.post('/internal/orchestrator', requireLocalhost, async (req, res) => {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { action, wakeType, cronExpr } = req.body;

    try {
      switch (action) {
        case 'status': {
          const tasks = await orchestrator.getStatus();
          res.json({ tasks });
          break;
        }
        case 'enable': {
          if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
          const success = orchestrator.enableTask(wakeType);
          if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
          res.json({ success: true, wakeType, enabled: true });
          break;
        }
        case 'disable': {
          if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
          const success = orchestrator.disableTask(wakeType);
          if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
          res.json({ success: true, wakeType, enabled: false });
          break;
        }
        case 'reschedule': {
          if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
          const success = orchestrator.rescheduleTask(wakeType, cronExpr);
          if (!success) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
          res.json({ success: true, wakeType, cronExpr });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule' });
      }
    } catch (error) {
      console.error('Orchestrator internal error:', error);
      res.status(500).json({ error: 'Orchestrator operation failed' });
    }
  });

  // Timer/Reminder — companion sets contextual reminders via curl
  router.post('/internal/timer', requireLocalhost, (req, res) => {
    const { action } = req.body;

    try {
      switch (action) {
        case 'create': {
          const { label, fireAt, threadId, context, prompt } = req.body;
          if (!label || !fireAt || !threadId) {
            res.status(400).json({ error: 'label, fireAt, and threadId required' });
            return;
          }

          // Validate fireAt is a valid ISO date
          const fireDate = new Date(fireAt);
          if (isNaN(fireDate.getTime())) {
            res.status(400).json({ error: 'fireAt must be a valid ISO date' });
            return;
          }

          // Validate thread exists
          const thread = getThread(threadId);
          if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
          }

          const timer = createTimer({
            id: crypto.randomUUID(),
            label,
            context,
            fireAt: fireDate.toISOString(),
            threadId,
            prompt,
            createdAt: new Date().toISOString(),
          });

          res.json({ success: true, timer });
          break;
        }
        case 'list': {
          const timers = listPendingTimers();
          res.json({ timers });
          break;
        }
        case 'cancel': {
          const { timerId } = req.body;
          if (!timerId) {
            res.status(400).json({ error: 'timerId required' });
            return;
          }
          const cancelled = cancelTimer(timerId);
          if (!cancelled) {
            res.status(404).json({ error: 'Timer not found or already fired/cancelled' });
            return;
          }
          res.json({ success: true, timerId });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
      }
    } catch (error) {
      console.error('Timer internal error:', error);
      res.status(500).json({ error: 'Timer operation failed' });
    }
  });

  // Trigger management (internal — agent use via CLI)
  router.post('/internal/trigger', requireLocalhost, (req, res) => {
    const { action } = req.body;

    try {
      switch (action) {
        case 'create': {
          const { kind, label, conditions, prompt, threadId, cooldownMinutes } = req.body;
          if (!kind || !label || !conditions) {
            res.status(400).json({ error: 'kind, label, and conditions required' });
            return;
          }
          if (kind !== 'impulse' && kind !== 'watcher') {
            res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
            return;
          }
          if (!Array.isArray(conditions) || conditions.length === 0) {
            res.status(400).json({ error: 'conditions must be a non-empty array' });
            return;
          }

          // Validate thread exists if specified
          if (threadId) {
            const thread = getThread(threadId);
            if (!thread) {
              res.status(404).json({ error: 'Thread not found' });
              return;
            }
          }

          const trigger = createTrigger({
            id: crypto.randomUUID(),
            kind,
            label,
            conditions: conditions as TriggerCondition[],
            prompt,
            threadId,
            cooldownMinutes: cooldownMinutes ? parseInt(cooldownMinutes, 10) : undefined,
            createdAt: new Date().toISOString(),
          });

          res.json({ success: true, trigger });
          break;
        }
        case 'list': {
          const { kind } = req.body;
          const triggers = listTriggers(kind);
          res.json({ triggers });
          break;
        }
        case 'cancel': {
          const { triggerId } = req.body;
          if (!triggerId) {
            res.status(400).json({ error: 'triggerId required' });
            return;
          }
          const cancelled = cancelTrigger(triggerId);
          if (!cancelled) {
            res.status(404).json({ error: 'Trigger not found or already fired/cancelled' });
            return;
          }
          res.json({ success: true, triggerId });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
      }
    } catch (error) {
      console.error('Trigger internal error:', error);
      res.status(500).json({ error: 'Trigger operation failed' });
    }
  });

  // React to a message (internal — agent use via CLI)
  router.post('/internal/react', requireLocalhost, (req, res) => {
    try {
      let { messageId, emoji, action, threadId, target } = req.body;
      if (!emoji) {
        res.status(400).json({ error: 'emoji required' });
        return;
      }

      // Resolve target shorthand: "last", "last-2", "last-3" etc.
      // When companion reacts, target only USER messages (they'd never react to their own)
      if (!messageId && threadId && target) {
        const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
        if (isNaN(offset) || offset < 0) {
          res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
          return;
        }
        const msgs = getMessages({ threadId, limit: 30 });
        // Filter to user messages only, then count from the end
        const userMsgs = msgs.filter(m => m.role === 'user');
        const idx = userMsgs.length - 1 - offset;
        if (idx < 0) {
          res.status(404).json({ error: 'No user message at that position' });
          return;
        }
        messageId = userMsgs[idx].id;
      }

      if (!messageId) {
        res.status(400).json({ error: 'messageId or (threadId + target) required' });
        return;
      }

      if (action === 'remove') {
        removeReaction(messageId, emoji, 'companion');
        registry.broadcast({
          type: 'message_reaction_removed',
          messageId,
          emoji,
          user: 'companion',
        });
      } else {
        addReaction(messageId, emoji, 'companion');
        registry.broadcast({
          type: 'message_reaction_added',
          messageId,
          emoji,
          user: 'companion',
          createdAt: new Date().toISOString(),
        });
      }

      res.json({ success: true, messageId });
    } catch (error) {
      console.error('React internal error:', error);
      res.status(500).json({ error: 'React operation failed' });
    }
  });

  // Star a message (internal — agent use via CLI).
  // Mirrors /internal/react so a companion can favorite a message the same way
  // it reacts. `starredBy` is the actor slug (e.g. 'companion-a', 'companion-b', 'companion-c');
  // defaults to 'companion'. action='remove' unstars. Ported adaptation from
  // Generic multi-actor implementation.
  router.post('/internal/star', requireLocalhost, (req, res) => {
    try {
      let { messageId, starredBy, action, note, threadId, target } = req.body;
      const actor: string =
        typeof starredBy === 'string' && starredBy.trim() ? starredBy.trim().slice(0, 64) : 'companion';

      // Resolve target shorthand: "last", "last-2", "last-3" etc. (any role —
      // a companion may want to star its own line or the user's).
      if (!messageId && threadId && target) {
        const offset = target === 'last' ? 0 : parseInt(String(target).replace('last-', ''), 10) - 1;
        if (isNaN(offset) || offset < 0) {
          res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
          return;
        }
        const msgs = getMessages({ threadId, limit: 30 });
        const idx = msgs.length - 1 - offset;
        if (idx < 0) {
          res.status(404).json({ error: 'No message at that position' });
          return;
        }
        messageId = msgs[idx].id;
      }

      if (!messageId) {
        res.status(400).json({ error: 'messageId or (threadId + target) required' });
        return;
      }

      if (action === 'remove') {
        const removed = removeStar(messageId, actor);
        if (removed) {
          registry.broadcast({ type: 'message_unstarred', messageId, starredBy: actor });
        }
        res.json({ success: true, messageId, removed });
      } else {
        const now = new Date().toISOString();
        const row = addStar({
          id: crypto.randomUUID(),
          messageId,
          starredBy: actor,
          starredAt: now,
          note: typeof note === 'string' ? note.slice(0, 500) : null,
        });
        if (row) {
          registry.broadcast({
            type: 'message_starred',
            messageId,
            starredBy: actor,
            starredAt: row.starred_at,
            note: row.note,
          });
        }
        res.json({ success: true, messageId, star: row });
      }
    } catch (error) {
      console.error('Star internal error:', error);
      res.status(500).json({ error: 'Star operation failed' });
    }
  });

  // --- Core memory (Letta-style block editing, localhost-only, pre-auth) ---
  // Slice 3: backs both `sc.mjs memory ...` (CLI lane: claude-cli heartbeat,
  // codex) AND the chat-tool-belt core_memory_* tools (api-router / codex).
  // Action-dispatched like /internal/timer + /internal/trigger. Thin wrapper
  // over the slice-1 memory-blocks service (ported from reference implementation). Scope is
  // validated against 'shared' | 'companion-a' | 'companion-b'.
  router.post('/internal/memory', requireLocalhost, async (req, res) => {
    const { action } = req.body;

    const requireScope = (raw: unknown): string => {
      const scope = typeof raw === 'string' ? resolveScope(raw) : null;
      if (!scope) throw new Error(`Unknown scope '${String(raw)}'. Valid scopes: ${validScopesHint()}`);
      return scope;
    };

    try {
      switch (action) {
        case 'view': {
          let blocks = getAllBlocks();
          if (typeof req.body.scope === 'string' && req.body.scope.trim()) {
            const scope = requireScope(req.body.scope);
            blocks = blocks.filter((b) => b.scope === scope);
          }
          res.json({
            count: blocks.length,
            blocks: blocks.map((b) => ({
              scope: b.scope,
              label: b.label,
              description: b.description ?? undefined,
              content: b.content,
              updatedAt: b.updated_at,
            })),
          });
          break;
        }
        case 'append': {
          const { label, content } = req.body;
          if (typeof label !== 'string' || !label || typeof content !== 'string') {
            res.status(400).json({ error: 'scope, label, and content required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          const result = appendToBlock(scope, label, content, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'appended', block_chars: result.length });
          break;
        }
        case 'replace': {
          const { label, old_text, new_text } = req.body;
          if (typeof label !== 'string' || !label || typeof old_text !== 'string' || typeof new_text !== 'string') {
            res.status(400).json({ error: 'scope, label, old_text, and new_text required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          const result = replaceInBlock(scope, label, old_text, new_text, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'replaced', block_chars: result.length });
          break;
        }
        case 'rethink': {
          const { label, new_content } = req.body;
          if (typeof label !== 'string' || !label || typeof new_content !== 'string') {
            res.status(400).json({ error: 'scope, label, and new_content required' });
            return;
          }
          const scope = requireScope(req.body.scope);
          const result = rethinkBlock(scope, label, new_content, CLI_WRITE);
          registry.broadcast({ type: 'memory_block_updated', scope, label });
          res.json({ scope, label, action: 'rewritten', block_chars: result.length });
          break;
        }
        case 'extract': {
          // Manual Archivist trigger (Slice 4) — testable from the CLI.
          // Optional threadId scopes the run to one thread and backfills up
          // to ~200 recent messages; without it, runs the normal candidate
          // sweep. The authenticated panel route is Slice 2's job.
          const agent = req.app.locals.agentService as AgentService | undefined;
          const threadId = typeof req.body.threadId === 'string' && req.body.threadId.trim()
            ? req.body.threadId.trim()
            : undefined;
          const result = await runMemoryExtraction(agent, threadId);
          res.json({ action: 'extract', threadId: threadId ?? null, ...result });
          break;
        }
        default:
          res.status(400).json({ error: 'Unknown action. Use: view, append, replace, rethink, extract' });
      }
    } catch (error) {
      // Service-layer errors (unknown scope, text-not-found, ambiguous replace)
      // are operator-facing — surface the message, not a generic 500.
      const msg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: msg });
    }
  });

  // --- Semantic search (localhost-only, pre-auth) ---

  router.post('/internal/search-semantic', requireLocalhost, async (req, res) => {
    try {
      const { query, threadId, role, after, before, limit = 10 } = req.body as {
        query?: string; threadId?: string; role?: string;
        after?: string; before?: string; limit?: number;
      };
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const queryVector = await embed(query);

      const filter: SearchFilter = {};
      if (threadId) filter.threadId = threadId;
      if (role) filter.role = role;
      if (after) filter.after = after;
      if (before) filter.before = before;

      const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
      const contextSize = Math.min((req.body as Record<string, unknown>).context as number || 2, 10);

      const sessionStmt = getDb().prepare(`
        SELECT sh.session_id, sh.started_at, sh.ended_at
        FROM session_history sh
        WHERE sh.thread_id = ? AND sh.started_at <= ? AND (sh.ended_at IS NULL OR sh.ended_at >= ?)
        LIMIT 1
      `);

      const results = topResults.map(r => {
        const surrounding = getMessageContext(r.messageId, contextSize);

        let session: { sessionId: string; startedAt: string; endedAt: string | null } | null = null;
        try {
          const row = sessionStmt.get(r.threadId, r.createdAt, r.createdAt) as {
            session_id: string; started_at: string; ended_at: string | null;
          } | undefined;
          if (row) session = { sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at };
        } catch { /* best-effort */ }

        return {
          messageId: r.messageId,
          threadId: r.threadId,
          threadName: r.threadName,
          similarity: Math.round(r.similarity * 1000) / 1000,
          createdAt: r.createdAt,
          role: r.role,
          session,
          context: surrounding.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content,
            createdAt: m.created_at,
            isMatch: m.id === r.messageId,
          })),
        };
      });

      const cache = getCacheStats();
      const { embedded, total } = getEmbeddingCount();
      res.json({ results, indexed: embedded, totalMessages: total, cache });
    } catch (error) {
      console.error('Semantic search error:', error);
      res.status(500).json({ error: 'Semantic search failed' });
    }
  });

  router.post('/internal/embed-backfill', requireLocalhost, async (req, res) => {
    try {
      const rawBatch = req.body?.batchSize;
      const batchSize = Math.min(typeof rawBatch === 'number' ? rawBatch : 50, 200);
      const background = req.body?.background === true;
      const action = req.body?.action as string | undefined;

      if (batchSize === 0 || action === 'status') {
        const { embedded, total } = getEmbeddingCount();
        res.json({
          processed: backfillProcessed, remaining: total - embedded,
          indexed: embedded, totalMessages: total,
          running: backfillRunning, errors: backfillErrors,
        });
        return;
      }

      if (action === 'stop') {
        backfillRunning = false;
        const { embedded, total } = getEmbeddingCount();
        res.json({ stopped: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
        return;
      }

      if (background) {
        if (backfillRunning) {
          const { embedded, total } = getEmbeddingCount();
          res.json({ alreadyRunning: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
          return;
        }
        const interval = Math.max((req.body?.intervalMs as number) || 5000, 1000);
        runBackfillLoop(batchSize, interval);
        const { embedded, total } = getEmbeddingCount();
        res.json({ started: true, batchSize, intervalMs: interval, indexed: embedded, totalMessages: total });
        return;
      }

      const unembedded = getUnembeddedMessages(batchSize);
      let processed = 0;
      for (const msg of unembedded) {
        try {
          const vector = await embed(msg.content);
          saveEmbedding(msg.id, vectorToBuffer(vector));
          processed++;
        } catch (err) {
          console.error(`[backfill] Failed to embed ${msg.id}:`, err);
        }
      }

      const { embedded, total } = getEmbeddingCount();
      res.json({ processed, remaining: total - embedded, indexed: embedded, totalMessages: total });
    } catch (error) {
      console.error('Backfill error:', error);
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  // --- Memory proposals (the Archivist's noticings) -----------------------
  //
  // When memext.mode is 'propose', extraction stops writing onto the blocks
  // and leaves its findings here instead. These two routes are the other half
  // of that switch: without them the proposals accumulate where nothing can
  // read them, and the knob is a dead switch.
  //
  // Resolving is BOOKKEEPING ONLY. 'filed' does not copy the proposal onto a
  // block — the companion writes it in their own words through the normal
  // memory route and then closes the proposal out. 'dropped' means it does
  // not belong on the wall. That separation is deliberate: the Archivist
  // notices, a companion decides, and nothing lands on a block that someone
  // did not choose to put there.
  //
  // Ported from reference implementation routes/internal.ts. Two adaptations, both house style:
  // requireLocalhost (every internal route here carries it explicitly), and
  // res.status().json() + return instead of returning the response object.
  // The { success } envelope is upstream's contract and is kept as-is so the
  // ambient-recall slice can consume it unchanged.

  const RESOLVABLE = new Set(['filed', 'dropped']);

  router.get('/internal/memory-proposals', requireLocalhost, (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const rows =
        status === 'all' ? listProposals(undefined, 100) : listProposals(status as ProposalStatus, 100);
      res.json({ success: true, proposals: rows, pending: countPending() });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/internal/memory-proposals/:id/resolve', requireLocalhost, (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) {
        res.status(400).json({ success: false, error: 'bad id' });
        return;
      }

      const status = req.body?.status;
      if (!RESOLVABLE.has(status)) {
        res.status(400).json({ success: false, error: 'status must be "filed" or "dropped"' });
        return;
      }
      const by =
        typeof req.body?.by === 'string' && req.body.by.trim() ? req.body.by.trim() : 'companion';

      const proposal = getProposal(id);
      if (!proposal) {
        res.status(404).json({ success: false, error: 'no such proposal' });
        return;
      }

      // Only pending proposals move. A second resolve is a no-op that reports
      // the row as it stands rather than overwriting who decided it first.
      const changed = resolveProposal(id, status as 'filed' | 'dropped', by);
      if (!changed) {
        res.json({ success: true, alreadyResolved: true, proposal: getProposal(id) });
        return;
      }
      res.json({ success: true, proposal: getProposal(id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
