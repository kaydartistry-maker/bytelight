<!--
  KeysPanel.svelte — BYOK API-key manager for the NON-provider secrets.

  Talks to the /api/secrets backend (services/secrets.ts + routes/secrets.ts).
  Shows only the search / voice / platforms / other categories — model
  provider keys keep their home in the Providers tab, and the read-only
  Anthropic SDK slot is never surfaced here.

  Per slot:
    - masked draft input (type=password) → Save (PUT) when a draft is typed
    - Clear (DELETE) when a value is already stored
    - reveal (eye) toggle → GET /api/secrets/:name to peek the stored value
      on request only; re-masked on toggle-off. Values are never logged.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../utils/api.js';

  type Category = 'search' | 'voice' | 'platforms' | 'other' | 'providers';

  interface SecretStatus {
    name: string;
    label: string;
    category: Category;
    hint?: string;
    hasValue: boolean;
    readonly: boolean;
  }

  // Only these categories render here; `providers` (and any readonly slot)
  // are deliberately excluded — they live on the Providers tab.
  const CATEGORY_ORDER: Category[] = ['search', 'voice', 'platforms', 'other'];
  const CATEGORY_LABEL: Record<string, string> = {
    search: 'Search',
    voice: 'Voice',
    platforms: 'Platforms',
    other: 'Other',
  };

  let slots = $state<SecretStatus[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  // Per-slot working state, keyed by secret name.
  let drafts = $state<Record<string, string>>({});
  let revealed = $state<Record<string, string | undefined>>({});
  let busy = $state<Record<string, 'save' | 'clear' | 'reveal' | undefined>>({});
  let rowStatus = $state<Record<string, { ok: boolean; msg: string } | undefined>>({});

  let grouped = $derived(
    CATEGORY_ORDER
      .map((cat) => ({
        cat,
        label: CATEGORY_LABEL[cat],
        items: slots.filter((s) => s.category === cat && !s.readonly),
      }))
      .filter((g) => g.items.length > 0),
  );

  async function loadSlots() {
    loading = true;
    loadError = '';
    try {
      const res = await api.get('/api/secrets');
      if (!res.ok) {
        loadError = `Failed to load keys (${res.status})`;
        return;
      }
      const data = (await res.json()) as { secrets: SecretStatus[] };
      slots = Array.isArray(data.secrets) ? data.secrets : [];
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load keys';
    } finally {
      loading = false;
    }
  }

  function draftOf(name: string): string {
    return drafts[name] ?? '';
  }

  function setDraft(name: string, value: string) {
    drafts = { ...drafts, [name]: value };
  }

  async function save(name: string) {
    const value = draftOf(name).trim();
    if (!value) return;
    busy = { ...busy, [name]: 'save' };
    rowStatus = { ...rowStatus, [name]: undefined };
    try {
      const res = await api.put(`/api/secrets/${encodeURIComponent(name)}`, { value });
      if (res.ok) {
        setDraft(name, '');
        revealed = { ...revealed, [name]: undefined };
        rowStatus = { ...rowStatus, [name]: { ok: true, msg: 'Saved' } };
        await loadSlots();
      } else {
        const body = await res.json().catch(() => ({}) as { error?: string });
        rowStatus = { ...rowStatus, [name]: { ok: false, msg: body?.error || `Save failed (${res.status})` } };
      }
    } catch (err) {
      rowStatus = { ...rowStatus, [name]: { ok: false, msg: err instanceof Error ? err.message : 'Save failed' } };
    } finally {
      busy = { ...busy, [name]: undefined };
    }
  }

  async function clear(name: string) {
    busy = { ...busy, [name]: 'clear' };
    rowStatus = { ...rowStatus, [name]: undefined };
    try {
      const res = await api.delete(`/api/secrets/${encodeURIComponent(name)}`);
      if (res.ok) {
        setDraft(name, '');
        revealed = { ...revealed, [name]: undefined };
        rowStatus = { ...rowStatus, [name]: { ok: true, msg: 'Cleared' } };
        await loadSlots();
      } else {
        const body = await res.json().catch(() => ({}) as { error?: string });
        rowStatus = { ...rowStatus, [name]: { ok: false, msg: body?.error || `Clear failed (${res.status})` } };
      }
    } catch (err) {
      rowStatus = { ...rowStatus, [name]: { ok: false, msg: err instanceof Error ? err.message : 'Clear failed' } };
    } finally {
      busy = { ...busy, [name]: undefined };
    }
  }

  async function toggleReveal(name: string) {
    // Toggle off → re-mask (drop the fetched value from memory).
    if (revealed[name] !== undefined) {
      revealed = { ...revealed, [name]: undefined };
      return;
    }
    busy = { ...busy, [name]: 'reveal' };
    rowStatus = { ...rowStatus, [name]: undefined };
    try {
      const res = await api.get(`/api/secrets/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = (await res.json()) as { value?: string };
        revealed = { ...revealed, [name]: data.value ?? '' };
      } else if (res.status === 404) {
        rowStatus = { ...rowStatus, [name]: { ok: false, msg: 'not set' } };
      } else {
        rowStatus = { ...rowStatus, [name]: { ok: false, msg: `Reveal failed (${res.status})` } };
      }
    } catch (err) {
      rowStatus = { ...rowStatus, [name]: { ok: false, msg: err instanceof Error ? err.message : 'Reveal failed' } };
    } finally {
      busy = { ...busy, [name]: undefined };
    }
  }

  function onKeydown(e: KeyboardEvent, name: string) {
    if (e.key === 'Enter' && draftOf(name).trim() && !busy[name]) {
      e.preventDefault();
      save(name);
    }
  }

  onMount(loadSlots);
</script>

<div class="keys-panel">
  <header class="panel-header">
    <h2>API Keys</h2>
  </header>
  <p class="panel-desc">
    Bring-your-own-key store for search, voice, platform, and integration
    services. Keys are held in the app database and used by the server at
    call time. Model provider keys (OpenAI, xAI, Groq router, OpenRouter,
    HuggingFace, Ollama) are managed on the <strong>Providers</strong> tab.
  </p>

  {#if loading}
    <div class="state-msg">Loading keys…</div>
  {:else if loadError}
    <div class="state-msg error">
      {loadError}
      <button type="button" class="action-btn ghost" onclick={loadSlots}>Retry</button>
    </div>
  {:else if grouped.length === 0}
    <div class="state-msg">No manageable keys found.</div>
  {:else}
    {#each grouped as group (group.cat)}
      <section class="section">
        <h3 class="section-title">{group.label}</h3>
        {#each group.items as slot (slot.name)}
          {@const revealedValue = revealed[slot.name]}
          {@const isBusy = !!busy[slot.name]}
          {@const hasDraft = draftOf(slot.name).trim().length > 0}
          <div class="key-card">
            <div class="key-head">
              <span class="key-label">{slot.label}</span>
              {#if slot.hasValue}
                <span class="saved-badge">Saved</span>
              {:else}
                <span class="unset-badge">Not set</span>
              {/if}
            </div>
            {#if slot.hint}
              <p class="key-hint">{slot.hint}</p>
            {/if}

            <div class="key-row">
              <input
                class="key-input"
                type="password"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                placeholder={slot.hasValue ? '•••••••• — type to replace' : 'not set'}
                value={draftOf(slot.name)}
                oninput={(e) => setDraft(slot.name, e.currentTarget.value)}
                onkeydown={(e) => onKeydown(e, slot.name)}
                disabled={isBusy}
              />
              <button
                type="button"
                class="icon-btn"
                class:active={revealedValue !== undefined}
                title={slot.hasValue ? (revealedValue !== undefined ? 'Hide value' : 'Reveal stored value') : 'Nothing stored to reveal'}
                aria-label={revealedValue !== undefined ? 'Hide value' : 'Reveal stored value'}
                aria-pressed={revealedValue !== undefined}
                onclick={() => toggleReveal(slot.name)}
                disabled={!slot.hasValue || busy[slot.name] === 'reveal'}
              >
                {#if revealedValue !== undefined}
                  <!-- eye-off -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                {:else}
                  <!-- eye -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                {/if}
              </button>
              {#if hasDraft}
                <button
                  type="button"
                  class="action-btn primary"
                  onclick={() => save(slot.name)}
                  disabled={isBusy}
                >
                  {busy[slot.name] === 'save' ? 'Saving…' : 'Save'}
                </button>
              {/if}
              {#if slot.hasValue}
                <button
                  type="button"
                  class="action-btn ghost"
                  onclick={() => clear(slot.name)}
                  disabled={isBusy}
                >
                  {busy[slot.name] === 'clear' ? 'Clearing…' : 'Clear'}
                </button>
              {/if}
            </div>

            {#if revealedValue !== undefined}
              <div class="revealed-line">
                <span class="revealed-tag">stored value</span>
                <code class="revealed-value">{revealedValue || '(empty)'}</code>
              </div>
            {/if}

            {#if rowStatus[slot.name]}
              <div class="row-status" class:ok={rowStatus[slot.name]?.ok} class:err={!rowStatus[slot.name]?.ok}>
                {rowStatus[slot.name]?.msg}
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</div>

<style>
  .keys-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 640px;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .panel-header h2 {
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--text-primary);
    margin: 0;
  }
  .panel-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem 0;
    line-height: 1.5;
  }
  .panel-desc strong {
    color: var(--text-secondary);
    font-weight: 500;
  }

  .state-msg {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    padding: 1.5rem 0.25rem;
  }
  .state-msg.error {
    color: var(--color-warning);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .section-title {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-secondary);
    margin: 0.5rem 0 0.125rem 0;
  }

  /* ── Key card ─────────────────────────────────────────────── */
  .key-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.875rem 1rem;
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .key-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .key-label {
    font-size: 0.9375rem;
    color: var(--text-primary);
    font-weight: 500;
  }
  .saved-badge {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    color: var(--color-success);
    background: var(--color-success-muted);
    line-height: 1.4;
  }
  .unset-badge {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    line-height: 1.4;
  }
  .key-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.45;
  }

  .key-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .key-input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-mono);
  }
  .key-input:focus {
    outline: none;
    border-color: var(--accent-muted);
    box-shadow: 0 0 0 2px var(--gold-glow);
  }
  .key-input:disabled {
    opacity: 0.6;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-tertiary);
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition);
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-hover);
    background: var(--bg-hover);
  }
  .icon-btn.active {
    color: var(--text-primary);
    border-color: var(--accent-muted);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .action-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    font-family: var(--font-heading);
    letter-spacing: 0.02em;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    cursor: pointer;
    transition: all var(--transition);
    white-space: nowrap;
  }
  .action-btn:hover:not(:disabled) {
    border-color: var(--border-hover);
    background: var(--bg-hover);
  }
  .action-btn.primary {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
  }
  .action-btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .action-btn.ghost {
    background: transparent;
  }
  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .revealed-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    background: var(--bg-input);
    border-radius: var(--radius-sm);
    min-width: 0;
  }
  .revealed-tag {
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .revealed-value {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--text-secondary);
    word-break: break-all;
    overflow-wrap: anywhere;
  }

  .row-status {
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }
  .row-status.ok {
    color: var(--color-success);
  }
  .row-status.err {
    color: var(--color-warning);
  }

  @media (max-width: 480px) {
    .key-row {
      flex-wrap: wrap;
    }
    .key-input {
      flex-basis: 100%;
    }
  }
</style>
