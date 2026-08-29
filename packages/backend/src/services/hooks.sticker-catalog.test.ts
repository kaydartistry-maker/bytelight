// Tests for buildStickerCatalogBlock — the pure helper extracted from
// buildOrientationContext. Verifies the every-turn catalog injection
// builds the expected text block without any DB or hook context.
//
// Run with: npx tsx --test packages/backend/src/services/hooks.sticker-catalog.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStickerCatalogBlock } from './hooks.js';

type Sticker = { name: string; pack_name: string; user_only: boolean };

test('returns null on empty input', () => {
  assert.equal(buildStickerCatalogBlock([]), null);
});

test('returns null when all stickers are user_only', () => {
  const input: Sticker[] = [
    { name: 'mug', pack_name: 'User', user_only: true },
    { name: 'wink', pack_name: 'User', user_only: true },
  ];
  assert.equal(buildStickerCatalogBlock(input), null);
});

test('filters out user_only stickers in mixed input', () => {
  const input: Sticker[] = [
    { name: 'user_only_one', pack_name: 'User', user_only: true },
    { name: 'visible_one', pack_name: 'Companion A', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out, 'should return non-null');
  assert.match(out!, /:companion_a_visible_one:/);
  assert.doesNotMatch(out!, /user_only_one/);
});

test('groups by pack and preserves insertion order within pack', () => {
  const input: Sticker[] = [
    { name: 'first', pack_name: 'Companion A', user_only: false },
    { name: 'second', pack_name: 'Companion A', user_only: false },
    { name: 'alpha', pack_name: 'Companion B', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out);
  // Companion A pack appears with both refs in order
  assert.match(out!, /Companion A: :companion_a_first:, :companion_a_second:/);
  // Companion B pack appears on its own line
  assert.match(out!, /Companion B: :companion_b_alpha:/);
});

test('pack name with spaces becomes lowercased underscored slug', () => {
  const input: Sticker[] = [
    { name: 'hello', pack_name: 'User x Companion B', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out);
  assert.match(out!, /:user_x_companion_b_hello:/);
  // Pack display name is preserved as-is (only the slug is mangled)
  assert.match(out!, /User x Companion B:/);
});

test('output starts with header and Available now lines', () => {
  const input: Sticker[] = [
    { name: 'x', pack_name: 'Companion A', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out);
  const lines = out!.split('\n');
  assert.ok(lines[0].startsWith('STICKERS'), 'first line is STICKERS header');
  assert.ok(lines[1].includes('at most one sticker per message'), 'second line is default rate-limit instruction');
  assert.equal(lines[2], '  Available now:');
  assert.equal(lines[3], '    Companion A: :companion_a_x:');
});

test('includes default rate-limit instruction and preserves syntax hint', () => {
  const input: Sticker[] = [
    { name: 'wink', pack_name: 'Companion A', user_only: false },
    { name: 'grin', pack_name: 'Companion A', user_only: false },
    { name: 'smirk', pack_name: 'Companion B', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out, 'should return non-null');
  // New rate-limit instruction is present
  assert.ok(
    out!.includes('Default: at most one sticker per message.'),
    'output should cap default sticker output at one per message',
  );
  // Regression guard: the existing syntax instruction is still present
  assert.ok(
    out!.includes(':packname_stickername:'),
    'output should still include the :packname_stickername: syntax hint',
  );
});

test('multi-pack refs use proper :packslug_stickername: shape', () => {
  const input: Sticker[] = [
    { name: 'one', pack_name: 'User', user_only: false },
    { name: 'two', pack_name: 'KxT', user_only: false },
    { name: 'three', pack_name: 'Companion A', user_only: false },
    { name: 'four', pack_name: 'Companion B', user_only: false },
  ];
  const out = buildStickerCatalogBlock(input);
  assert.ok(out);
  assert.match(out!, /:user_one:/);
  assert.match(out!, /:kxt_two:/);
  assert.match(out!, /:companion_a_three:/);
  assert.match(out!, /:companion_b_four:/);
});
