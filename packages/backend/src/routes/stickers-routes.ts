// Sticker routes — CRUD for packs and stickers, file upload
// Ported from reference implementation (reference implementation-Resonant)

import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import {
  createSticker,
  createStickerPack,
  deleteSticker,
  deleteStickerPack,
  getAllStickersWithPacks,
  getSticker,
  getStickerPack,
  listStickerPacks,
  listStickers,
  updateSticker,
  updateStickerPack,
} from '../services/stickers.js';
import {
  deleteStickerFile,
  deleteStickerPackFiles,
  parseStickerAliases,
  sanitizeStickerFilename,
  writeStickerFile,
} from '../services/sticker-admin.js';

export function createStickerRoutes(): Router {
  const router = Router();

  const stickerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'image/png' || file.mimetype === 'image/webp') {
        cb(null, true);
      } else {
        cb(new Error('Only PNG and WebP files are allowed'));
      }
    },
  });

  // --- Sticker Packs ---

  router.get('/sticker-packs', (_req, res) => {
    try {
      res.json({ packs: listStickerPacks() });
    } catch (error) {
      console.error('Error listing sticker packs:', error);
      res.status(500).json({ error: 'Failed to list sticker packs' });
    }
  });

  router.post('/sticker-packs', (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const pack = createStickerPack({
        id: crypto.randomUUID(),
        name,
        description: description || undefined,
        createdAt: new Date().toISOString(),
      });
      res.json({ pack });
    } catch (error) {
      console.error('Error creating sticker pack:', error);
      res.status(500).json({ error: 'Failed to create sticker pack' });
    }
  });

  router.put('/sticker-packs/:id', (req, res) => {
    try {
      const { name, description, userOnly } = req.body;
      const existing = getStickerPack(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Sticker pack not found' });
        return;
      }
      updateStickerPack(req.params.id, { name, description, userOnly });
      res.json({ pack: getStickerPack(req.params.id) });
    } catch (error) {
      console.error('Error updating sticker pack:', error);
      res.status(500).json({ error: 'Failed to update sticker pack' });
    }
  });

  router.delete('/sticker-packs/:id', (req, res) => {
    try {
      const existing = getStickerPack(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Sticker pack not found' });
        return;
      }
      const stickers = listStickers(req.params.id);
      for (const s of stickers) deleteSticker(s.id);
      deleteStickerPack(req.params.id);
      deleteStickerPackFiles(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting sticker pack:', error);
      res.status(500).json({ error: 'Failed to delete sticker pack' });
    }
  });

  // --- Individual Stickers ---

  router.get('/stickers', (req, res) => {
    try {
      const packId = typeof req.query.packId === 'string' ? req.query.packId : undefined;
      res.json({ stickers: listStickers(packId) });
    } catch (error) {
      console.error('Error listing stickers:', error);
      res.status(500).json({ error: 'Failed to list stickers' });
    }
  });

  router.get('/stickers/packs-with-stickers', (_req, res) => {
    try {
      res.json(getAllStickersWithPacks());
    } catch (error) {
      console.error('Error fetching stickers with packs:', error);
      res.status(500).json({ error: 'Failed to fetch stickers with packs' });
    }
  });

  router.post('/stickers', stickerUpload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }
      const { packId, name, aliases } = req.body;
      if (!packId || typeof packId !== 'string') {
        res.status(400).json({ error: 'packId is required' });
        return;
      }
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const pack = getStickerPack(packId);
      if (!pack) {
        res.status(404).json({ error: 'Sticker pack not found' });
        return;
      }
      const stickerId = crypto.randomUUID();
      const filename = sanitizeStickerFilename(`${stickerId}-${name}`, req.file.mimetype);
      writeStickerFile(packId, filename, req.file.buffer);
      const sticker = createSticker({
        id: stickerId,
        packId,
        name,
        filename,
        aliases: parseStickerAliases(aliases),
        createdAt: new Date().toISOString(),
      });
      res.json({ sticker });
    } catch (error) {
      console.error('Error uploading sticker:', error);
      const message = error instanceof Error ? error.message : 'Failed to upload sticker';
      res.status(400).json({ error: message });
    }
  });

  router.put('/stickers/:id', (req, res) => {
    try {
      const existing = getSticker(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Sticker not found' });
        return;
      }
      const { name, aliases } = req.body;
      const updates: { name?: string; aliases?: string[] } = {};
      if (name !== undefined) updates.name = name;
      if (aliases !== undefined) {
        updates.aliases = typeof aliases === 'string'
          ? aliases.split(',').map((a: string) => a.trim()).filter(Boolean)
          : aliases;
      }
      const result = updateSticker(req.params.id, updates);
      if (!result.ok) {
        res.status(409).json({
          error: result.reason,
          detail: `A sticker named "${result.name}" already exists in pack ${result.pack_id}`,
          existing_id: result.existing_id,
        });
        return;
      }
      res.json({ sticker: getSticker(req.params.id) });
    } catch (error) {
      console.error('Error updating sticker:', error);
      res.status(500).json({ error: 'Failed to update sticker' });
    }
  });

  router.delete('/stickers/:id', (req, res) => {
    try {
      const existing = getSticker(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Sticker not found' });
        return;
      }
      deleteStickerFile(existing.pack_id, existing.filename);
      deleteSticker(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting sticker:', error);
      res.status(500).json({ error: 'Failed to delete sticker' });
    }
  });

  return router;
}
