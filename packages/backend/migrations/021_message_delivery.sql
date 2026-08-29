-- Durable idempotency key for client-originated messages. The column is added
-- defensively by initDb because SQLite has no ADD COLUMN IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(client_id) WHERE client_id IS NOT NULL;
