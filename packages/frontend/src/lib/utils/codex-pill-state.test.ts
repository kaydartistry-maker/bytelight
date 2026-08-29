// Tests for the Codex auth pill state derivation. 6B-C Slice 3B+.
//
// Three test groups:
//   1. Precedence ladder — each of the 5 states is reachable, and
//      higher-precedence states beat lower-precedence ones.
//   2. Countdown rendering — null guard + days/hours/minutes shaping.
//   3. Boundary mechanical guard — assert no pill label/sub contains
//      selection/picker/choose-model phrasing in ANY state. This is the
//      grep-level honesty test the operator specified: connection language only,
//      never selection language. Slice 4 (and beyond) cannot inherit a
//      lie through this card without failing this test first.
//
// Run with:
//   npx tsx --test packages/frontend/src/lib/utils/codex-pill-state.test.ts

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCodexPillState,
  ENUMERATE_PILL_VIEWS_FOR_TEST,
  type CodexPillInputs,
} from './codex-pill-state.js';

const FIXED_NOW = 1_730_000_000_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

function inputs(overrides: Partial<CodexPillInputs> = {}): CodexPillInputs {
  return {
    loggedIn: false,
    expiresAt: null,
    refreshable: false,
    loginSessionStatus: 'idle',
    ...overrides,
  };
}

// ─── Precedence ladder ────────────────────────────────────────────────────

describe('computeCodexPillState — login_in_progress (absolute precedence)', () => {
  test('plain disconnected + awaiting_browser → login_in_progress', () => {
    const v = computeCodexPillState(
      inputs({ loginSessionStatus: 'awaiting_browser' }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'login_in_progress');
    assert.equal(v.tone, 'yellow');
    assert.equal(v.label, 'Login in progress');
    assert.equal(v.sub, null);
  });

  test('logged-in + awaiting_browser → still login_in_progress (precedence wins)', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW + DAY_MS,
        refreshable: true,
        loginSessionStatus: 'awaiting_browser',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'login_in_progress',
      'awaiting_browser must beat connected — re-auth flow in progress');
  });

  test('logged-in + expired + refreshable + awaiting_browser → still login_in_progress', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW - DAY_MS,
        refreshable: true,
        loginSessionStatus: 'awaiting_browser',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'login_in_progress');
  });
});

describe('computeCodexPillState — connected', () => {
  test('logged-in + future expiry → connected, green, with countdown', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW + 6 * DAY_MS,
        refreshable: true,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'connected');
    assert.equal(v.tone, 'green');
    assert.equal(v.label, 'Connected');
    assert.equal(v.sub, 'token in 6 days');
  });

  test('logged-in + expiresAt null → connected, no countdown (null guard)', () => {
    // Defensive edge case: loggedIn=true while expiresAt is null is unusual
    // (writeCredentials always sets expires) but the helper must never
    // render "token in NaN days". This case falls through to may_refresh
    // or needs_reauth depending on `refreshable`, NOT to connected — but
    // we assert here that the null guard means connected branch can never
    // produce a NaN sub.
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: null,
        refreshable: false,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.notEqual(v.state, 'connected',
      'expiresAt null is NOT connected — needs explicit future-timestamp check');
    if (v.sub != null) {
      assert.ok(!v.sub.includes('NaN'), `sub must never contain NaN, got "${v.sub}"`);
    }
  });

  test('logged-in + expiresAt exactly equal to now → NOT connected (strict > check)', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW,
        refreshable: true,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.notEqual(v.state, 'connected',
      'expiresAt === now is not strictly > now; treat as expired');
    assert.equal(v.state, 'may_refresh');
  });
});

describe('computeCodexPillState — may_refresh', () => {
  test('logged-in + expired + refreshable → may_refresh, yellow', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW - 5 * MINUTE_MS,
        refreshable: true,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'may_refresh');
    assert.equal(v.tone, 'yellow');
    assert.equal(v.label, 'Session may refresh on use');
    assert.equal(v.sub, null,
      'may_refresh does not render a countdown — refresh window is implementation detail');
  });
});

describe('computeCodexPillState — needs_reauth', () => {
  test('logged-in + expired + NOT refreshable → needs_reauth, red', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW - DAY_MS,
        refreshable: false,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'needs_reauth');
    assert.equal(v.tone, 'red');
    assert.equal(v.label, 'Reconnect to continue');
    assert.equal(v.sub, null);
  });

  test('logged-in + expiresAt null + NOT refreshable → needs_reauth', () => {
    const v = computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: null,
        refreshable: false,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    );
    assert.equal(v.state, 'needs_reauth');
  });
});

describe('computeCodexPillState — not_connected', () => {
  for (const status of ['idle', 'complete', 'failed', 'cancelled'] as const) {
    test(`!loggedIn + loginSessionStatus=${status} → not_connected, neutral`, () => {
      const v = computeCodexPillState(
        inputs({ loginSessionStatus: status }),
        FIXED_NOW,
      );
      assert.equal(v.state, 'not_connected');
      assert.equal(v.tone, 'neutral');
      assert.equal(v.label, 'Not connected');
      assert.equal(v.sub, null);
    });
  }
});

// ─── Countdown shaping ────────────────────────────────────────────────────

describe('computeCodexPillState — countdown shaping (connected sub)', () => {
  function sub(deltaMs: number): string | null {
    return computeCodexPillState(
      inputs({
        loggedIn: true,
        expiresAt: FIXED_NOW + deltaMs,
        refreshable: true,
        loginSessionStatus: 'complete',
      }),
      FIXED_NOW,
    ).sub;
  }

  test('≥ 2 days → "token in N days"', () => {
    assert.equal(sub(2 * DAY_MS), 'token in 2 days');
    assert.equal(sub(6 * DAY_MS), 'token in 6 days');
    assert.equal(sub(30 * DAY_MS), 'token in 30 days');
  });

  test('< 2 days but ≥ 2 hours → "token in N hours"', () => {
    assert.equal(sub(36 * HOUR_MS), 'token in 36 hours');
    assert.equal(sub(2 * HOUR_MS), 'token in 2 hours');
  });

  test('< 2 hours → "token in N min", clamped at minimum 1', () => {
    assert.equal(sub(90 * MINUTE_MS), 'token in 90 min');
    assert.equal(sub(MINUTE_MS), 'token in 1 min');
    assert.equal(sub(30_000), 'token in 1 min',
      'sub-minute deltas clamp to 1 min — never "token in 0 min"');
  });

  test('countdown never contains "NaN"', () => {
    for (const delta of [-DAY_MS, 0, 1, MINUTE_MS, HOUR_MS, DAY_MS, 365 * DAY_MS]) {
      const s = sub(delta);
      if (s != null) {
        assert.ok(!s.includes('NaN'), `delta=${delta} produced "${s}"`);
      }
    }
  });
});

// ─── Boundary mechanical guard ────────────────────────────────────────────

describe('computeCodexPillState — connection language only (Slice 3B+ boundary guard)', () => {
  // Phrases that imply model SELECTION rather than session CONNECTION.
  // The Codex card lives on the Providers tab; selection happens in
  // Preferences (Slice 4) and the chat picker (Slice 5+). Permanent
  // grep-level test so a future edit cannot quietly blur the boundary.
  const SELECTION_PHRASES = [
    'select', 'selectable', 'selected',
    'picker',
    'choose model', 'choose models', 'choose a model',
    'pick a model', 'pick model',
    'model picker',
    'available models',
    'unlocked',          // implies post-connection model gating, which
                         // is a selection concern, not a connection one
    'enabled for use',
    'ready to use',      // ambiguous — could mean session OR selection
  ];

  test('no pill label contains selection-language phrases', () => {
    const views = ENUMERATE_PILL_VIEWS_FOR_TEST(FIXED_NOW);
    for (const view of views) {
      const haystack = view.label.toLowerCase();
      for (const phrase of SELECTION_PHRASES) {
        assert.ok(
          !haystack.includes(phrase.toLowerCase()),
          `pill label for state="${view.state}" contains selection phrase "${phrase}": "${view.label}"`,
        );
      }
    }
  });

  test('no pill sub contains selection-language phrases', () => {
    const views = ENUMERATE_PILL_VIEWS_FOR_TEST(FIXED_NOW);
    for (const view of views) {
      if (view.sub == null) continue;
      const haystack = view.sub.toLowerCase();
      for (const phrase of SELECTION_PHRASES) {
        assert.ok(
          !haystack.includes(phrase.toLowerCase()),
          `pill sub for state="${view.state}" contains selection phrase "${phrase}": "${view.sub}"`,
        );
      }
    }
  });

  test('enumeration covers all 5 states exactly once', () => {
    const views = ENUMERATE_PILL_VIEWS_FOR_TEST(FIXED_NOW);
    const states = views.map((v) => v.state).sort();
    assert.deepEqual(states, [
      'connected',
      'login_in_progress',
      'may_refresh',
      'needs_reauth',
      'not_connected',
    ]);
  });
});
