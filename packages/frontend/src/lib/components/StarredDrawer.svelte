<!-- Adapted for byte-light under Apache 2.0 (generic multi-actor). -->
<script lang="ts">
  import { apiFetch } from '$lib/utils/api';

  // Human default actor + configured companions. Filter tabs are built from this
  // set UNIONed with any actor slugs actually present in the data — so future
  // companions surface automatically with no code change.
  const HUMAN_ACTOR = 'user';
  const CONFIGURED_ACTORS = ['user', 'companion-a', 'companion-b', 'companion-c'];

  type Filter = string; // actor slug or 'all'

  interface StarredItem {
    id: string;
    message_id: string;
    starred_by: string;
    starred_at: string;
    note: string | null;
    thread_id: string;
    thread_title: string | null;
    message_role: 'user' | 'companion' | 'system';
    message_content: string;
    message_content_type: string;
    message_created_at: string;
    message_deleted_at: string | null;
  }

  interface Props {
    open: boolean;
    onclose?: () => void;
    /** Focus a starred message in its thread (chat page owns the scroll logic). */
    onopen?: (threadId: string, messageId: string) => void;
  }

  let { open = $bindable(false), onclose, onopen }: Props = $props();

  let items = $state<StarredItem[]>([]);
  let counts = $state<Record<string, number>>({});
  let filter = $state<Filter>(HUMAN_ACTOR);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Actor tabs: configured actors first (in order), then any extra actors seen in counts.
  const actorTabs = $derived([
    ...CONFIGURED_ACTORS,
    ...Object.keys(counts).filter((a) => !CONFIGURED_ACTORS.includes(a)),
  ]);

  const totalCount = $derived(Object.values(counts).reduce((s, n) => s + n, 0));

  async function load() {
    loading = true;
    error = null;
    try {
      const r = await apiFetch(`/api/starred?starred_by=${encodeURIComponent(filter)}&limit=300`);
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      const data = await r.json();
      items = data.items ?? [];
      counts = data.counts ?? {};
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load starred messages';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open) {
      filter;
      load();
    }
  });

  function close() {
    open = false;
    onclose?.();
  }

  function snippet(content: string, contentType: string): string {
    if (contentType === 'image') return '🖼 image';
    if (contentType === 'audio') return '🎤 voice';
    if (contentType === 'file') return '📎 file';
    const trimmed = content.replace(/\s+/g, ' ').trim();
    return trimmed.length > 140 ? trimmed.slice(0, 140) + '…' : trimmed;
  }

  function actorLabel(a: string): string {
    if (a === HUMAN_ACTOR) return 'Yours';
    return a.charAt(0).toUpperCase() + a.slice(1);
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  async function unstar(item: StarredItem, e: MouseEvent) {
    e.stopPropagation();
    try {
      const r = await apiFetch(`/api/messages/${item.message_id}/star`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ starred_by: item.starred_by }),
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      items = items.filter((i) => i.id !== item.id);
      counts = { ...counts, [item.starred_by]: Math.max((counts[item.starred_by] ?? 1) - 1, 0) };
    } catch (err) {
      console.error('Unstar failed:', err);
    }
  }

  function openInThread(item: StarredItem) {
    close();
    onopen?.(item.thread_id, item.message_id);
  }
</script>

{#if open}
  <div class="drawer-backdrop" onclick={close} role="presentation"></div>
  <div class="drawer" role="dialog" tabindex="-1" aria-label="Starred messages" aria-modal="true">
    <header class="drawer-header">
      <h2>Starred</h2>
      <span class="summary">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
      <button class="close-btn" onclick={close} aria-label="Close">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </header>

    <nav class="filters" aria-label="Starred filter">
      {#each actorTabs as actor (actor)}
        <button class="filter-btn" class:active={filter === actor} onclick={() => (filter = actor)}>
          {actorLabel(actor)} <span class="count">{counts[actor] ?? 0}</span>
        </button>
      {/each}
      <button class="filter-btn" class:active={filter === 'all'} onclick={() => (filter = 'all')}>
        All <span class="count">{totalCount}</span>
      </button>
    </nav>

    <div class="drawer-body">
      {#if loading}
        <p class="status">Loading…</p>
      {:else if error}
        <p class="status status-error">{error}</p>
      {:else if items.length === 0}
        <p class="status">
          {#if filter === HUMAN_ACTOR}
            No starred messages yet. Tap the ⭐ on any bubble to save it here.
          {:else if filter === 'all'}
            No starred messages yet.
          {:else}
            {actorLabel(filter)} hasn't starred anything yet.
          {/if}
        </p>
      {:else}
        <ul class="star-list">
          {#each items as item (item.id)}
            <li class="star-row">
              <button class="star-card" onclick={() => openInThread(item)}>
                <div class="star-card-head">
                  <span class="thread-name">{item.thread_title ?? 'Untitled thread'}</span>
                  <span class="star-meta">
                    <span class="actor-badge">{actorLabel(item.starred_by)}</span>
                    <span class="date">{formatDate(item.starred_at)}</span>
                  </span>
                </div>
                <div class="snippet" class:from-companion={item.message_role === 'companion'}>
                  {snippet(item.message_content, item.message_content_type)}
                </div>
                {#if item.note}
                  <div class="note">“{item.note}”</div>
                {/if}
              </button>
              <button
                class="unstar-btn"
                type="button"
                onclick={(e) => unstar(item, e)}
                title="Remove star"
                aria-label="Remove star"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 80;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    background: var(--bg-secondary);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    z-index: 81;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
  }

  .drawer-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1rem 0.75rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .drawer-header h2 {
    font-family: var(--font-heading);
    font-size: 1.125rem;
    font-weight: 500;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0;
  }

  .summary {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-right: auto;
  }

  .close-btn {
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .close-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }

  .filters {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .filter-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 0.35rem 0.65rem;
    border-radius: 999px;
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .filter-btn:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }
  .filter-btn.active {
    color: var(--accent);
    background: var(--bg-active);
    border-color: var(--border);
  }
  .count {
    font-size: 0.7rem;
    opacity: 0.65;
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
  }

  .status {
    color: var(--text-muted);
    font-size: 0.875rem;
    text-align: center;
    padding: 2rem 1rem;
  }
  .status-error {
    color: var(--gold-dim);
    font-style: normal;
  }

  .star-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .star-row {
    position: relative;
  }

  .star-card {
    width: 100%;
    text-align: left;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.65rem 0.75rem;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    transition: border-color var(--transition);
  }
  .star-card:hover {
    border-color: var(--accent);
    background: var(--bg-hover);
  }

  .star-card-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .thread-name {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .star-meta {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .actor-badge {
    font-size: 0.7rem;
    line-height: 1;
    color: var(--accent);
  }

  .snippet {
    font-size: 0.85rem;
    color: var(--text-primary);
    line-height: 1.4;
    word-break: break-word;
  }
  .snippet.from-companion {
    color: var(--text-secondary);
    font-style: italic;
  }

  .note {
    font-size: 0.78rem;
    color: var(--text-muted);
    border-left: 2px solid var(--accent-muted, var(--border));
    padding-left: 0.5rem;
  }

  .unstar-btn {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: transparent;
    border: none;
    color: var(--accent);
    opacity: 0.65;
    cursor: pointer;
    padding: 0.2rem;
    border-radius: 4px;
  }
  .unstar-btn:hover {
    opacity: 1;
    background: var(--bg-hover);
  }
</style>
