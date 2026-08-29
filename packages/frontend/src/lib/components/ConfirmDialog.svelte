<script lang="ts">
  let {
    open = false,
    title = 'Are you sure?',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onconfirm?: () => void;
    oncancel?: () => void;
  } = $props();

  function handleOverlayClick() {
    oncancel?.();
  }

  function handleDialogClick(e: MouseEvent) {
    e.stopPropagation();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      oncancel?.();
    }
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="confirm-overlay" onclick={handleOverlayClick} role="dialog" aria-modal="true" aria-label={title}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="confirm-dialog" onclick={handleDialogClick}>
      <h3 class="confirm-title">{title}</h3>
      {#if message}
        <p class="confirm-message">{message}</p>
      {/if}
      <div class="confirm-actions">
        <button class="res-btn res-btn--ghost res-btn--sm" onclick={oncancel}>{cancelLabel}</button>
        <button class="res-btn res-btn--sm" class:res-btn--danger={destructive} class:res-btn--primary={!destructive} onclick={onconfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
    animation: overlay-fade 0.15s ease-out;
  }

  .confirm-dialog {
    background: var(--bg-surface, #1d202a);
    border: 1px solid var(--border, #2a2d3a);
    border-radius: var(--radius, 0.875rem);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.4));
    padding: 1.5rem;
    min-width: min(320px, 90vw);
    max-width: 420px;
    animation: dialog-scale 0.15s ease-out;
  }

  .confirm-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary, #e0e0e0);
    margin: 0 0 0.5rem;
  }

  .confirm-message {
    font-size: 0.875rem;
    color: var(--text-secondary, #aaa);
    margin: 0 0 1.25rem;
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.625rem;
  }

  @keyframes overlay-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes dialog-scale {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
