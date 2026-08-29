import { Router } from 'express';
import crypto from 'crypto';
import {
  createCanvas,
  getCanvas,
  listCanvases,
  getAllCanvasTags,
  updateCanvasContent,
  updateCanvasTitle,
  updateCanvasTags,
  deleteCanvas,
} from '../services/db.js';
import { registry } from '../services/registry.js';

export function createCanvasRoutes(): Router {
  const router = Router();

  // List canvases (with optional search + tag filter)
  router.get('/canvases', (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      const canvases = listCanvases({ search, tag });
      res.json({ canvases });
    } catch (error) {
      console.error('Error listing canvases:', error);
      res.status(500).json({ error: 'Failed to list canvases' });
    }
  });

  // Get all unique tags across canvases (for autocomplete)
  router.get('/canvases/tags', (req, res) => {
    try {
      const tags = getAllCanvasTags();
      res.json({ tags });
    } catch (error) {
      console.error('Error fetching canvas tags:', error);
      res.status(500).json({ error: 'Failed to fetch tags' });
    }
  });

  // Create canvas
  router.post('/canvases', (req, res) => {
    try {
      const { title, contentType, language, threadId } = req.body;
      if (!title || typeof title !== 'string') {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      const now = new Date().toISOString();
      const canvas = createCanvas({
        id: crypto.randomUUID(),
        threadId: threadId || undefined,
        title,
        contentType: contentType || 'markdown',
        language: language || undefined,
        createdBy: 'user',
        createdAt: now,
      });

      registry.broadcast({ type: 'canvas_created', canvas });
      res.json({ canvas });
    } catch (error) {
      console.error('Error creating canvas:', error);
      res.status(500).json({ error: 'Failed to create canvas' });
    }
  });

  // Get canvas
  router.get('/canvases/:id', (req, res) => {
    try {
      const canvas = getCanvas(req.params.id);
      if (!canvas) {
        res.status(404).json({ error: 'Canvas not found' });
        return;
      }
      res.json({ canvas });
    } catch (error) {
      console.error('Error fetching canvas:', error);
      res.status(500).json({ error: 'Failed to fetch canvas' });
    }
  });

  // Update canvas
  router.patch('/canvases/:id', (req, res) => {
    try {
      const canvas = getCanvas(req.params.id);
      if (!canvas) {
        res.status(404).json({ error: 'Canvas not found' });
        return;
      }

      const now = new Date().toISOString();
      const { title, content, tags } = req.body;

      if (title !== undefined) {
        updateCanvasTitle(req.params.id, title, now);
      }
      if (content !== undefined) {
        updateCanvasContent(req.params.id, content, now);
        registry.broadcast({ type: 'canvas_updated', canvasId: req.params.id, content, updatedAt: now });
      }
      if (Array.isArray(tags)) {
        updateCanvasTags(req.params.id, tags, now);
        registry.broadcast({ type: 'canvas_updated', canvasId: req.params.id, content: canvas.content, updatedAt: now, tags });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating canvas:', error);
      res.status(500).json({ error: 'Failed to update canvas' });
    }
  });

  // Delete canvas
  router.delete('/canvases/:id', (req, res) => {
    try {
      const deleted = deleteCanvas(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Canvas not found' });
        return;
      }
      registry.broadcast({ type: 'canvas_deleted', canvasId: req.params.id });
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting canvas:', error);
      res.status(500).json({ error: 'Failed to delete canvas' });
    }
  });

  return router;
}
