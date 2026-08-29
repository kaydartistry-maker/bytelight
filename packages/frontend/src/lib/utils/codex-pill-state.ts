// Codex auth pill state — pure derivation from the safe auth snapshot.
//
// 6B-C Slice 3B+. The CodexAuthCard previously folded "expired" into a
// single yellow "needs reauth" label, conflating the case where the auth
// service can refresh on next use with the case where the user must
// manually reconnect. Slice 2's reason enum split those cleanly on the
// backend; this helper gives the UI the same fidelity using only the
// fields the existing /api/auth/codex/status snapshot already carries.
//
// Five states, single precedence ladder, no overlaps:
//
//   1. login_in_progress  — loginSession.status === 'awaiting_browser'
//                            (absolute precedence; covers re-auth flows
//                            even when a stale credentials file exists)
//   2. connected          — loggedIn && expiresAt > now
//                            (countdown rendered with null guard)
//   3. may_refresh        — loggedIn && expired && refreshable
//                            (auth service refreshes on next turn —
//                            verified in 6B-C Slice 2 hard gate)
//   4. needs_reauth       — loggedIn && expired && !refreshable
//                            (no refresh token; manual reconnect)
//   5. not_connected      — fallthrough (no credentials file)
//
// Labels use **session/connection language only** — never selection,
// picker, or model-choice language. That distinction belongs to
// Preferences (Slice 4) and the chat picker (Slice 5+); a connection
// surface must not imply selection state. Enforced by the boundary
// test in codex-pill-state.test.ts.

export type CodexLoginSessionStatus =
  | 'idle'
  | 'awaiting_browser'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type CodexPillState =
  | 'login_in_progress'
  | 'connected'
  | 'may_refresh'
  | 'needs_reauth'
  | 'not_connected';

export type CodexPillTone = 'green' | 'yellow' | 'red' | 'neutral';

export interface CodexPillView {
  state: CodexPillState;
  tone: CodexPillTone;
  label: string;
  /** Optional secondary line. `null` when no countdown applies or when
   *  the expiry timestamp is missing. The card renders this prefixed
   *  with "· " in the status meta slot. */
  sub: string | null;
}

export interface CodexPillInputs {
  loggedIn: boolean;
  expiresAt: number | null;
  refreshable: boolean;
  loginSessionStatus: CodexLoginSessionStatus;
}

/**
 * Compute the pill view from the safe auth snapshot fields. Pure: no
 * I/O, no DOM access, no timers — driven by the explicit `nowMs`
 * argument so tests can pin time without mocking Date.
 */
export function computeCodexPillState(
  inputs: CodexPillInputs,
  nowMs: number = Date.now(),
): CodexPillView {
  const { loggedIn, expiresAt, refreshable, loginSessionStatus } = inputs;

  // 1. login_in_progress — absolute precedence. A user mid-OAuth flow
  //    sees the pending state even if a stale credentials file is on
  //    disk; the new login will supersede it.
  if (loginSessionStatus === 'awaiting_browser') {
    return {
      state: 'login_in_progress',
      tone: 'yellow',
      label: 'Login in progress',
      sub: null,
    };
  }

  // 2. connected — credentials file present AND access token still
  //    within expiry. Countdown is rendered only when expiresAt is a
  //    concrete number (null guard against the dumbest possible
  //    "token in NaN days" screenshot).
  if (loggedIn && expiresAt != null && expiresAt > nowMs) {
    return {
      state: 'connected',
      tone: 'green',
      label: 'Connected',
      sub: formatExpiresCountdown(expiresAt, nowMs),
    };
  }

  // 3. may_refresh — expired access token, but a refresh token is
  //    present. The auth service (`getCodexAccessToken` →
  //    `getCodexCredentials` → `refreshCredentials`) attempts a refresh
  //    on the next turn dispatch. Verified in Slice 2 hard refresh
  //    verification gate.
  if (loggedIn && refreshable) {
    return {
      state: 'may_refresh',
      tone: 'yellow',
      label: 'Session may refresh on use',
      sub: null,
    };
  }

  // 4. needs_reauth — credentials file present, expired, no refresh
  //    token. Manual reconnect required.
  if (loggedIn) {
    return {
      state: 'needs_reauth',
      tone: 'red',
      label: 'Reconnect to continue',
      sub: null,
    };
  }

  // 5. not_connected — fallthrough.
  return {
    state: 'not_connected',
    tone: 'neutral',
    label: 'Not connected',
    sub: null,
  };
}

/**
 * Format an expiry countdown for the connected pill's secondary line.
 * Never returns a string when expiresAt is null or already past — both
 * cases are handled by the caller's branch ordering, but the function
 * itself is defensive.
 */
function formatExpiresCountdown(expiresAt: number, nowMs: number): string | null {
  if (expiresAt == null) return null;
  const diffMs = expiresAt - nowMs;
  if (diffMs <= 0) return null;
  const days = Math.floor(diffMs / (24 * 3600_000));
  if (days >= 2) return `token in ${days} days`;
  const hours = Math.floor(diffMs / 3600_000);
  if (hours >= 2) return `token in ${hours} hours`;
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));
  return `token in ${minutes} min`;
}

/**
 * Enumerate every pill view the helper can produce, for boundary tests
 * that need to assert label/sub content across the full state space.
 * Test-only consumer; production code uses `computeCodexPillState`
 * directly.
 */
export function ENUMERATE_PILL_VIEWS_FOR_TEST(nowMs: number = 0): CodexPillView[] {
  return [
    computeCodexPillState(
      { loggedIn: false, expiresAt: null, refreshable: false, loginSessionStatus: 'awaiting_browser' },
      nowMs,
    ),
    computeCodexPillState(
      { loggedIn: true, expiresAt: nowMs + 60 * 60_000, refreshable: true, loginSessionStatus: 'complete' },
      nowMs,
    ),
    computeCodexPillState(
      { loggedIn: true, expiresAt: nowMs - 60_000, refreshable: true, loginSessionStatus: 'complete' },
      nowMs,
    ),
    computeCodexPillState(
      { loggedIn: true, expiresAt: nowMs - 60_000, refreshable: false, loginSessionStatus: 'complete' },
      nowMs,
    ),
    computeCodexPillState(
      { loggedIn: false, expiresAt: null, refreshable: false, loginSessionStatus: 'idle' },
      nowMs,
    ),
  ];
}
