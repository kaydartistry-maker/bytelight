import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWakeWithProof,
  WAKE_PROOF_RETRY_PROMPT,
  wakeMessagesHaveToolEvidence,
} from './orchestrator.js';

describe('wake proof-of-life contract', () => {
  test('accepts a visible first response without retrying', async () => {
    const prompts: Array<string | undefined> = [];
    const result = await runWakeWithProof('morning_prep', async (prompt) => {
      prompts.push(prompt);
      return 'Proof of life.';
    });

    assert.deepEqual(result, { response: 'Proof of life.', attempts: 1 });
    assert.deepEqual(prompts, [undefined]);
  });

  test('zero characters forces exactly one explicit closing retry', async () => {
    const prompts: Array<string | undefined> = [];
    const result = await runWakeWithProof('deep_work', async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '   ' : 'Built the thing; receipt saved.';
    });

    assert.deepEqual(result, { response: 'Built the thing; receipt saved.', attempts: 2 });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1], WAKE_PROOF_RETRY_PROMPT('deep_work'));
    assert.match(prompts[1]!, /FAILED wake/);
    assert.match(prompts[1]!, /MUST produce a visible final response/);
  });

  test('a second zero-character result remains failed for the caller to receipt', async () => {
    const result = await runWakeWithProof('handoff', async () => '');
    assert.deepEqual(result, { response: '', attempts: 2 });
  });

  test('detects durable tool evidence in persisted wake segments', () => {
    assert.equal(wakeMessagesHaveToolEvidence([
      { metadata: { segments: [{ type: 'thinking' }, { type: 'tool', toolName: 'commandExecution' }] } },
    ]), true);
    assert.equal(wakeMessagesHaveToolEvidence([
      { metadata: { segments: [{ type: 'thinking' }, { type: 'text' }] } },
      { metadata: null },
    ]), false);
  });
});
