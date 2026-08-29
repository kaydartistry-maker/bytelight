<script lang="ts">
  let { label, value = 0, max = 5, onchange, size = 'md' }: {
    label: string;
    value: number;
    max?: number;
    onchange: (n: number) => void;
    size?: 'sm' | 'md';
  } = $props();

  function handleKey(e: KeyboardEvent, n: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); onchange(Math.min(n + 1, max)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); onchange(Math.max(n - 1, 1)); }
  }
</script>

<div class="rating" class:sm={size === 'sm'} role="radiogroup" aria-label="{label} rating">
  <span class="rating__label">{label}</span>
  <div class="rating__pills">
    {#each Array.from({ length: max }, (_, i) => i + 1) as n}
      <button
        class="rating__pill"
        class:active={value === n}
        role="radio"
        aria-checked={value === n}
        aria-label="{n} out of {max}"
        tabindex={value === n || (value === 0 && n === 1) ? 0 : -1}
        onclick={() => onchange(n)}
        onkeydown={(e) => handleKey(e, n)}
      >{n}</button>
    {/each}
  </div>
</div>

<style>
  .rating {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-height: 44px;
  }

  .rating__label {
    font-size: var(--text-base);
    color: var(--text-secondary);
    min-width: 5.5rem;
    flex-shrink: 0;
  }

  .rating__pills {
    display: flex;
    gap: var(--space-3);
  }

  .rating__pill {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--text-base);
    font-weight: 500;
    font-family: var(--font-body);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    -webkit-tap-highlight-color: transparent;
  }

  .rating__pill:hover:not(.active) {
    background: var(--bg-hover);
    border-color: var(--border-hover);
  }

  .rating__pill.active {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
    font-weight: 700;
  }

  .rating__pill:active {
    transform: scale(0.93);
  }

  .rating__pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Small variant */
  .sm .rating__pill { width: 36px; height: 36px; font-size: var(--text-sm); }
  .sm .rating__label { font-size: var(--text-sm); min-width: 4rem; }

  @media (max-width: 480px) {
    .rating { flex-wrap: wrap; }
    .rating__label { min-width: auto; width: 100%; }
  }
</style>
