<script lang="ts">
  let { message, actionLabel = '', onaction }: {
    message: string;
    actionLabel?: string;
    onaction?: () => void;
  } = $props();
</script>

<div class="res-empty">
  <svg class="res-empty__icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="8" y1="15" x2="16" y2="15"/>
    <line x1="9" y1="9" x2="9.01" y2="9"/>
    <line x1="15" y1="9" x2="15.01" y2="9"/>
  </svg>
  <p class="res-empty__message">{message}</p>
  {#if actionLabel && onaction}
    <button class="res-btn res-btn--ghost" onclick={onaction}>{actionLabel}</button>
  {/if}
</div>
