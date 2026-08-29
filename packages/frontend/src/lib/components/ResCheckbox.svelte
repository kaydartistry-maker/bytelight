<script lang="ts">
  let { checked = false, onchange, label = '', strikethrough = true }: {
    checked: boolean;
    onchange: () => void;
    label?: string;
    strikethrough?: boolean;
  } = $props();

  function handleKey(e: KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onchange(); }
  }
</script>

<button
  class="checkbox"
  class:checked
  class:has-label={!!label}
  role="checkbox"
  aria-checked={checked}
  aria-label={label || 'Toggle'}
  onclick={onchange}
  onkeydown={handleKey}
>
  <span class="checkbox__box">
    {#if checked}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    {/if}
  </span>
  {#if label}
    <span class="checkbox__label" class:struck={checked && strikethrough}>{label}</span>
  {/if}
</button>

<style>
  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 44px;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    background: none;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-body);
    text-align: left;
    transition: background var(--transition);
  }

  .checkbox.has-label {
    width: 100%;
    -webkit-tap-highlight-color: transparent;
  }

  .checkbox:hover {
    background: var(--bg-hover);
  }

  .checkbox:active {
    background: var(--bg-active);
  }

  .checkbox:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .checkbox.checked {
    opacity: 0.55;
  }

  .checkbox__box {
    width: 22px;
    height: 22px;
    border: 2px solid var(--border-hover);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--accent);
    transition: all var(--transition);
  }

  .checked .checkbox__box {
    border-color: var(--accent);
    background: var(--gold-ember);
  }

  .checkbox__label {
    font-size: var(--text-base);
    line-height: 1.4;
  }

  .checkbox__label.struck {
    text-decoration: line-through;
  }
</style>
