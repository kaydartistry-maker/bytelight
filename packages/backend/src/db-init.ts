import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { loadConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config to get DB path
const config = loadConfig();
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

console.log(`Initializing database at: ${DB_PATH}`);

// Open database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Read and execute migration
const migrationPath = join(__dirname, '../migrations/001_init.sql');
console.log(`Reading migration from: ${migrationPath}`);

const migrationSQL = readFileSync(migrationPath, 'utf-8');
db.exec(migrationSQL);

console.log('Migration executed successfully');

// Insert default config
const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
stmt.run('dnd_start', '23:00');
stmt.run('dnd_end', '07:00');

console.log('Default config inserted');

// Verify tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('\nCreated tables:');
tables.forEach((table: any) => {
  console.log(`  - ${table.name}`);
});

db.close();
console.log('\nDatabase initialization complete');
