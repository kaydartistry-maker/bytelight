// Adapted for byte-light under Apache 2.0 (generic multi-actor).
// Starred messages — favorites the operator and the companions can flag for later.
// Mounted in api.ts AFTER auth middleware.
import { Router } from 'express';
import crypto from 'crypto';
import {
  addStar,
  removeStar,
  getStarsForMessage,
  listStarred,
  countStarredByActor,
  type StarredBy,
} from '../services/db.js';
import { registry } from '../services/registry.js';

const router = Router();

// Human default actor. `starred_by` is otherwise an arbitrary actor slug
// ('user', 'companion-a', 'companion-b', 'companion-c', or any future companion) — no cage.
const DEFAULT_ACTOR: StarredBy = 'user';

function parseActor(raw: unknown): StarredBy {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : DEFAULT_ACTOR;
}

// List starred messages — optionally filtered by actor (?starred_by=all for everyone).
router.get('/starred', (req, res) => {
  try {
    const filterRaw = (req.query.starred_by as string | undefined) ?? DEFAULT_ACTOR;
    const starredBy: StarredBy | 'all' = filterRaw === 'all' ? 'all' : parseActor(filterRaw);
    const limit = Math.min(parseInt((req.query.limit as string) || '200', 10) || 200, 500);
    const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);
    const items = listStarred({ starredBy, limit, offset });
    const counts = countStarredByActor();
    res.json({ items, counts });
  } catch (error) {
    console.error('List starred error:', error);
    res.status(500).json({ error: 'Failed to list starred messages' });
  }
});

// Stars on a single message (used to know who has starred a bubble).
router.get('/messages/:id/stars', (req, res) => {
  try {
    const stars = getStarsForMessage(req.params.id);
    res.json({ stars });
  } catch (error) {
    console.error('Get message stars error:', error);
    res.status(500).json({ error: 'Failed to fetch stars' });
  }
});

// Add a star. Body: { starred_by?, note? }. Defaults starred_by = 'user'.
router.post('/messages/:id/star', (req, res) => {
  try {
    const messageId = req.params.id;
    const starredBy = parseActor(req.body?.starred_by);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;
    const now = new Date().toISOString();
    const row = addStar({
      id: crypto.randomUUID(),
      messageId,
      starredBy,
      starredAt: now,
      note,
    });
    if (row) {
      registry.broadcast({
        type: 'message_starred',
        messageId,
        starredBy,
        starredAt: row.starred_at,
        note: row.note,
      });
    }
    res.json({ star: row });
  } catch (error) {
    console.error('Add star error:', error);
    res.status(500).json({ error: 'Failed to star message' });
  }
});

// Remove a star. Body: { starred_by? }. Defaults starred_by = 'user'.
router.delete('/messages/:id/star', (req, res) => {
  try {
    const messageId = req.params.id;
    const starredBy = parseActor(req.body?.starred_by);
    const removed = removeStar(messageId, starredBy);
    if (removed) {
      registry.broadcast({ type: 'message_unstarred', messageId, starredBy });
    }
    res.json({ removed });
  } catch (error) {
    console.error('Remove star error:', error);
    res.status(500).json({ error: 'Failed to unstar message' });
  }
});

export default router;
