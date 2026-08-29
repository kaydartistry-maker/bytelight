import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCodexSkillInvocation } from './codex-skill-invocation.js';

const skillDirNames = new Set(['review-code', 'write-docs']);

describe('rewriteCodexSkillInvocation', () => {
  test('rewrites a matching stateless Codex skill and preserves args', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/review-code src/app.ts --fix', 'codex', skillDirNames),
      '$review-code src/app.ts --fix',
    );
  });

  test('rewrites a matching warm-daemon Codex skill without args', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/write-docs', 'codex-cli', skillDirNames),
      '$write-docs',
    );
  });

  test('leaves a non-skill slash command untouched', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/compact', 'codex', skillDirNames),
      '/compact',
    );
  });

  test('does not treat a longer slash token as a skill match', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/review-codebase is our project', 'codex', skillDirNames),
      '/review-codebase is our project',
    );
  });

  test('leaves mid-message slashes untouched', () => {
    assert.equal(
      rewriteCodexSkillInvocation('Please run /review-code src/app.ts', 'codex', skillDirNames),
      'Please run /review-code src/app.ts',
    );
  });

  test('leaves matching skills untouched on a non-Codex lane', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/review-code src/app.ts', 'claude-sdk', skillDirNames),
      '/review-code src/app.ts',
    );
  });

  test('matches skill directory names case-sensitively', () => {
    assert.equal(
      rewriteCodexSkillInvocation('/Review-Code src/app.ts', 'codex', skillDirNames),
      '/Review-Code src/app.ts',
    );
  });
});
