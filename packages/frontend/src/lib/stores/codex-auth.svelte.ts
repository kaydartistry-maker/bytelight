// Codex OAuth state — login flow orchestration + status snapshot.
//
// The login flow is long-running (the user has to open a browser, complete
// OAuth, and the local callback server has to fire). The frontend kicks it
// off via POST /login, opens the returned URL, then polls GET /status until
// the session resolves. This module owns that polling.
//
// State is single-instance: only one Codex login at a time.
//
// Ported from reference implementation/main stores/codex-auth.svelte.ts at SHA 8d93d5f.
// byte-light adaptation: `$lib/utils/api` import path → `../utils/api.js`
// to match byte-light's existing relative-import convention
// (see auth.svelte.ts, settings.svelte.ts). No behavior changes.
//
// NO TOKENS STORED CLIENT-SIDE: this store only mirrors the safe snapshot
// returned by GET /api/auth/codex/status — the snapshot has `loggedIn`,
// `expiresAt`, `refreshable`, and `loginSession` metadata only.
// Access/refresh tokens never leave the backend's data/codex-auth.json file.
// 6B-C Slice 3B-0 hardening: the credentials file path is no longer in
// the snapshot either — it has no client-side use and shouldn't appear
// in any UI state.
// Manual auth codes are cleared after submit (see clearManualCode in card).

import { apiFetch } from '../utils/api.js';

export type CodexLoginStatus =
  | 'idle'
  | 'awaiting_browser'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface CodexLoginSnapshot {
  status: CodexLoginStatus;
  url?: string;
  error?: string;
  startedAt?: number;
}

export interface CodexAuthSnapshot {
  loggedIn: boolean;
  expiresAt: number | null;
  refreshable: boolean;
  loginSession: CodexLoginSnapshot;
}

let snapshot = $state<CodexAuthSnapshot | null>(null);
let loading = $state(false);
let lastError = $state<string | null>(null);

// Polling handle — kept module-level so multiple components mounting the
// card don't each spawn an independent poller.
let pollHandle: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 2000;

function stopPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

function startPolling(): void {
  if (pollHandle) return;
  pollHandle = setInterval(async () => {
    await refreshCodexStatus({ silent: true });
    // Once login leaves the awaiting_browser state, stop polling. The card
    // will show the final state until the user takes another action.
    if (snapshot?.loginSession.status !== 'awaiting_browser') {
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

export async function refreshCodexStatus(opts: { silent?: boolean } = {}): Promise<void> {
  if (!opts.silent) loading = true;
  try {
    const res = await apiFetch('/api/auth/codex/status');
    if (res.ok) {
      snapshot = await res.json();
      lastError = null;
      // If we land on a still-polling state, ensure the poller is running
      // (handles the case where a page reload finds an in-flight session).
      if (snapshot?.loginSession.status === 'awaiting_browser') {
        startPolling();
      }
    } else {
      lastError = `Status fetch failed (${res.status})`;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    if (!opts.silent) loading = false;
  }
}

/**
 * Start a Codex OAuth login. Returns the OAuth URL on success — caller
 * should open it in a new tab (window.open or <a target="_blank">).
 * After this resolves, polling begins automatically and the snapshot will
 * update as the OAuth completes.
 */
export async function startCodexLogin(): Promise<{ url: string | null; status: CodexLoginStatus }> {
  loading = true;
  lastError = null;
  try {
    const res = await apiFetch('/api/auth/codex/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      lastError = body?.error ?? `Login request failed (${res.status})`;
      return { url: null, status: 'failed' };
    }
    const body = (await res.json()) as { url: string | null; status: CodexLoginStatus };
    // Refresh full snapshot so the card sees `loginSession.status` etc.
    await refreshCodexStatus({ silent: true });
    if (body.status === 'awaiting_browser') {
      startPolling();
    }
    return body;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return { url: null, status: 'failed' };
  } finally {
    loading = false;
  }
}

export async function submitCodexManualCode(code: string): Promise<boolean> {
  loading = true;
  lastError = null;
  try {
    const res = await apiFetch('/api/auth/codex/manual-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      lastError = body?.error ?? `Manual-code submit failed (${res.status})`;
      return false;
    }
    // Don't stop polling — the OAuth flow will now race the manual code
    // against the browser callback and complete shortly.
    await refreshCodexStatus({ silent: true });
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    loading = false;
  }
}

export async function logoutCodex(): Promise<boolean> {
  loading = true;
  lastError = null;
  try {
    const res = await apiFetch('/api/auth/codex/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      lastError = `Logout failed (${res.status})`;
      return false;
    }
    stopPolling();
    await refreshCodexStatus({ silent: true });
    return true;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    loading = false;
  }
}

export async function cancelCodexLogin(): Promise<void> {
  try {
    await apiFetch('/api/auth/codex/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    /* best effort */
  }
  stopPolling();
  await refreshCodexStatus({ silent: true });
}

// Getters for $derived consumers
export function getCodexAuthSnapshot(): CodexAuthSnapshot | null {
  return snapshot;
}
export function isCodexAuthLoading(): boolean {
  return loading;
}
export function getCodexAuthError(): string | null {
  return lastError;
}
