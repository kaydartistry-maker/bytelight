import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { automaticEmbeddingsEnabled, shouldAutomaticallyEmbed } from './embedding-policy.js';

describe('automatic embedding policy', () => {
  it('defaults off when the setting is absent', () => {
    assert.equal(automaticEmbeddingsEnabled(null), false);
    assert.equal(automaticEmbeddingsEnabled(undefined), false);
  });

  it('requires the exact explicit opt-in value', () => {
    assert.equal(automaticEmbeddingsEnabled('true'), true);
    assert.equal(automaticEmbeddingsEnabled('false'), false);
    assert.equal(automaticEmbeddingsEnabled('TRUE'), false);
    assert.equal(automaticEmbeddingsEnabled('1'), false);
  });

  it('keeps routine text messages out of ONNX unless opted in', () => {
    const message = { role: 'user' as const, contentType: 'text' as const, contentLength: 40 };
    assert.equal(shouldAutomaticallyEmbed({ ...message, setting: null }), false);
    assert.equal(shouldAutomaticallyEmbed({ ...message, setting: 'false' }), false);
    assert.equal(shouldAutomaticallyEmbed({ ...message, setting: 'true' }), true);
  });

  it('never indexes system, attachment, or tiny messages automatically', () => {
    assert.equal(shouldAutomaticallyEmbed({ setting: 'true', role: 'system', contentType: 'text', contentLength: 40 }), false);
    assert.equal(shouldAutomaticallyEmbed({ setting: 'true', role: 'user', contentType: 'image', contentLength: 40 }), false);
    assert.equal(shouldAutomaticallyEmbed({ setting: 'true', role: 'user', contentType: 'text', contentLength: 10 }), false);
  });
});
