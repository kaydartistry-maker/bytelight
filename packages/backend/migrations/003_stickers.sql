-- Sticker packs and stickers
-- Ported from reference implementation (reference implementation-Resonant)

CREATE TABLE IF NOT EXISTS sticker_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  entity_id TEXT DEFAULT NULL,
  user_only INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (pack_id) REFERENCES sticker_packs(id),
  UNIQUE(pack_id, name)
);
