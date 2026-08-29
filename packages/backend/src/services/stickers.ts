// Sticker database operations
// Ported from reference implementation (reference implementation-Resonant)

import type { Sticker, StickerPack } from '@bytelight/shared';
import { getDb } from './db.js';

function parseAliases(row: any): string[] {
  if (!row?.aliases) return [];
  try { return JSON.parse(row.aliases); } catch { return []; }
}

function rowToSticker(row: any, packId?: string): Sticker {
  const pid = row.pack_id || packId;
  return {
    ...row,
    aliases: parseAliases(row),
    url: `/stickers/${pid}/${row.filename}`,
  } as Sticker;
}

function rowToPack(row: any): StickerPack {
  return { ...row, user_only: !!row.user_only } as StickerPack;
}

export function createStickerPack(params: {
  id: string;
  name: string;
  description?: string;
  entityId?: string;
  userOnly?: boolean;
  createdAt: string;
}): StickerPack {
  const stmt = getDb().prepare(
    'INSERT INTO sticker_packs (id, name, description, entity_id, user_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    params.id,
    params.name,
    params.description || '',
    params.entityId || null,
    params.userOnly ? 1 : 0,
    params.createdAt,
    params.createdAt
  );
  return getStickerPack(params.id)!;
}

export function getStickerPack(id: string): StickerPack | null {
  const row = getDb().prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id);
  return row ? rowToPack(row) : null;
}

export function listStickerPacks(): StickerPack[] {
  return (getDb().prepare('SELECT * FROM sticker_packs ORDER BY name ASC').all() as any[]).map(rowToPack);
}

export function updateStickerPack(
  id: string,
  fields: { name?: string; description?: string; userOnly?: boolean }
): void {
  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) {
    updates.push('name = ?');
    params.push(fields.name);
  }
  if (fields.description !== undefined) {
    updates.push('description = ?');
    params.push(fields.description);
  }
  if (fields.userOnly !== undefined) {
    updates.push('user_only = ?');
    params.push(fields.userOnly ? 1 : 0);
  }
  if (updates.length === 0) return;
  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb()
    .prepare(`UPDATE sticker_packs SET ${updates.join(', ')} WHERE id = ?`)
    .run(...params);
}

export function deleteStickerPack(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM stickers WHERE pack_id = ?').run(id);
    db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(id);
  })();
}

export function createSticker(params: {
  id: string;
  packId: string;
  name: string;
  filename: string;
  aliases?: string[];
  createdAt: string;
}): Sticker {
  const stmt = getDb().prepare(
    'INSERT INTO stickers (id, pack_id, name, filename, aliases, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const maxOrder = getDb()
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM stickers WHERE pack_id = ?')
    .get(params.packId) as { next: number };
  stmt.run(
    params.id,
    params.packId,
    params.name,
    params.filename,
    JSON.stringify(params.aliases || []),
    maxOrder.next,
    params.createdAt
  );
  return getSticker(params.id)!;
}

export function getSticker(id: string): Sticker | null {
  const row = getDb().prepare('SELECT * FROM stickers WHERE id = ?').get(id);
  return row ? rowToSticker(row) : null;
}

export function getStickerByRef(packName: string, stickerName: string): Sticker | null {
  const row = getDb()
    .prepare(
      `SELECT s.* FROM stickers s
       JOIN sticker_packs p ON p.id = s.pack_id
       WHERE LOWER(p.name) = LOWER(?) AND LOWER(s.name) = LOWER(?)`
    )
    .get(packName, stickerName);
  return row ? rowToSticker(row) : null;
}

export function listStickers(packId?: string): Sticker[] {
  if (packId) {
    const rows = getDb()
      .prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY sort_order ASC')
      .all(packId) as any[];
    return rows.map((row) => rowToSticker(row));
  }
  const rows = getDb()
    .prepare('SELECT * FROM stickers ORDER BY pack_id, sort_order ASC')
    .all() as any[];
  return rows.map((row) => rowToSticker(row));
}

export type UpdateStickerResult =
  | { ok: true }
  | { ok: false; reason: 'name_conflict'; existing_id: string | null; pack_id: string; name: string };

export function updateSticker(
  id: string,
  fields: { name?: string; aliases?: string[]; sort_order?: number }
): UpdateStickerResult {
  // Pre-check: if updating name, look for an existing sticker in the
  // same pack with that name. This is non-atomic with the UPDATE below,
  // so the catch block handles SQLITE_CONSTRAINT_UNIQUE as a backstop
  // for concurrent writes — deterministic 409 in both paths.
  let ownPackId: string | null = null;
  if (fields.name !== undefined) {
    const own = getDb()
      .prepare('SELECT pack_id FROM stickers WHERE id = ?')
      .get(id) as { pack_id: string } | undefined;
    if (own) {
      ownPackId = own.pack_id;
      const conflict = getDb()
        .prepare('SELECT id FROM stickers WHERE pack_id = ? AND name = ? AND id != ?')
        .get(own.pack_id, fields.name, id) as { id: string } | undefined;
      if (conflict) {
        console.warn(
          `[stickers] update skipped — name "${fields.name}" already taken in pack ${own.pack_id} by sticker ${conflict.id}`,
        );
        return { ok: false, reason: 'name_conflict', existing_id: conflict.id, pack_id: own.pack_id, name: fields.name };
      }
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); params.push(fields.name); }
  if (fields.aliases !== undefined) { updates.push('aliases = ?'); params.push(JSON.stringify(fields.aliases)); }
  if (fields.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(fields.sort_order); }
  if (updates.length === 0) return { ok: true };
  params.push(id);

  try {
    getDb().prepare(`UPDATE stickers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return { ok: true };
  } catch (err) {
    // Race window: a concurrent transaction inserted or renamed
    // between our pre-check SELECT and this UPDATE. Same 409 shape
    // as the pre-check hit, but existing_id is null because we
    // didn't get to identify the conflicting row before the race.
    // better-sqlite3 surfaces SQLite's extended error code as .code.
    const e = err as { code?: string };
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' && fields.name !== undefined) {
      console.warn(
        `[stickers] update skipped — UNIQUE conflict during UPDATE for sticker ${id} (race with concurrent write)`,
      );
      return {
        ok: false,
        reason: 'name_conflict',
        existing_id: null,
        pack_id: ownPackId ?? '',
        name: fields.name,
      };
    }
    throw err;
  }
}

export function deleteSticker(id: string): string | null {
  const sticker = getSticker(id);
  if (!sticker) return null;
  getDb().prepare('DELETE FROM stickers WHERE id = ?').run(id);
  return sticker.filename;
}

export function getAllStickersWithPacks(): Array<Sticker & { pack_name: string; user_only: boolean }> {
  const rows = getDb()
    .prepare(
      `SELECT s.*, p.name as pack_name, p.user_only FROM stickers s
       JOIN sticker_packs p ON p.id = s.pack_id
       ORDER BY p.name ASC, s.sort_order ASC`
    )
    .all() as any[];
  return rows.map((row) => ({
    ...rowToSticker(row),
    pack_name: row.pack_name,
    user_only: !!row.user_only,
  }));
}
