<!-- Adapted for byte-light under Apache 2.0
     (theme vars: accent-paint/divider-color/accent-soft/bg-selected mapped to
     byte-light's accent/border/bg-hover/bg-active; gradient title → solid accent). -->
<script lang="ts">
  // Small text-input modal, styled to match ConfirmDialog. Used for naming /
  // renaming things (e.g. Studio reference drawers).
  let {
    open = $bindable(false),
    title = 'Name',
    placeholder = '',
    value = $bindable(''),
    showEmoji = false,
    emoji = $bindable(''),
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    title?: string;
    placeholder?: string;
    value?: string;
    showEmoji?: boolean;
    emoji?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onconfirm?: (value: string, emoji?: string) => void;
    oncancel?: () => void;
  } = $props();

  let inputEl = $state<HTMLInputElement | undefined>();
  $effect(() => {
    if (open && inputEl) { inputEl.focus(); inputEl.select(); }
  });

  function confirm() {
    const v = value.trim();
    if (v) onconfirm?.(v, showEmoji ? (emoji.trim() || undefined) : undefined);
  }
  function cancel() { oncancel?.(); }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  }
</script>

{#if open}
  <div class="confirm-overlay" role="dialog" aria-modal="true" onkeydown={onKey}>
    <button class="confirm-backdrop" onclick={cancel} aria-label="Close"></button>
    <div class="confirm-panel">
      <h3 class="confirm-title">{title}</h3>
      {#if showEmoji}
        <div class="modal-row">
          <input class="emoji-input" bind:value={emoji} placeholder="🙂" maxlength="6" aria-label="Emoji (optional)" />
          <input class="modal-input flush" bind:this={inputEl} bind:value {placeholder} />
        </div>
        <p class="modal-hint">Pick an emoji (optional) — leave it blank for none.</p>
      {:else}
        <input class="modal-input" bind:this={inputEl} bind:value {placeholder} />
      {/if}
      <div class="confirm-actions">
        <button type="button" class="btn btn-ghost" onclick={cancel}>{cancelLabel}</button>
        <button type="button" class="btn btn-primary" onclick={confirm} disabled={!value.trim()}>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center; padding: 1rem;
  }
  .confirm-backdrop {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px);
    border: none; padding: 0; cursor: pointer;
  }
  .confirm-panel {
    position: relative; width: 100%; max-width: 380px;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: var(--radius-md, 0.75rem);
    box-shadow: 0 20px 50px -10px rgba(0, 0, 0, 0.5);
    padding: 1.25rem 1.25rem 1rem;
    animation: confirm-pop 0.12s ease-out;
  }
  @keyframes confirm-pop {
    from { opacity: 0; transform: scale(0.96) translateY(4px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
  .confirm-title {
    font-family: var(--font-heading, inherit);
    font-size: 1rem; font-weight: 600;
    color: var(--accent);
    margin: 0 0 0.75rem; padding-bottom: 0.625rem;
    border-bottom: 1px solid var(--border);
    letter-spacing: -0.01em;
  }
  .modal-input {
    width: 100%; box-sizing: border-box;
    background: var(--bg-primary); border: 1px solid var(--border);
    color: var(--text-primary); border-radius: var(--radius-sm);
    padding: 0.5rem 0.7rem; font-size: 0.875rem; font-family: inherit;
    margin-bottom: 1.25rem;
  }
  .modal-input:focus { outline: none; border-color: var(--accent); }
  .modal-input.flush { margin-bottom: 0; }
  .modal-row { display: flex; gap: 0.5rem; align-items: stretch; margin-bottom: 0.5rem; }
  .emoji-input {
    width: 2.75rem; flex-shrink: 0; text-align: center;
    background: var(--bg-primary); border: 1px solid var(--border);
    color: var(--text-primary); border-radius: var(--radius-sm);
    padding: 0.5rem 0.3rem; font-size: 1.1rem; font-family: inherit;
  }
  .emoji-input:focus { outline: none; border-color: var(--accent); }
  .modal-hint { font-size: 0.75rem; color: var(--text-muted); margin: 0 0 1.1rem; }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  .btn {
    padding: 0.5rem 0.875rem; font-size: 0.8125rem; font-weight: 500;
    border: 1px solid transparent; border-radius: var(--radius-sm, 0.5rem);
    cursor: pointer; min-height: 36px;
    transition: background var(--transition-fast, 120ms), color var(--transition-fast, 120ms), border-color var(--transition-fast, 120ms);
  }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn-ghost { background: transparent; color: var(--text-muted); border-color: var(--border); }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--accent); border-color: var(--accent); }
  .btn-primary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .btn-primary:hover:not(:disabled) { background: var(--bg-hover); }
  @media (max-width: 480px) {
    .confirm-actions { flex-direction: column-reverse; }
    .btn { width: 100%; min-height: 42px; font-size: 0.9rem; }
  }
</style>
