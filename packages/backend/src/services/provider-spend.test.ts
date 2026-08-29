import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { initDb, recordUsageEvent } from './db.js';
import { getProviderSpend } from './provider-spend.js';

test('aggregates existing usage_events costs by provider and range', () => {
  initDb(':memory:');
  recordUsageEvent({
    id: randomUUID(),
    createdAt: '2026-07-05T00:00:00.000Z',
    mode: 'interactive',
    model: 'grok-4',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 1.25,
    provider: 'xai',
  });
  recordUsageEvent({
    id: randomUUID(),
    createdAt: '2026-07-06T00:00:00.000Z',
    mode: 'interactive',
    model: 'other',
    inputTokens: 999,
    outputTokens: 999,
    costUsd: 9,
    provider: 'groq',
  });
  const meter = getProviderSpend('xai', {
    since: '2026-07-01T00:00:00.000Z',
    until: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(meter.requestCount, 1);
  assert.equal(meter.inputTokens, 100);
  assert.equal(meter.outputTokens, 20);
  assert.equal(meter.costUsd, 1.25);
  assert.equal(meter.spend.usedFormatted, '$1.25');
  assert.equal(meter.spend.limitFormatted, null);
});
