import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Static registration check: `sc schedule status|enable|disable|reschedule`
// operates on the orchestrator task map, which is seeded from DEFAULT_TASKS —
// so asserting on DEFAULT_TASKS verifies the new wake types are reachable
// from the schedule surface without touching a live DB or starting the
// orchestrator. Bootstrap shape mirrors digest.test.ts (RESONANT_HOME stub
// before import, because the orchestrator's import chain reads config paths).
const tmpRoot = mkdtempSync(join(tmpdir(), 'orchestrator-tasks-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const orchestratorMod = await import('./orchestrator.js');
const { DEFAULT_TASKS, getDefaultWakePrompts } = orchestratorMod;

describe('weekly maintenance wake registration', () => {
  it('registers the daily memory diet at 04:15 as an unconditional routine', () => {
    const task = DEFAULT_TASKS.find((candidate) => candidate.wakeType === 'memory_diet');
    assert.ok(task);
    assert.equal(task.cronExpr, '15 4 * * *');
    assert.equal(task.category, 'routine');
    assert.equal(task.conditional, undefined);
  });

  it('registers open_threads_janitor weekly (Sunday evening, routine, unconditional)', () => {
    const task = DEFAULT_TASKS.find(t => t.wakeType === 'open_threads_janitor');
    assert.ok(task, 'open_threads_janitor missing from DEFAULT_TASKS');
    assert.equal(task.cronExpr, '0 20 * * 0');
    assert.equal(task.category, 'routine');
    assert.ok(!task.conditional, 'janitor must fire regardless of user presence');
    assert.ok(!task.freshSession, 'janitor runs in the existing session');
  });

  it('registers weekly_digest_prep weekly (Sunday 21:30, routine, unconditional)', () => {
    const task = DEFAULT_TASKS.find(t => t.wakeType === 'weekly_digest_prep');
    assert.ok(task, 'weekly_digest_prep missing from DEFAULT_TASKS');
    assert.equal(task.cronExpr, '30 21 * * 0');
    assert.equal(task.category, 'routine');
    assert.ok(!task.conditional);
    assert.ok(!task.freshSession);
  });

  it('ships default prompts for both wakes with the file outputs and the core-memory hard rule', () => {
    const prompts = getDefaultWakePrompts('TestUser');

    const janitor = prompts['open_threads_janitor'];
    assert.ok(janitor, 'open_threads_janitor default prompt missing');
    assert.match(janitor, /shared\/open-threads\.md/);
    assert.match(janitor, /data\/janitor\/open-threads-diff-YYYY-MM-DD\.md/);
    assert.match(janitor, /30\+ days/);
    assert.match(janitor, /NEVER append this wake's output to core-memory blocks/);

    const digest = prompts['weekly_digest_prep'];
    assert.ok(digest, 'weekly_digest_prep default prompt missing');
    assert.match(digest, /data\/digests\/digest-YYYY-Www\.md/);
    assert.match(digest, /cc_task/);
    assert.match(digest, /NEVER append this wake's output to core-memory blocks/);
  });
});
