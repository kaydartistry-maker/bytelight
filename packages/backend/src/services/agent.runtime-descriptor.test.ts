/**
 * Slice 3b cut-1 pin: every Claude model name the app can produce TODAY
 * resolves to runtime 'claude-sdk' with sidecar filing provider
 * 'anthropic' — byte-identical to the pre-3b constant-stub descriptor.
 *
 * Live model-string inventory (enumerated from the actual sources):
 *   - 'claude-sonnet-4-6' — getConfiguredModel fallback (agent.ts),
 *     config.ts DEFAULTS agent.model + agent.model_autonomous, and the
 *     ModelSelector.svelte fallback.
 *   - MODEL_VARIANTS[*].modelApiId — what ModelSelector.svelte /
 *     PreferencesPanel.svelte write to DB config 'agent.model' /
 *     'agent.model_autonomous' (includes dated ids and the '[1m]'
 *     1M-context suffix form). Pulled from @bytelight/shared at runtime
 *     so the pin self-updates when the variant catalog changes.
 *
 * If any of these ever resolves off the claude lane, sidecar filing
 * (and therefore resume continuity for every live thread) breaks —
 * this test failing is a release blocker, not a flake.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RESONANT_HOME = mkdtempSync(join(tmpdir(), 'descriptor-test-'));

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VARIANTS } from '@bytelight/shared';
import { resolveRuntimeDescriptor } from './agent.js';
import { sidecarProviderFor } from './agent/sidecar.js';

const LIVE_CLAUDE_MODEL_NAMES: string[] = [
  'claude-sonnet-4-6', // defaults (agent.ts fallback, config DEFAULTS x2)
  ...MODEL_VARIANTS.map((v) => v.modelApiId), // settings-UI writable values
];

describe('resolveRuntimeDescriptor — Slice 3b claude-lane pin', () => {
  for (const model of LIVE_CLAUDE_MODEL_NAMES) {
    test(`'${model}' resolves to claude-sdk / files under anthropic`, () => {
      const d = resolveRuntimeDescriptor(model);
      assert.equal(d.runtimeId, 'claude-sdk');
      assert.equal(d.modelRef.runtime, 'claude-sdk');
      assert.equal(d.modelRef.provider, 'claude');
      // Sidecar filing key — both agent.ts call sites route provider
      // through sidecarProviderFor. Must equal the pre-3b stub's
      // constant 'anthropic' so on-disk rows keep resuming.
      assert.equal(sidecarProviderFor(d.provider), 'anthropic');
      // modelRef.model keeps the provider-native id verbatim (the
      // sidecar's model_ref column is keyed on the bare string passed
      // at the call site, which is the same `model` input).
      assert.equal(d.modelRef.model, model);
    });
  }

  test('bare unknown Claude-style ids fall back to the claude lane', () => {
    // normalizeModelRef's legacy fallback: bare id, no manifest hit →
    // claude/<id>, runtime claude-sdk. Guards future dated ids the
    // variant catalog adds before the manifest learns them.
    const d = resolveRuntimeDescriptor('claude-opus-4-8-20270101');
    assert.equal(d.runtimeId, 'claude-sdk');
    assert.equal(sidecarProviderFor(d.provider), 'anthropic');
  });
});
