import { apiFetch } from '../utils/api.js';

let authenticated = $state(false);
let checking = $state(true);
let authRequired = $state(true);

// Backoff state for retry when server is unreachable
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

function getRetryDelay(): number {
  return RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
}

function clearRetry(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
}

export async function checkAuth(): Promise<boolean> {
  checking = true;

  try {
    const response = await apiFetch('/api/auth/check');

    if (response.ok) {
      const data = await response.json();
      authenticated = data.authenticated === true;
      if (data.auth_required === false) authRequired = false;
    } else {
      authenticated = false;
    }
    // Success — reset retry state
    retryAttempt = 0;
    clearRetry();
    return authenticated;
  } catch (err) {
    // Network error (server unreachable) — schedule retry with backoff
    authenticated = false;
    retryAttempt++;
    const delay = getRetryDelay();
    clearRetry();
    retryTimeout = setTimeout(() => {
      checkAuth();
    }, delay);
    return false;
  } finally {
    checking = false;
  }
}

export async function login(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (response.ok) {
      authenticated = true;
      retryAttempt = 0;
      clearRetry();
      return { success: true };
    } else {
      const data = await response.json();
      return { success: false, error: data.error || 'Login failed' };
    }
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'Network error' };
  }
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error('Logout error:', err);
  } finally {
    authenticated = false;
  }
}

export function stopAuthPolling(): void {
  clearRetry();
  retryAttempt = 0;
}

export function isAuthenticated() {
  return authenticated;
}

export function isChecking() {
  return checking;
}

export function isAuthRequired() {
  return authRequired;
}
