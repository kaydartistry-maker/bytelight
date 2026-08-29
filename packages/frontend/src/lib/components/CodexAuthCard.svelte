<script lang="ts">
  // Codex (ChatGPT) OAuth connection card. Slice 4 of 6B-A — auth surface
  // only. Shows connection state + lets the operator connect / paste manual code /
  // cancel / log out. Does NOT make Codex selectable in the model picker
  // (that lands in 6B-C after 6B-B's runtime arrives).
  //
  // Ported from reference implementation/main lib/components/CodexAuthCard.svelte
  // (SHA 8d93d5f). Script + markup ported; CSS rewritten using byte-light's
  // card / action-btn / status-dot vocabulary (matches ProvidersPanel).
  //
  // No tokens / no auth codes are persisted client-side. The manual-code
  // input is cleared after a successful submit AND after cancel.

  import { onMount } from 'svelte';
  import {
    refreshCodexStatus,
    startCodexLogin,
    submitCodexManualCode,
    logoutCodex,
    cancelCodexLogin,
    getCodexAuthSnapshot,
    isCodexAuthLoading,
    getCodexAuthError,
  } from '../stores/codex-auth.svelte.js';
  import {
    computeCodexPillState,
    type CodexPillView,
  } from '../utils/codex-pill-state.js';

  let snapshot = $derived(getCodexAuthSnapshot());
  let loading = $derived(isCodexAuthLoading());
  let storeError = $derived(getCodexAuthError());

  let manualCode = $state('');
  let manualCodeBusy = $state(false);
  let confirmingLogout = $state(false);
  let localError = $state<string | null>(null);

  let loginStatus = $derived(snapshot?.loginSession.status ?? 'idle');
  let loginUrl = $derived(snapshot?.loginSession.url);
  let loginError = $derived(snapshot?.loginSession.error);
  let loggedIn = $derived(!!snapshot?.loggedIn);

  // Pill view — 6B-C Slice 3B+ five-state precedence ladder. The
  // previous derivation collapsed expired-but-refreshable and
  // expired-no-refresh into one yellow branch. The pure helper splits
  // them using fields already in the snapshot (no new API endpoint
  // coupling) and enforces a mechanical boundary: pill labels carry
  // connection-language only, never selection-language. See
  // lib/utils/codex-pill-state.ts and the boundary test in
  // codex-pill-state.test.ts.
  let pillView: CodexPillView = $derived(
    computeCodexPillState({
      loggedIn,
      expiresAt: snapshot?.expiresAt ?? null,
      refreshable: !!snapshot?.refreshable,
      loginSessionStatus: loginStatus,
    }),
  );

  onMount(async () => {
    await refreshCodexStatus();
  });

  async function handleConnect() {
    localError = null;
    // Open the popup SYNCHRONOUSLY before the await — popup blockers in
    // Firefox/Safari (and stricter Chrome settings) correlate window.open
    // with the click event. Any await before window.open loses the
    // user-gesture context and the call returns null. We open a blank
    // placeholder now, then navigate it to the OAuth URL once the backend
    // returns it.
    const popup = window.open('about:blank', '_blank');
    const result = await startCodexLogin();
    if (result.url) {
      if (popup && !popup.closed) {
        popup.location.href = result.url;
      } else {
        // Popup was blocked even with the synchronous-open trick.
        window.open(result.url, '_blank');
        localError = 'Browser blocked the popup. Use "Reopen login URL" below if no tab opened.';
      }
    } else {
      popup?.close();
      localError = 'OAuth flow failed to produce a URL. See errors below.';
    }
  }

  async function handleManualCodeSubmit() {
    if (!manualCode.trim()) return;
    manualCodeBusy = true;
    localError = null;
    const ok = await submitCodexManualCode(manualCode.trim());
    manualCodeBusy = false;
    // Clear the input regardless of outcome so a failed code doesn't
    // persist on screen (no client-side auth-code retention).
    manualCode = '';
    if (!ok) {
      localError = storeError ?? 'Manual code submission failed.';
    }
  }

  async function handleLogoutConfirm() {
    confirmingLogout = false;
    await logoutCodex();
  }

  async function handleCancel() {
    // Clear manual-code input on cancel too — the operator's redaction rule.
    manualCode = '';
    await cancelCodexLogin();
  }

  function handleReopenUrl() {
    if (loginUrl) {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');
    }
  }
</script>

<section class="codex-card" class:tone-green={pillView.tone === 'green'} class:tone-yellow={pillView.tone === 'yellow'} class:tone-red={pillView.tone === 'red'}>
  <div class="card-head">
    <div class="icon-tile codex-icon">G</div>
    <div class="head-body">
      <div class="head-title-row">
        <span class="card-name">ChatGPT / Codex</span>
        <span class="auth-chip oauth">oauth</span>
      </div>
      <div class="card-status-row">
        <span class="status-dot tone-{pillView.tone}"></span>
        <span class="status-text">{pillView.label}</span>
        {#if pillView.sub}
          <span class="status-meta">· {pillView.sub}</span>
        {/if}
      </div>
    </div>
  </div>

  {#if loggedIn}
    <p class="hint">
      Connected through ChatGPT OAuth. Codex runtime is live.
    </p>
    <div class="actions">
      <button type="button" class="action-btn ghost" onclick={() => refreshCodexStatus()} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <button type="button" class="action-btn danger" onclick={() => (confirmingLogout = true)} disabled={loading}>
        Log out
      </button>
    </div>
  {:else if loginStatus === 'awaiting_browser'}
    <p class="hint">
      Waiting for ChatGPT authorization. Complete sign-in in the browser tab
      that opened — or paste the authorization code below if the redirect
      didn't make it back.
    </p>
    {#if loginUrl}
      <p class="hint subtle">
        Browser didn't open?
        <button type="button" class="link" onclick={handleReopenUrl}>Reopen login URL</button>
      </p>
    {/if}

    <div class="inline-form">
      <label class="form-field" for="codex-manual-code">
        <span class="form-label">Manual code (fallback)</span>
        <input
          id="codex-manual-code"
          type="text"
          bind:value={manualCode}
          placeholder="Paste code from the OAuth redirect URL"
          autocomplete="off"
          spellcheck="false"
          disabled={manualCodeBusy}
        />
      </label>
      <div class="form-actions">
        <button type="button" class="action-btn ghost" onclick={handleCancel}>Cancel</button>
        <button
          type="button"
          class="action-btn primary"
          onclick={handleManualCodeSubmit}
          disabled={!manualCode.trim() || manualCodeBusy}
        >
          {manualCodeBusy ? 'Submitting…' : 'Submit code'}
        </button>
      </div>
    </div>
  {:else}
    <p class="hint">
      Connect your ChatGPT session to enable the Codex runtime path.
    </p>
    <div class="actions">
      <button type="button" class="action-btn primary" onclick={handleConnect} disabled={loading}>
        {loading ? 'Starting…' : 'Connect ChatGPT / Codex'}
      </button>
      <button type="button" class="action-btn ghost" onclick={() => refreshCodexStatus()} disabled={loading}>
        Refresh
      </button>
    </div>
    {#if loginStatus === 'failed' && loginError}
      <p class="error-line">Last login failed: {loginError}</p>
    {/if}
    {#if loginStatus === 'cancelled'}
      <p class="hint subtle">Previous login was cancelled.</p>
    {/if}
  {/if}

  {#if pillView.state === 'needs_reauth'}
    <p class="error-line">Codex authorization expired. Reconnect to continue.</p>
  {/if}
  {#if localError}
    <p class="error-line">{localError}</p>
  {/if}
  {#if storeError}
    <p class="error-line">{storeError}</p>
  {/if}
</section>

{#if confirmingLogout}
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="codex-logout-title">
    <div class="modal">
      <h4 id="codex-logout-title">Log out of Codex?</h4>
      <p class="hint">
        This deletes the stored OAuth credentials. Reconnect ChatGPT to
        restore Codex access.
      </p>
      <div class="form-actions">
        <button type="button" class="action-btn ghost" onclick={() => (confirmingLogout = false)}>Cancel</button>
        <button type="button" class="action-btn danger" onclick={handleLogoutConfirm}>Log out</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .codex-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 1.125rem;
    border: 1px solid rgba(155, 114, 207, 0.22);
    border-radius: 0.625rem;
    background: linear-gradient(180deg, rgba(20, 14, 32, 0.55) 0%, rgba(10, 8, 20, 0.65) 100%);
    backdrop-filter: blur(6px);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 8px 24px rgba(0, 0, 0, 0.18);
  }
  .codex-card.tone-green { border-color: rgba(56, 218, 144, 0.4); }
  .codex-card.tone-yellow { border-color: rgba(238, 196, 88, 0.4); }
  .codex-card.tone-red { border-color: rgba(238, 88, 112, 0.4); }

  .card-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .icon-tile {
    flex: 0 0 auto;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 0.5rem;
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 1.125rem;
  }
  .codex-icon {
    background: linear-gradient(135deg, #10a37f, #16c79a);
    color: #fff;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  }
  .head-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }
  .head-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .card-name {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .auth-chip {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.125rem 0.4rem;
    border-radius: 9999px;
    border: 1px solid rgba(155, 114, 207, 0.4);
    color: rgba(220, 200, 255, 0.85);
    background: rgba(155, 114, 207, 0.1);
  }
  .auth-chip.oauth { border-color: rgba(80, 200, 220, 0.4); color: rgba(200, 240, 255, 0.85); background: rgba(80, 200, 220, 0.08); }

  .card-status-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    color: rgba(220, 210, 240, 0.7);
    flex-wrap: wrap;
  }
  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: rgba(180, 180, 200, 0.55);
  }
  .status-dot.tone-green { background: #38da90; box-shadow: 0 0 8px rgba(56, 218, 144, 0.55); }
  .status-dot.tone-yellow { background: #eec458; box-shadow: 0 0 8px rgba(238, 196, 88, 0.55); }
  .status-dot.tone-red { background: #ee5870; box-shadow: 0 0 8px rgba(238, 88, 112, 0.55); }
  .status-text {
    font-weight: 600;
    color: rgba(245, 240, 255, 0.92);
  }
  .status-meta { color: rgba(190, 180, 215, 0.6); }

  .hint {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(210, 200, 230, 0.75);
  }
  .hint.subtle { color: rgba(190, 180, 215, 0.55); }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: rgba(150, 220, 255, 0.9);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .link:hover { color: rgba(180, 240, 255, 1); }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .action-btn {
    padding: 0.45rem 0.85rem;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: 0.5rem;
    border: 1px solid rgba(155, 114, 207, 0.3);
    background: rgba(155, 114, 207, 0.08);
    color: rgba(235, 225, 255, 0.92);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
  }
  .action-btn:hover:not(:disabled) {
    background: rgba(155, 114, 207, 0.18);
    border-color: rgba(155, 114, 207, 0.5);
  }
  .action-btn:active:not(:disabled) { transform: translateY(1px); }
  .action-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .action-btn.primary {
    background: linear-gradient(135deg, rgba(155, 114, 207, 0.85), rgba(80, 200, 220, 0.7));
    border-color: rgba(180, 140, 230, 0.6);
    color: #fff;
  }
  .action-btn.primary:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(170, 130, 220, 0.95), rgba(100, 220, 240, 0.85));
  }
  .action-btn.ghost {
    background: transparent;
    border-color: rgba(155, 114, 207, 0.25);
  }
  .action-btn.ghost:hover:not(:disabled) {
    background: rgba(155, 114, 207, 0.1);
  }
  .action-btn.danger {
    border-color: rgba(238, 88, 112, 0.45);
    color: rgba(255, 200, 210, 0.92);
    background: rgba(238, 88, 112, 0.08);
  }
  .action-btn.danger:hover:not(:disabled) {
    background: rgba(238, 88, 112, 0.18);
    border-color: rgba(238, 88, 112, 0.7);
  }

  .inline-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem;
    border: 1px dashed rgba(155, 114, 207, 0.25);
    border-radius: 0.5rem;
    background: rgba(10, 8, 20, 0.4);
  }
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .form-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: rgba(190, 180, 215, 0.7);
  }
  input[type='text'] {
    width: 100%;
    padding: 0.5rem 0.65rem;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(155, 114, 207, 0.25);
    border-radius: 0.4rem;
    color: rgba(245, 240, 255, 0.95);
    font-size: 0.875rem;
    font-family: inherit;
  }
  input[type='text']:focus {
    outline: none;
    border-color: rgba(80, 200, 220, 0.5);
    box-shadow: 0 0 0 2px rgba(80, 200, 220, 0.18);
  }
  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .error-line {
    margin: 0;
    font-size: 0.8125rem;
    color: rgba(255, 200, 210, 0.92);
    padding: 0.4rem 0.6rem;
    background: rgba(238, 88, 112, 0.08);
    border-left: 2px solid rgba(238, 88, 112, 0.55);
    border-radius: 0.25rem;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
    display: grid;
    place-items: center;
    z-index: 1000;
    padding: 1rem;
  }
  .modal {
    width: min(28rem, 100%);
    padding: 1.25rem 1.5rem;
    border-radius: 0.75rem;
    background: linear-gradient(180deg, rgba(28, 20, 42, 0.95) 0%, rgba(16, 12, 28, 0.97) 100%);
    border: 1px solid rgba(155, 114, 207, 0.35);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .modal h4 {
    margin: 0;
    font-size: 1rem;
    color: rgba(245, 240, 255, 0.95);
  }

  @media (max-width: 480px) {
    .actions, .form-actions {
      flex-direction: column;
    }
    .action-btn {
      width: 100%;
    }
  }
</style>
