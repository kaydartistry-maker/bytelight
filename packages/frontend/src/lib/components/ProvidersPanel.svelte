<!--
  ProvidersPanel.svelte — Phase 2 Step 3 six-card layout.

  One card per provider in a fixed order. Only Ollama is functional in
  Step 3; the other five cards are scaffolded with brand iconography,
  auth chips, and disabled "coming soon" affordances so Step 4 / Step 6
  can wire them without restructuring the panel.

  Data sources:
    - GET /api/models/status        → routing mode + configured flags
    - GET /api/preferences          → redacted providers block (for state)
    - GET /api/models?provider=ollama → live model count for the Ollama card
    - POST /api/models/check        → live ping for the Ollama Check button
    - PUT  /api/preferences         → write { providers: { ollama: {...} } }
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, apiFetch } from '../utils/api.js';
  import CodexAuthCard from './CodexAuthCard.svelte';

  type AuthKind = 'oauth' | 'byok' | 'local';
  type StatusKind = 'connected' | 'needs-key' | 'coming-soon' | 'disabled';

  interface CardSpec {
    id: 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'xai' | 'ollama' | 'huggingface' | 'custom';
    name: string;
    icon: string;          // single letter / glyph
    iconBg: string;        // CSS background for the icon tile
    iconColor: string;     // foreground color
    auth: AuthKind;
    comingSoonStep: 4 | 6 | null;  // null for Anthropic + Ollama (functional)
  }

  const CARDS: CardSpec[] = [
    { id: 'anthropic',   name: 'Anthropic',       icon: 'A', iconBg: 'linear-gradient(135deg, #d97706, #ea580c)', iconColor: '#fff', auth: 'oauth', comingSoonStep: null },
    { id: 'openai',      name: 'OpenAI',          icon: 'G', iconBg: 'linear-gradient(135deg, #10a37f, #16c79a)', iconColor: '#fff', auth: 'byok',  comingSoonStep: null },
    { id: 'openrouter',  name: 'OpenRouter',      icon: 'R', iconBg: 'linear-gradient(135deg, #8b5cf6, #d946ef)', iconColor: '#fff', auth: 'byok',  comingSoonStep: null },
    { id: 'groq',        name: 'Groq',            icon: 'q', iconBg: 'linear-gradient(135deg, #f55036, #f97316)', iconColor: '#fff', auth: 'byok',  comingSoonStep: null },
    { id: 'xai',         name: 'Grok (xAI)',      icon: 'X', iconBg: 'linear-gradient(135deg, #1f2937, #000000)', iconColor: '#fff', auth: 'byok',  comingSoonStep: null },
    { id: 'ollama',      name: 'Ollama',          icon: '◯', iconBg: 'var(--bg-tertiary)', iconColor: 'var(--text-primary)', auth: 'local', comingSoonStep: null },
    { id: 'huggingface', name: 'HuggingFace',     icon: 'H', iconBg: 'linear-gradient(135deg, #facc15, #f59e0b)', iconColor: '#1a1a1a', auth: 'byok',  comingSoonStep: 4 },
    { id: 'custom',      name: 'Custom endpoint', icon: '+', iconBg: 'var(--bg-tertiary)', iconColor: 'var(--text-primary)', auth: 'byok',  comingSoonStep: 4 },
  ];

  // Server status (provider configured flags + routing mode).
  let status = $state<{
    routing?: 'sdk' | 'auto' | 'api';
    claude?: { configured: boolean };
    ollama?: { configured: boolean; enabled: boolean; url?: string };
    openrouter?: { configured: boolean };
    groq?: { configured: boolean };
    xai?: { configured: boolean };
    openai?: { configured: boolean; enabled?: boolean; url?: string };
    huggingface?: { configured: boolean };
  } | null>(null);

  // Live Ollama model count (refreshed on mount + after save).
  let ollamaModelCount = $state<number | null>(null);
  let ollamaReachable = $state<boolean | null>(null);

  // Ollama edit form state.
  let ollamaExpanded = $state(false);
  let ollamaBaseUrl = $state('http://localhost:11434');
  let ollamaApiKey = $state('');
  let ollamaEnabled = $state(false);
  let ollamaSaving = $state(false);
  let ollamaChecking = $state(false);
  let ollamaCheckResult = $state<{ ok: boolean; models?: number; error?: string } | null>(null);
  let ollamaSaveMessage = $state('');

  // ── OpenAI direct BYOK (Step 6A) — mirrors the Ollama state machine ──
  let openaiModelCount = $state<number | null>(null);
  let openaiReachable = $state<boolean | null>(null);

  let openaiExpanded = $state(false);
  let openaiBaseUrl = $state('https://api.openai.com/v1');
  let openaiApiKey = $state('');
  let openaiEnabled = $state(false);
  let openaiSaving = $state(false);
  let openaiChecking = $state(false);
  let openaiCheckResult = $state<{ ok: boolean; models?: number; error?: string } | null>(null);
  let openaiSaveMessage = $state('');

  async function loadStatus() {
    try {
      const res = await api.get('/api/models/status');
      if (res.ok) {
        status = await res.json();
        if (status?.ollama?.url) ollamaBaseUrl = status.ollama.url;
        ollamaEnabled = !!status?.ollama?.enabled;
        if (status?.openai?.url) openaiBaseUrl = status.openai.url;
        openaiEnabled = !!status?.openai?.enabled;
      }
    } catch (err) {
      console.error('Failed to load provider status:', err);
    }
  }

  async function loadOllamaModels() {
    try {
      const res = await apiFetch('/api/models?provider=ollama');
      if (res.ok) {
        const models = await res.json() as Array<unknown>;
        ollamaModelCount = Array.isArray(models) ? models.length : 0;
        ollamaReachable = (ollamaModelCount ?? 0) > 0 || !!status?.ollama?.enabled;
      } else {
        ollamaModelCount = 0;
        ollamaReachable = false;
      }
    } catch {
      ollamaModelCount = 0;
      ollamaReachable = false;
    }
  }

  async function checkOllamaConnection() {
    ollamaChecking = true;
    ollamaCheckResult = null;
    try {
      // 8s timeout matches the spec; api wrapper doesn't expose AbortSignal,
      // so we race against a manual timer.
      type CheckPayload = { ok: boolean; models?: number; error?: string };
      const checkPromise: Promise<CheckPayload> = api.post('/api/models/check', {
        provider: 'ollama',
        base_url: ollamaBaseUrl,
        api_key: ollamaApiKey || undefined,
      }).then((r) => r.json() as Promise<CheckPayload>);
      const timeoutPromise = new Promise<CheckPayload>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out after 8s')), 8000),
      );
      const result: CheckPayload = await Promise.race([checkPromise, timeoutPromise]);
      ollamaCheckResult = result;
      if (result.ok) {
        ollamaReachable = true;
        ollamaModelCount = result.models ?? ollamaModelCount;
      } else {
        ollamaReachable = false;
      }
    } catch (err) {
      ollamaCheckResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      ollamaReachable = false;
    } finally {
      ollamaChecking = false;
    }
  }

  async function saveOllama() {
    ollamaSaving = true;
    ollamaSaveMessage = '';
    try {
      const res = await api.put('/api/preferences', {
        providers: {
          ollama: {
            base_url: ollamaBaseUrl,
            ...(ollamaApiKey ? { api_key: ollamaApiKey } : {}),
            enabled: ollamaEnabled,
          },
        },
      });
      if (res.ok) {
        ollamaSaveMessage = 'Saved';
        ollamaExpanded = false;
        await loadStatus();
        await loadOllamaModels();
      } else {
        const body = await res.text().catch(() => '');
        ollamaSaveMessage = `Save failed: ${res.status} ${body.slice(0, 200)}`;
      }
    } catch (err) {
      ollamaSaveMessage = `Save error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      ollamaSaving = false;
    }
  }

  function expandOllama() {
    ollamaExpanded = true;
    ollamaCheckResult = null;
    ollamaSaveMessage = '';
  }

  function cancelOllama() {
    ollamaExpanded = false;
    // Reset to server values
    if (status?.ollama?.url) ollamaBaseUrl = status.ollama.url;
    ollamaEnabled = !!status?.ollama?.enabled;
    ollamaApiKey = '';
    ollamaCheckResult = null;
  }

  // ── OpenAI direct BYOK functions (Step 6A) ──────────────────────────────
  async function loadOpenaiModels() {
    try {
      const res = await apiFetch('/api/models?provider=openai');
      if (res.ok) {
        const models = await res.json() as Array<unknown>;
        openaiModelCount = Array.isArray(models) ? models.length : 0;
        openaiReachable = (openaiModelCount ?? 0) > 0 || !!status?.openai?.enabled;
      } else {
        openaiModelCount = 0;
        openaiReachable = false;
      }
    } catch {
      openaiModelCount = 0;
      openaiReachable = false;
    }
  }

  async function checkOpenaiConnection() {
    openaiChecking = true;
    openaiCheckResult = null;
    try {
      type CheckPayload = { ok: boolean; models?: number; error?: string };
      const checkPromise: Promise<CheckPayload> = api.post('/api/models/check', {
        provider: 'openai',
        base_url: openaiBaseUrl,
        api_key: openaiApiKey || undefined,
      }).then((r) => r.json() as Promise<CheckPayload>);
      const timeoutPromise = new Promise<CheckPayload>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out after 8s')), 8000),
      );
      const result: CheckPayload = await Promise.race([checkPromise, timeoutPromise]);
      openaiCheckResult = result;
      if (result.ok) {
        openaiReachable = true;
        openaiModelCount = result.models ?? openaiModelCount;
      } else {
        openaiReachable = false;
      }
    } catch (err) {
      openaiCheckResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
      openaiReachable = false;
    } finally {
      openaiChecking = false;
    }
  }

  async function saveOpenai() {
    openaiSaving = true;
    openaiSaveMessage = '';
    try {
      const res = await api.put('/api/preferences', {
        providers: {
          openai: {
            base_url: openaiBaseUrl,
            ...(openaiApiKey ? { api_key: openaiApiKey } : {}),
            enabled: openaiEnabled,
          },
        },
      });
      if (res.ok) {
        openaiSaveMessage = 'Saved';
        openaiExpanded = false;
        await loadStatus();
        await loadOpenaiModels();
      } else {
        const body = await res.text().catch(() => '');
        openaiSaveMessage = `Save failed: ${res.status} ${body.slice(0, 200)}`;
      }
    } catch (err) {
      openaiSaveMessage = `Save error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      openaiSaving = false;
    }
  }

  function expandOpenai() {
    openaiExpanded = true;
    openaiCheckResult = null;
    openaiSaveMessage = '';
  }

  function cancelOpenai() {
    openaiExpanded = false;
    if (status?.openai?.url) openaiBaseUrl = status.openai.url;
    openaiEnabled = !!status?.openai?.enabled;
    openaiApiKey = '';
    openaiCheckResult = null;
  }

  // ── OpenAI-compat BYOK (OpenRouter / Groq / xAI) — H3b-1 ─────────────────
  // Key-only lanes: their catalog probe + dispatcher gate on api_key +
  // routing!=sdk (NO two-stage enabled flag, unlike OpenAI/Ollama), so the
  // card saves only the API key. base_url is intentionally NOT sent — the
  // backend catalog probe and router carry consistent defaults, and the two
  // disagree on whether base_url includes `/v1`, so letting the defaults
  // apply is the safe path. The Check button pings /api/models/check with a
  // transient (unsaved) canonical base so folks can validate a key inline.
  type CompatId = 'openrouter' | 'groq' | 'xai';
  const COMPAT_CHECK_BASE: Record<CompatId, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    xai: 'https://api.x.ai/v1',
  };
  function isCompat(id: CardSpec['id']): id is CompatId {
    return id === 'openrouter' || id === 'groq' || id === 'xai';
  }
  let compatExpanded = $state<Record<CompatId, boolean>>({ openrouter: false, groq: false, xai: false });
  let compatApiKey = $state<Record<CompatId, string>>({ openrouter: '', groq: '', xai: '' });
  let compatSaving = $state<Record<CompatId, boolean>>({ openrouter: false, groq: false, xai: false });
  let compatChecking = $state<Record<CompatId, boolean>>({ openrouter: false, groq: false, xai: false });
  let compatCheckResult = $state<Record<CompatId, { ok: boolean; models?: number; error?: string } | null>>({ openrouter: null, groq: null, xai: null });
  let compatSaveMessage = $state<Record<CompatId, string>>({ openrouter: '', groq: '', xai: '' });

  function expandCompat(id: CompatId) {
    compatExpanded[id] = true;
    compatCheckResult[id] = null;
    compatSaveMessage[id] = '';
  }
  function cancelCompat(id: CompatId) {
    compatExpanded[id] = false;
    compatApiKey[id] = '';
    compatCheckResult[id] = null;
  }

  async function checkCompatConnection(id: CompatId) {
    compatChecking[id] = true;
    compatCheckResult[id] = null;
    try {
      type CheckPayload = { ok: boolean; models?: number; error?: string };
      const checkPromise: Promise<CheckPayload> = api.post('/api/models/check', {
        provider: id,
        base_url: COMPAT_CHECK_BASE[id],
        api_key: compatApiKey[id] || undefined,
      }).then((r) => r.json() as Promise<CheckPayload>);
      const timeoutPromise = new Promise<CheckPayload>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out after 8s')), 8000),
      );
      compatCheckResult[id] = await Promise.race([checkPromise, timeoutPromise]);
    } catch (err) {
      compatCheckResult[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      compatChecking[id] = false;
    }
  }

  async function saveCompat(id: CompatId) {
    compatSaving[id] = true;
    compatSaveMessage[id] = '';
    try {
      const res = await api.put('/api/preferences', {
        providers: {
          [id]: {
            ...(compatApiKey[id] ? { api_key: compatApiKey[id] } : {}),
          },
        },
      });
      if (res.ok) {
        compatSaveMessage[id] = 'Saved';
        compatExpanded[id] = false;
        compatApiKey[id] = '';
        await loadStatus();
      } else {
        const body = await res.text().catch(() => '');
        compatSaveMessage[id] = `Save failed: ${res.status} ${body.slice(0, 200)}`;
      }
    } catch (err) {
      compatSaveMessage[id] = `Save error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      compatSaving[id] = false;
    }
  }

  // Per-card derived status text + dot class.
  function cardStatus(id: CardSpec['id']): { dot: StatusKind; text: string } {
    if (id === 'anthropic') {
      return { dot: 'connected', text: 'connected · Claude Agent SDK' };
    }
    if (id === 'openai') {
      // Step 6A — BYOK direct. Mirrors Ollama's enabled/configured/reachable
      // gates. Routing-sdk shows a warning chip line; the dispatcher refuses
      // OpenAI direct turns under routing=sdk, so we surface that here.
      const configured = !!status?.openai?.configured;
      const enabled = !!status?.openai?.enabled;
      const routingSdk = status?.routing === 'sdk';
      if (!configured && !enabled) return { dot: 'disabled', text: 'disabled · add API key' };
      if (configured && !enabled)  return { dot: 'disabled', text: 'disabled · enable to use' };
      if (routingSdk)              return { dot: 'needs-key', text: 'routing=sdk · switch to auto for OpenAI direct turns' };
      if (openaiReachable === false) {
        return { dot: 'needs-key', text: 'needs-key · check key/base URL' };
      }
      if (openaiModelCount === null) return { dot: 'connected', text: 'enabled · checking…' };
      return { dot: 'connected', text: `connected · ${openaiModelCount} model${openaiModelCount === 1 ? '' : 's'}` };
    }
    if (isCompat(id)) {
      // H3b-1: OpenAI-compat BYOK. Gated on api_key (configured) + routing.
      // No two-stage enabled flag — a saved key + routing!=sdk is live.
      const configured = !!status?.[id]?.configured;
      const routingSdk = status?.routing === 'sdk';
      if (!configured) return { dot: 'disabled', text: 'disabled · add API key' };
      if (routingSdk)  return { dot: 'needs-key', text: 'routing=sdk · switch to auto to use' };
      return { dot: 'connected', text: 'connected · key set' };
    }
    if (id === 'ollama') {
      const enabled = !!status?.ollama?.enabled;
      const configured = !!status?.ollama?.configured;
      if (!configured) return { dot: 'disabled', text: 'not configured · click Configure' };
      if (!enabled)   return { dot: 'disabled', text: 'disabled · two-stage gate off' };
      if (ollamaReachable === false) {
        return { dot: 'needs-key', text: `unreachable at ${status?.ollama?.url ?? ollamaBaseUrl} · check URL` };
      }
      const url = status?.ollama?.url ?? ollamaBaseUrl;
      if (ollamaModelCount === null) return { dot: 'connected', text: `enabled at ${url}` };
      return { dot: 'connected', text: `running at ${url} · ${ollamaModelCount} model${ollamaModelCount === 1 ? '' : 's'}` };
    }
    if (id === 'huggingface') return { dot: 'coming-soon', text: 'coming soon · Step 4' };
    return { dot: 'coming-soon', text: 'bring your own URL + key' };
  }

  function cardBorderClass(id: CardSpec['id']): string {
    const s = cardStatus(id);
    if (s.dot === 'connected') return 'border-connected';
    if (s.dot === 'needs-key') return 'border-needs-key';
    return '';
  }

  function authChipClass(auth: AuthKind): string {
    return `chip-${auth}`;
  }

  function comingSoonHint(step: 4 | 6 | null): string {
    if (step === 4) return 'Available in Step 4';
    if (step === 6) return 'Available in Step 6';
    return '';
  }

  onMount(async () => {
    await loadStatus();
    await loadOllamaModels();
    await loadOpenaiModels();
  });
</script>

<div class="providers-panel">
  <header class="panel-header">
    <h2>Providers</h2>
    {#if status?.routing}
      <span class="routing-pill" class:routing-sdk={status.routing === 'sdk'} class:routing-auto={status.routing === 'auto'} class:routing-api={status.routing === 'api'}>
        routing · {status.routing}
      </span>
    {/if}
  </header>
  <p class="panel-desc">
    Engine connections — one card each. Anthropic, Ollama, OpenAI direct, OpenRouter, Groq, and Grok (xAI) are wired today (BYOK for the key-based lanes); HuggingFace and Custom remain in development. ChatGPT / Codex OAuth is a session-based connection configured separately below.
  </p>

  {#each CARDS as card}
    {@const cs = cardStatus(card.id)}
    {@const disabled = card.comingSoonStep !== null}
    {@const compatId = isCompat(card.id) ? card.id : null}
    <div class="card {cardBorderClass(card.id)}" class:expanded={(card.id === 'ollama' && ollamaExpanded) || (card.id === 'openai' && openaiExpanded) || (compatId !== null && compatExpanded[compatId])}>
      <div class="card-row">
        <div class="icon-tile" style="background: {card.iconBg}; color: {card.iconColor};">{card.icon}</div>
        <div class="card-body">
          <div class="card-title-row">
            <span class="card-name">{card.name}</span>
            <span class="auth-chip {authChipClass(card.auth)}">{card.auth}</span>
          </div>
          <div class="card-status-row">
            <span class="status-dot status-{cs.dot}"></span>
            <span class="status-text">{cs.text}</span>
          </div>
        </div>
        <div class="card-action">
          {#if card.id === 'anthropic'}
            <button type="button" class="action-btn" disabled aria-disabled="true" title="SDK manages auth — nothing to configure here">
              Manage
            </button>
          {:else if card.id === 'ollama'}
            {#if ollamaExpanded}
              <button type="button" class="action-btn ghost" onclick={cancelOllama}>Cancel</button>
            {:else}
              <button type="button" class="action-btn primary" onclick={expandOllama}>
                {status?.ollama?.configured ? 'Configure' : 'Set up'}
              </button>
            {/if}
          {:else if card.id === 'openai'}
            {#if openaiExpanded}
              <button type="button" class="action-btn ghost" onclick={cancelOpenai}>Cancel</button>
            {:else}
              <button type="button" class="action-btn primary" onclick={expandOpenai}>
                {status?.openai?.configured ? 'Configure' : 'Add key'}
              </button>
            {/if}
          {:else if compatId !== null}
            {#if compatExpanded[compatId]}
              <button type="button" class="action-btn ghost" onclick={() => cancelCompat(compatId)}>Cancel</button>
            {:else}
              <button type="button" class="action-btn primary" onclick={() => expandCompat(compatId)}>
                {status?.[compatId]?.configured ? 'Configure' : 'Add key'}
              </button>
            {/if}
          {:else if disabled}
            <button type="button" class="action-btn" disabled aria-disabled="true" title={comingSoonHint(card.comingSoonStep)}>
              {card.id === 'openrouter' || card.id === 'huggingface' ? 'Add key' : card.id === 'custom' ? 'Add' : 'Connect'}
            </button>
          {/if}
        </div>
      </div>

      <!-- Disabled-card affordance — small italic hint under the action button -->
      {#if disabled}
        <div class="coming-soon-hint">{comingSoonHint(card.comingSoonStep)}</div>
      {/if}

      <!-- Ollama inline-expansion form -->
      {#if card.id === 'ollama' && ollamaExpanded}
        <div class="inline-form">
          <label class="form-field">
            <span class="form-label">Base URL</span>
            <input type="text" bind:value={ollamaBaseUrl} placeholder="http://localhost:11434" />
          </label>
          <label class="form-field">
            <span class="form-label">API key <span class="hint">(optional)</span></span>
            <input type="password" bind:value={ollamaApiKey} placeholder="leave blank if not required" autocomplete="off" />
          </label>
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={ollamaEnabled} />
            <span>Enabled (two-stage rollback gate)</span>
          </label>

          <div class="form-actions">
            <button type="button" class="action-btn ghost" onclick={checkOllamaConnection} disabled={ollamaChecking || !ollamaBaseUrl}>
              {ollamaChecking ? 'Checking…' : 'Check Connection'}
            </button>
            <button type="button" class="action-btn primary" onclick={saveOllama} disabled={ollamaSaving || !ollamaBaseUrl}>
              {ollamaSaving ? 'Saving…' : 'Save'}
            </button>
          </div>

          {#if ollamaCheckResult}
            <div class="check-result" class:ok={ollamaCheckResult.ok} class:err={!ollamaCheckResult.ok}>
              {#if ollamaCheckResult.ok}
                Connected — {ollamaCheckResult.models ?? 0} model{(ollamaCheckResult.models ?? 0) === 1 ? '' : 's'} discoverable.
              {:else}
                Failed: {ollamaCheckResult.error}
              {/if}
            </div>
          {/if}

          {#if ollamaSaveMessage}
            <div class="save-msg">{ollamaSaveMessage}</div>
          {/if}

          {#if status?.routing === 'sdk' && ollamaEnabled}
            <p class="warn-line">
              Routing is still <code>sdk</code> — set <code>PROVIDER_ROUTING=auto</code> (env or YAML) to actually dispatch turns through Ollama.
            </p>
          {/if}
        </div>
      {/if}

      <!-- OpenAI direct (BYOK) inline-expansion form — Step 6A -->
      {#if card.id === 'openai' && openaiExpanded}
        <div class="inline-form">
          <label class="form-field">
            <span class="form-label">Base URL</span>
            <input type="text" bind:value={openaiBaseUrl} placeholder="https://api.openai.com/v1" />
          </label>
          <label class="form-field">
            <span class="form-label">OpenAI API key</span>
            <input type="password" bind:value={openaiApiKey} placeholder="sk-…" autocomplete="off" />
          </label>
          <label class="form-checkbox">
            <input type="checkbox" bind:checked={openaiEnabled} />
            <span>Enabled (two-stage rollback gate)</span>
          </label>

          <div class="form-actions">
            <button type="button" class="action-btn ghost" onclick={checkOpenaiConnection} disabled={openaiChecking || !openaiBaseUrl}>
              {openaiChecking ? 'Checking…' : 'Check Connection'}
            </button>
            <button type="button" class="action-btn primary" onclick={saveOpenai} disabled={openaiSaving || !openaiBaseUrl}>
              {openaiSaving ? 'Saving…' : 'Save'}
            </button>
          </div>

          {#if openaiCheckResult}
            <div class="check-result" class:ok={openaiCheckResult.ok} class:err={!openaiCheckResult.ok}>
              {#if openaiCheckResult.ok}
                Connected — {openaiCheckResult.models ?? 0} model{(openaiCheckResult.models ?? 0) === 1 ? '' : 's'} discoverable.
              {:else}
                Failed: {openaiCheckResult.error}
              {/if}
            </div>
          {/if}

          {#if openaiSaveMessage}
            <div class="save-msg">{openaiSaveMessage}</div>
          {/if}

          {#if status?.routing === 'sdk' && openaiEnabled}
            <p class="warn-line">
              Routing must be <code>auto</code> for OpenAI direct turns. Current routing is <code>sdk</code>.
            </p>
          {/if}

          <p class="warn-line">
            ChatGPT / Codex OAuth is configured separately below — this card is API-key BYOK only.
          </p>
        </div>
      {/if}

      <!-- OpenAI-compat BYOK (OpenRouter / Groq / xAI) inline form — H3b-1 -->
      {#if compatId !== null && compatExpanded[compatId]}
        <div class="inline-form">
          <label class="form-field">
            <span class="form-label">{card.name} API key</span>
            <input type="password" bind:value={compatApiKey[compatId]} placeholder="paste your key" autocomplete="off" />
          </label>

          <div class="form-actions">
            <button type="button" class="action-btn ghost" onclick={() => checkCompatConnection(compatId)} disabled={compatChecking[compatId] || !compatApiKey[compatId]}>
              {compatChecking[compatId] ? 'Checking…' : 'Check Connection'}
            </button>
            <button type="button" class="action-btn primary" onclick={() => saveCompat(compatId)} disabled={compatSaving[compatId] || !compatApiKey[compatId]}>
              {compatSaving[compatId] ? 'Saving…' : 'Save'}
            </button>
          </div>

          {#if compatCheckResult[compatId]}
            <div class="check-result" class:ok={compatCheckResult[compatId]?.ok} class:err={!compatCheckResult[compatId]?.ok}>
              {#if compatCheckResult[compatId]?.ok}
                Connected — {compatCheckResult[compatId]?.models ?? 0} model{(compatCheckResult[compatId]?.models ?? 0) === 1 ? '' : 's'} discoverable.
              {:else}
                Failed: {compatCheckResult[compatId]?.error}
              {/if}
            </div>
          {/if}

          {#if compatSaveMessage[compatId]}
            <div class="save-msg">{compatSaveMessage[compatId]}</div>
          {/if}

          {#if status?.routing === 'sdk'}
            <p class="warn-line">
              Routing must be <code>auto</code> for {card.name} turns. Current routing is <code>sdk</code>.
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  <!--
    ChatGPT / Codex OAuth connection surface. Session-based connection,
    distinct from the API-key engines above. Codex runtime dispatches turns
    through CodexRuntime; this section owns the OAuth handshake only.
    Default-model routing lives on the Preferences tab (separate slice).
  -->
  <section class="codex-section" aria-labelledby="codex-section-title">
    <div class="codex-section-head">
      <h3 id="codex-section-title">ChatGPT / Codex Connection</h3>
      <p class="codex-section-desc">
        Connect your ChatGPT session to enable the Codex runtime path. This
        is a session-based connection, distinct from the API-key engines
        above.
      </p>
    </div>
    <CodexAuthCard />
  </section>
</div>

<style>
  .providers-panel {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    max-width: 640px;
  }

  .codex-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(155, 114, 207, 0.18);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .codex-section-head h3 {
    margin: 0 0 0.25rem 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-primary);
  }
  .codex-section-desc {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(190, 180, 215, 0.65);
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
  .routing-pill {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
  }
  .routing-pill.routing-auto {
    color: var(--color-success);
    background: var(--color-success-muted);
    border-color: transparent;
  }
  .routing-pill.routing-api {
    color: var(--color-warning);
    background: var(--color-warning-muted);
    border-color: transparent;
  }

  .panel-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 0.5rem 0;
    line-height: 1.5;
  }

  /* ── Card ─────────────────────────────────────────────────── */
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.875rem 1rem;
    background: var(--bg-secondary);
    transition: border-color var(--transition), background var(--transition);
  }
  .card.border-connected {
    border-color: color-mix(in srgb, var(--color-success) 35%, var(--border));
  }
  .card.border-needs-key {
    border-color: color-mix(in srgb, var(--color-warning) 40%, var(--border));
  }
  .card.expanded {
    background: var(--bg-tertiary);
  }

  .card-row {
    display: grid;
    grid-template-columns: 2rem 1fr auto;
    gap: 0.875rem;
    align-items: center;
  }

  .icon-tile {
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-heading);
    font-weight: 600;
    font-size: 0.9375rem;
    flex-shrink: 0;
  }

  .card-body {
    min-width: 0;
  }
  .card-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .card-name {
    font-size: 0.9375rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  /* ── Auth chip ─────────────────────────────────────────────── */
  .auth-chip {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    border: 1px solid currentColor;
    line-height: 1.4;
  }
  /* OAuth → cyan-ish (we use --gold which is teal in dark theme) */
  .chip-oauth {
    color: color-mix(in srgb, #22d3ee 80%, var(--text-secondary));
    background: color-mix(in srgb, #22d3ee 10%, transparent);
  }
  /* BYOK → gold */
  .chip-byok {
    color: var(--gold-bright);
    background: var(--gold-glow);
  }
  /* Local → success-green */
  .chip-local {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  /* ── Status dot + text ─────────────────────────────────────── */
  .card-status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .status-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .status-dot.status-connected { background: var(--color-success); box-shadow: 0 0 6px color-mix(in srgb, var(--color-success) 60%, transparent); }
  .status-dot.status-needs-key { background: var(--color-warning); }
  .status-dot.status-coming-soon { background: var(--text-muted); opacity: 0.4; }
  .status-dot.status-disabled { background: var(--text-muted); opacity: 0.3; }
  .status-text {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    letter-spacing: 0;
  }

  /* ── Action button ─────────────────────────────────────────── */
  .card-action {
    display: flex;
    align-items: center;
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

  .coming-soon-hint {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
    margin: 0.375rem 0 0 2.875rem;  /* indent under text column */
  }

  /* ── Inline expansion form ─────────────────────────────────── */
  .inline-form {
    margin-top: 0.875rem;
    padding-top: 0.875rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .form-label {
    font-size: 0.75rem;
    color: var(--text-secondary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .form-label .hint {
    color: var(--text-muted);
    text-transform: none;
    font-size: 0.6875rem;
    letter-spacing: 0;
  }
  .form-field input {
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: var(--font-mono);
  }
  .form-field input:focus {
    outline: none;
    border-color: var(--accent-muted);
    box-shadow: 0 0 0 2px var(--gold-glow);
  }
  .form-checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .form-checkbox input {
    accent-color: var(--accent);
  }
  .form-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .check-result {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    font-family: var(--font-mono);
  }
  .check-result.ok {
    background: var(--color-success-muted);
    color: var(--color-success);
  }
  .check-result.err {
    background: var(--color-warning-muted);
    color: var(--color-warning);
  }
  .save-msg {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .warn-line {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .warn-line code {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    padding: 0 0.25rem;
    background: var(--bg-input);
    border-radius: 3px;
    color: var(--text-secondary);
  }
</style>
