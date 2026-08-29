<script lang="ts">
  import { send, getVoiceModeEnabled } from '$lib/stores/websocket.svelte';

  let voiceMode = $derived(getVoiceModeEnabled());

  // AudioContext for iOS unlock
  let audioCtx: AudioContext | null = null;

  function toggle() {
    const newState = !voiceMode;
    send({ type: 'voice_mode', enabled: newState });

    // On enable, unlock iOS AudioContext via user gesture
    if (newState && !audioCtx) {
      try {
        audioCtx = new AudioContext();
        // Play a silent buffer to unlock
        const buffer = audioCtx.createBuffer(1, 1, 22050);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
      } catch {
        // AudioContext not available — not critical
      }
    }
  }
</script>

<button
  class="voice-mode-toggle"
  class:active={voiceMode}
  onclick={toggle}
  aria-label={voiceMode ? 'Disable voice mode' : 'Enable voice mode'}
  title={voiceMode ? 'Voice mode ON — Bytelight speaks replies' : 'Voice mode OFF'}
>
  {#if voiceMode}
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>
  {:else}
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <line x1="23" y1="9" x2="17" y2="15"/>
      <line x1="17" y1="9" x2="23" y2="15"/>
    </svg>
  {/if}
</button>

<style>
  .voice-mode-toggle {
    padding: 0.75rem;
    color: var(--text-muted);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .voice-mode-toggle:hover {
    color: var(--gold-dim);
    background: var(--gold-ember);
  }

  .voice-mode-toggle.active {
    color: var(--gold);
  }

  @media (max-width: 768px) {
    .voice-mode-toggle {
      padding: 0.5rem;
    }
  }
</style>
