import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { codexDaemonStartupAction, materializeCodexSkillsDoor } from './codex-supervisor.js';

const tempDirs: string[] = [];

function makeAgentCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-skills-door-'));
  tempDirs.push(cwd);
  mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
  return cwd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex daemon lifecycle', () => {
  test('reuses a healthy socket after backend ownership state is lost', () => {
    assert.equal(codexDaemonStartupAction(true), 'reuse');
  });

  test('starts the daemon only when no socket exists', () => {
    assert.equal(codexDaemonStartupAction(false), 'start');
  });
});

describe('materializeCodexSkillsDoor', () => {
  test('creates a symlink to the project skills directory', () => {
    const cwd = makeAgentCwd();

    materializeCodexSkillsDoor(cwd);

    const door = join(cwd, '.agents', 'skills');
    assert.equal(lstatSync(door).isSymbolicLink(), true);
    assert.equal(readlinkSync(door), join(cwd, '.claude', 'skills'));
  });

  test('leaves an already-correct symlink unchanged', () => {
    const cwd = makeAgentCwd();
    const door = join(cwd, '.agents', 'skills');
    mkdirSync(join(cwd, '.agents'), { recursive: true });
    symlinkSync('../.claude/skills', door, 'dir');

    materializeCodexSkillsDoor(cwd);

    assert.equal(readlinkSync(door), '../.claude/skills');
  });

  test('warns and preserves an existing real directory', () => {
    const cwd = makeAgentCwd();
    const door = join(cwd, '.agents', 'skills');
    mkdirSync(door, { recursive: true });
    writeFileSync(join(door, 'keep.txt'), 'user data');
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);

    try {
      materializeCodexSkillsDoor(cwd);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(lstatSync(door).isDirectory(), true);
    assert.equal(readFileSync(join(door, 'keep.txt'), 'utf8'), 'user data');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Leaving it unchanged/);
  });
});
