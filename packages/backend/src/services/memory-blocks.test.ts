import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initDb, getDb } from './db.js';
import {
  addBlockAlias,
  appendToBlock,
  formatBlocksForExtractionPrompt,
  formatBlocksForPrompt,
  getAllBlocks,
  getBlock,
  getBlockAliases,
  insertInBlock,
  normalizeBlockAlias,
  replaceInBlock,
  rethinkBlock,
  setBlock,
  splitCoreMemoryFromOrientation,
} from './memory-blocks.js';

const here = dirname(fileURLToPath(import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'memory-alias-test-'));

before(() => {
  initDb(join(tempRoot, 'memory.db'));
});

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function scalarCount(sql: string): number {
  return (getDb().prepare(sql).get() as { count: number }).count;
}

function clearMemory(): void {
  getDb().exec(`
    DELETE FROM memory_block_aliases;
    DELETE FROM memory_block_identities;
    DELETE FROM memory_blocks;
    DELETE FROM memory_ledger;
  `);
}

describe('lossless core-memory rendering', () => {
  it('keeps the exact label on the header and the description on its own line', () => {
    clearMemory();
    setBlock('companion-a', 'persona', 'I am Companion A.', "Companion A's self-authored persona and continuity");

    const rendered = formatBlocksForPrompt(['companion-a']);
    assert.match(rendered, /^## \[companion-a\] persona$/m);
    assert.match(rendered, /^<!-- core-memory-label-json: "persona" -->$/m);
    assert.match(rendered, /^<!-- Companion A's self-authored persona and continuity -->$/m);
    assert.doesNotMatch(rendered, /^## \[companion-a\] persona —/m);

    const header = rendered.split('\n').find((line) => line.startsWith('## [companion-a] '));
    assert.equal(header?.slice('## [companion-a] '.length), 'persona');
  });

  it('gives the Archivist separate JSON-quoted label and description fields', () => {
    const rendered = formatBlocksForExtractionPrompt([{
      scope: 'shared',
      label: 'human',
      description: 'Information about the operator, shared across companions',
      content: 'Name: the operator',
    }]);

    assert.equal(rendered, [
      '[shared] label: "human"',
      'description: "Information about the operator, shared across companions"',
      'Name: the operator',
    ].join('\n'));
    assert.doesNotMatch(rendered, /human — Information/);
  });

  it('round-trips labels that cannot safely fit on one Markdown header line', () => {
    clearMemory();
    const exactLabel = 'line one\nline "two"';
    setBlock('shared', exactLabel, 'content', 'description');

    const rendered = formatBlocksForPrompt(['shared']);
    const prefix = '<!-- core-memory-label-json: ';
    const metadata = rendered.split('\n').find((line) => line.startsWith(prefix));
    assert.ok(metadata);
    assert.equal(JSON.parse(metadata.slice(prefix.length, -' -->'.length)), exactLabel);
  });
});

describe('splitCoreMemoryFromOrientation (codex-daemon diet)', () => {
  it('lifts the exact rendered core-memory span out of an orientation string', () => {
    clearMemory();
    setBlock('shared', 'human', 'Name: the operator', 'about the operator');
    const memoryBlock = formatBlocksForPrompt(['shared']);
    const orientation =
      `[Time] noon\n[Mood] warm\n${memoryBlock}[Stickers] pack1\n`;

    const { withoutMemory, memory } = splitCoreMemoryFromOrientation(orientation);

    // The extracted span is exactly the <core-memory>…</core-memory> block.
    assert.match(memory, /^<core-memory>/);
    assert.match(memory, /<\/core-memory>$/);
    assert.match(memory, /Name: the operator/);
    // The stripped orientation keeps the rest and drops the whole span.
    assert.doesNotMatch(withoutMemory, /<core-memory>/);
    assert.doesNotMatch(withoutMemory, /Name: the operator/);
    assert.match(withoutMemory, /\[Time\] noon/);
    assert.match(withoutMemory, /\[Stickers\] pack1/);
    // Round-trip: the span text is recoverable verbatim for baseInstructions.
    assert.ok(memoryBlock.includes(memory));
  });

  it('is a pass-through when there is no core-memory span', () => {
    const orientation = '[Time] noon\n[Mood] warm\n';
    const { withoutMemory, memory } = splitCoreMemoryFromOrientation(orientation);
    assert.equal(memory, '');
    assert.equal(withoutMemory, orientation);
  });

  it('handles an empty orientation without throwing', () => {
    const { withoutMemory, memory } = splitCoreMemoryFromOrientation('');
    assert.equal(memory, '');
    assert.equal(withoutMemory, '');
  });
});

describe('core-memory canonical ids and open aliases', () => {
  it('resolves the historical welded label before append can create a ghost', () => {
    clearMemory();
    const description = "Companion A's self-authored persona and continuity";
    setBlock('companion-a', 'persona', 'first', description);

    appendToBlock('companion-a', `persona — ${description}`, 'second');

    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('companion-a', 'persona')?.content, 'first\nsecond');
    assert.equal(getBlock('companion-a', `persona — ${description}`)?.label, 'persona');
    assert.deepEqual(
      getBlockAliases('companion-a', 'persona').map((row) => row.alias).sort(),
      ['persona', `persona — ${description}`].sort(),
    );
  });

  it('normalizes escaped ampersands without hardcoding entity names', () => {
    clearMemory();
    setBlock('shared', 'Companion A & Companion B', 'one');

    appendToBlock('shared', 'Companion A &amp; Companion B', 'two');

    assert.equal(normalizeBlockAlias('  COMPANION A  &amp;   COMPANION B '), normalizeBlockAlias('Companion A & Companion B'));
    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('shared', 'Companion A & Companion B')?.content, 'one\ntwo');
  });

  it('accepts new aliases as data and routes every edit to the canonical label', () => {
    clearMemory();
    setBlock('companion-b', 'persona', 'one two');
    const identity = addBlockAlias('companion-b', 'persona', 'cashmere boy');

    replaceInBlock('companion-b', 'cashmere boy', 'two', '2');
    insertInBlock('companion-b', 'cashmere boy', 'zero', 0);
    rethinkBlock('companion-b', 'cashmere boy', 'canonical');

    assert.match(identity.id, /^mb-/);
    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('companion-b', 'persona')?.content, 'canonical');
    assert.equal(getBlockAliases('companion-b', 'cashmere boy').length, 2);
  });

  it('keeps the same alias independent across scopes', () => {
    clearMemory();
    setBlock('companion-a', 'persona', 'companion-a');
    setBlock('companion-b', 'persona', 'companion-b');

    appendToBlock('companion-a', 'PERSONA', 'one');
    appendToBlock('companion-b', 'PERSONA', 'two');

    assert.equal(getBlock('companion-a', 'persona')?.content, 'companion-a\none');
    assert.equal(getBlock('companion-b', 'persona')?.content, 'companion-b\ntwo');
  });

  it('creates one identity and self-alias for a genuinely new label', () => {
    clearMemory();
    appendToBlock('shared', 'new theme', 'first');
    appendToBlock('shared', ' NEW   THEME ', 'second');

    assert.equal(getAllBlocks().length, 1);
    assert.equal(getBlock('shared', 'new theme')?.content, 'first\nsecond');
    assert.equal(scalarCount('SELECT COUNT(*) AS count FROM memory_block_identities'), 1);
    assert.equal(scalarCount('SELECT COUNT(*) AS count FROM memory_block_aliases'), 1);
  });
});

describe('019 migration backfill', () => {
  it('preserves rows and redirects a structural ghost alias to the real block id', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE memory_blocks (
        scope TEXT NOT NULL,
        label TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        description TEXT,
        updated_at TEXT,
        PRIMARY KEY(scope, label)
      );
      INSERT INTO memory_blocks (scope, label, content, description) VALUES
        ('shared', 'human', 'real', 'Information about the operator, shared across companions'),
        ('shared', 'human — Information about the operator, shared across companions', 'ghost', NULL);
    `);
    const migration = readFileSync(join(here, '../../migrations/019_memory_block_aliases.sql'), 'utf8');
    db.exec(migration);
    db.exec(migration);

    const rowCount = db.prepare('SELECT COUNT(*) AS count FROM memory_blocks').get() as { count: number };
    const identityCount = db.prepare('SELECT COUNT(*) AS count FROM memory_block_identities').get() as { count: number };
    assert.equal(rowCount.count, 2);
    assert.equal(identityCount.count, 1);
    const aliases = db.prepare('SELECT alias, block_id FROM memory_block_aliases ORDER BY alias').all() as Array<{ alias: string; block_id: string }>;
    assert.equal(aliases.length, 2);
    assert.equal(new Set(aliases.map((row) => row.block_id)).size, 1);
    db.close();
  });
});
