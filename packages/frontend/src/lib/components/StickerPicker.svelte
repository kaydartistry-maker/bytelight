<script lang="ts">
  import type { Sticker } from '@bytelight/shared';
  import { getStickerPacks, getStickersForPack, isStickersLoaded } from '$lib/stores/stickers.svelte';

  let {
    onselect,
    onclose,
  }: {
    onselect: (sticker: Sticker) => void;
    onclose: () => void;
  } = $props();

  let packs = $derived(getStickerPacks());
  let loaded = $derived(isStickersLoaded());
  let activePack = $state<string | null>(null);
  let searchQuery = $state('');
  let pickerEl: HTMLDivElement;

  $effect(() => {
    if (packs.length > 0 && !activePack) activePack = packs[0].id;
  });

  let currentStickers = $derived.by(() => {
    if (!activePack) return [];
    let list = getStickersForPack(activePack);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = [];
      for (const p of packs) {
        for (const s of getStickersForPack(p.id)) {
          if (s.name.toLowerCase().includes(q) || s.aliases.some(a => a.toLowerCase().includes(q))) {
            list.push(s);
          }
        }
      }
    }
    return list;
  });

  function handleSelect(sticker: Sticker) {
    onselect(sticker);
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  // Close on click outside — exclude the wrapper that also holds the trigger
  // button, so its own toggle isn't fought when the picker is dismissed.
  function handleClickOutside(e: MouseEvent) {
    const root = pickerEl?.closest('.sticker-picker-wrapper') ?? pickerEl;
    if (root && !root.contains(e.target as Node)) {
      onclose();
    }
  }

  $effect(() => {
    document.addEventListener('click', handleClickOutside, true);
    return () => document.removeEventListener('click', handleClickOutside, true);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="sp" bind:this={pickerEl}>
  <div class="sp-search">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      class="sp-search-input"
      bind:value={searchQuery}
      placeholder="Search stickers..."
      autofocus
    />
    <button class="sp-close" onclick={onclose} aria-label="Close" title="Close">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  </div>

  {#if packs.length > 1 && !searchQuery}
    <div class="sp-tabs">
      {#each packs as pack}
        <button
          class="sp-tab"
          class:active={activePack === pack.id}
          onclick={() => activePack = pack.id}
          title={pack.name}
        >{pack.name}</button>
      {/each}
    </div>
  {/if}

  <div class="sp-grid">
    {#if !loaded}
      <div class="sp-empty">Loading stickers...</div>
    {:else if packs.length === 0}
      <div class="sp-empty">
        <span>No sticker packs</span>
        <span class="sp-empty-sub">Add packs in Settings</span>
      </div>
    {:else if currentStickers.length === 0}
      <div class="sp-empty">No matches</div>
    {:else}
      {#each currentStickers as sticker (sticker.id)}
        <button
          class="sp-sticker"
          onclick={() => handleSelect(sticker)}
          title={`:${packs.find(p => p.id === sticker.pack_id)?.name || ''}_${sticker.name}:`}
        >
          <img src={sticker.url} alt={sticker.name} loading="lazy" />
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .sp {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 0;
    width: 320px;
    max-height: 360px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 60;
    display: flex;
    flex-direction: column;
    animation: spFade 0.15s ease-out;
    overflow: hidden;
  }
  @keyframes spFade {
    from { opacity: 0; transform: translateY(0.5rem); }
    to { opacity: 1; transform: translateY(0); }
  }
  /* Full-width sheet on mobile so it never runs off the edge */
  @media (max-width: 768px) {
    .sp {
      position: fixed;
      top: auto;
      bottom: 4.5rem;
      left: 0.5rem;
      right: 0.5rem;
      width: auto;
      max-height: 50vh;
      z-index: 200;
    }
  }
  .sp-search {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .sp-search-input {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    color: var(--text-primary);
    padding: 0.35rem 0.5rem;
    font-size: 0.75rem;
    outline: none;
  }
  .sp-search-input:focus { border-color: var(--gold-dim); }
  .sp-search-input::placeholder { color: var(--text-muted); }
  .sp-close {
    flex-shrink: 0;
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sp-close:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
  .sp-tabs {
    display: flex;
    gap: 0.125rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .sp-tab {
    font-size: 0.65rem;
    padding: 0.2rem 0.5rem;
    border-radius: 0.5rem;
    color: var(--text-muted);
    background: transparent;
    white-space: nowrap;
    transition: all var(--transition);
    text-transform: capitalize;
  }
  .sp-tab:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
  .sp-tab.active { color: var(--gold); background: rgba(212, 175, 55, 0.12); }
  .sp-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
    padding: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }
  .sp-sticker {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    padding: 0.25rem;
    transition: all 0.12s ease;
    cursor: pointer;
    background: transparent;
    border: none;
  }
  .sp-sticker:hover {
    background: rgba(255, 255, 255, 0.05);
    transform: scale(1.08);
  }
  .sp-sticker img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: 0.25rem;
  }
  .sp-empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1.5rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .sp-empty-sub { font-size: 0.7rem; opacity: 0.6; }
  @media (max-width: 768px) {
    .sp {
      width: calc(100vw - 2rem);
      left: 50%;
      transform: translateX(-50%);
    }
  }
</style>
