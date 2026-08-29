import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseClaudeUsage,
  parseCodexRateLimits,
  parseCodexTokenCountLine,
} from './subscription-usage.js';

test('parses a real-shaped Claude usage payload', () => {
  const usage = parseClaudeUsage({
    five_hour: { utilization: 56, resets_at: '2026-07-22T10:49:59.535823+00:00' },
    seven_day: { utilization: 12, resets_at: '2026-07-28T11:59:59.535850+00:00' },
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', percent: 56 },
      { kind: 'weekly_all', percent: 12 },
      {
        kind: 'weekly_scoped',
        percent: 19,
        resets_at: '2026-07-28T11:59:59.536201+00:00',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  }, 'max');
  assert.equal(usage.fiveHourPercent, 56);
  assert.equal(usage.weeklyPercent, 12);
  assert.equal(usage.modelWeeklyLabel, 'Fable');
  assert.deepEqual(usage.limits.map((limit) => limit.label), [
    '5-hour window',
    'weekly · all models',
    'weekly · Fable',
  ]);
});

test('extra usage detail and spend pass through', () => {
  const usage = parseClaudeUsage({
    extra_usage: { is_enabled: true, utilization: 34, monthly_limit: 50, used_credits: 17 },
    spend: {
      used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
      percent: 25,
      enabled: true,
      can_purchase_credits: true,
    },
  }, 'max');
  assert.equal(usage.extraUsage.usedCredits, 17);
  assert.equal(usage.spend?.usedFormatted, '$12.34');
  assert.equal(usage.spend?.limitFormatted, '$50.00');
});

test('parses transcript and live camelCase Codex rate-limit shapes', () => {
  const transcript = parseCodexTokenCountLine({
    timestamp: '2026-07-22T06:45:10.410Z',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 42, window_minutes: 300, resets_at: 1785259844 },
        secondary: { used_percent: 88, window_minutes: 10080, resets_at: 1785259900 },
        plan_type: 'plus',
      },
    },
  });
  assert.equal(transcript?.usedPercent, 42);
  assert.equal(transcript?.secondary?.usedPercent, 88);

  const live = parseCodexRateLimits({
    primary: { usedPercent: 56, windowMinutes: 300, resetsAt: '2026-07-23T12:00:00Z' },
    planType: 'plus',
  });
  assert.equal(live?.usedPercent, 56);
  assert.equal(live?.resetsAt, '2026-07-23T12:00:00.000Z');
});

test('invalid Codex stamps return null', () => {
  assert.equal(parseCodexTokenCountLine({ payload: { type: 'agent_message' } }), null);
  assert.equal(parseCodexRateLimits({ primary: { usedPercent: 'high' } }), null);
});
