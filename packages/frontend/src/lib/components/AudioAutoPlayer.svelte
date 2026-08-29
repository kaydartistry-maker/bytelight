<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getTtsAudioQueue, dequeueTtsAudio, setTtsPlaying, getVoiceModeEnabled } from '$lib/stores/websocket.svelte';

  let audioCtx: AudioContext | null = null;
  let playing = false;
  let checkInterval: ReturnType<typeof setInterval> | null = null;

  function ensureAudioContext(): AudioContext {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  async function playNextInQueue() {
    if (playing) return;

    const item = dequeueTtsAudio();
    if (!item) return;

    // Only play if voice mode is still enabled
    if (!getVoiceModeEnabled()) {
      setTtsPlaying(false);
      return;
    }

    playing = true;
    setTtsPlaying(true);

    try {
      const ctx = ensureAudioContext();

      // Decode base64 MP3 to ArrayBuffer
      const binaryString = atob(item.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      source.onended = () => {
        playing = false;
        // Check if more audio is queued
        if (getTtsAudioQueue().length > 0) {
          playNextInQueue();
        } else {
          setTtsPlaying(false);
        }
      };

      source.start(0);
    } catch (err) {
      console.error('[AudioAutoPlayer] Playback error:', err);
      playing = false;
      setTtsPlaying(false);
    }
  }

  onMount(() => {
    // Poll queue for new audio chunks
    checkInterval = setInterval(() => {
      if (!playing && getTtsAudioQueue().length > 0 && getVoiceModeEnabled()) {
        playNextInQueue();
      }
    }, 100);
  });

  onDestroy(() => {
    if (checkInterval) clearInterval(checkInterval);
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close();
    }
  });
</script>

<!-- Invisible component — handles TTS audio playback -->
