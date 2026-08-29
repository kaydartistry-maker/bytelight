// Web TTS playback for the live voice-call loop. Call playback rides
// HTMLAudioElement (new Audio() + .play()) because that is the phone-proven
// media channel in this app: it is exactly what the read-aloud button in
// MessageBubble.svelte uses, and that path plays reliably on the operator's phone every
// day. WebAudio (AudioContext) silently no-ops under mobile mute-switch / dim /
// background-audio policies — it ran the call phases normally while producing
// total silence — so the call path must not depend on it. Read-aloud parity is
// the constraint of record here.
//
// A single reusable Audio element owns all voice output, so a fresh play()
// implicitly interrupts whatever it was doing. Each reply's ordered
// per-companion segment URLs play strictly in order, chained on 'ended'.
// Segment GETs are generated on demand server-side and can be slow, so each
// segment waits for its own 'canplay' before it starts rather than playing
// half-buffered — this matches how reference implementation's Android path sequenced media. A
// tap aborts mid-sentence (pause + clear src + AbortError) and hands the mic
// straight back to the caller.
//
// Behavioral translation of reference implementation's phone voice-playback — WEB PATH ONLY.
// HTTP goes through byte-light's apiFetch (session cookies) for the manifest;
// the audio element loads same-origin segment URLs directly.

import { apiFetch } from '$lib/utils/api';
import {
  parseTtsStreamResponse,
  isStreamRouteUnavailableStatus,
  type MessageTtsStreamResponse,
} from './tts-manifest';

export type { MessageTtsStreamSegment, MessageTtsStreamResponse } from './tts-manifest';

export interface MessageTtsResponse {
  success: boolean;
  cached?: boolean;
  fileId?: string;
  url: string;
}

// A short REAL silent WAV (8000 Hz mono 16-bit, 160 samples ≈ 20 ms of
// silence). Playing it while the user gesture is still active unlocks later
// async .play() calls on mobile — same trick as read-aloud. The prior data URL
// had a zero-length data chunk (empty PCM); some mobile decoders reject an
// empty media buffer, so the unlock play() never resolved and later autoplay
// stayed locked. This carries a valid RIFF/WAVE header + real silent PCM.
const SILENT_WAV = 'data:audio/wav;base64,UklGRmQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

let audioEl: HTMLAudioElement | null = null;
let playbackGeneration = 0;

class MessageTtsStreamRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'MessageTtsStreamRequestError';
    this.status = status;
  }
}

/** True only when the running backend predates the optional stream route. */
export function isMessageTtsStreamUnavailable(error: unknown): boolean {
  return error instanceof MessageTtsStreamRequestError
    && isStreamRouteUnavailableStatus(error.status);
}

function abortError(): DOMException {
  return new DOMException('Voice playback interrupted', 'AbortError');
}

/**
 * The single reusable Audio element. Created lazily so this module stays
 * import-safe during SSR; every call reuses the same element so a fresh
 * play() implicitly interrupts whatever it was doing.
 */
function getAudioElement(): HTMLAudioElement {
  if (audioEl) return audioEl;
  if (typeof window === 'undefined' || typeof Audio === 'undefined') {
    throw new Error('Voice playback is only available in the browser');
  }
  audioEl = new Audio();
  audioEl.preload = 'auto';
  // Guarantee audible output: a fresh element defaults to volume 1 / unmuted,
  // but pin it so nothing (a stale ref, a mobile quirk) leaves the call silent.
  audioEl.volume = 1;
  audioEl.muted = false;
  return audioEl;
}

/**
 * Prime the shared Audio element from a user gesture, exactly like
 * MessageBubble's read-aloud silent unlock: play a silent WAV while the
 * gesture is still active so later async plays (after the agent + TTS
 * roundtrip) are allowed by mobile autoplay policy. Call this directly in the
 * button handler that opens the call; the overlay also calls it as a
 * best-effort fallback.
 */
export async function unlockVoicePlayback(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return false;
  const audio = getAudioElement();
  audio.src = SILENT_WAV;
  // Let a rejected play() PROPAGATE. If the browser refuses this gesture-time
  // unlock, later autoplay is locked too — the overlay's callers catch the
  // throw and fall to a tap-to-start 'ready' (auto path) or 'error' (gesture
  // path) instead of a call that runs its phases in silence.
  await audio.play();
  // Unlock succeeded: clear the element so the primed silent buffer never
  // lingers as the first thing a real segment plays over.
  try {
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load();
  } catch { /* best effort — element is unlocked regardless */ }
  return true;
}

/** Stop the current voice-mode playback immediately. */
export function stopVoicePlayback(): void {
  playbackGeneration += 1;
  const audio = audioEl;
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  audio.oncanplay = null;
  try { audio.pause(); } catch { /* already paused */ }
  // Removing the source stops any in-flight network load for the segment.
  try { audio.removeAttribute('src'); audio.load(); } catch { /* best effort */ }
}

/**
 * End-of-call teardown. HTMLAudioElement has no context to suspend, so this is
 * simply a hard stop; the next explicit open gesture calls unlockVoicePlayback()
 * again before a session starts. Kept async to preserve the call site.
 */
export async function suspendVoicePlayback(): Promise<void> {
  stopVoicePlayback();
}

/**
 * Fallback for backends that predate the stream route: ask the existing
 * read-aloud route for the cached, correctly split multi-companion MP3.
 */
export async function requestMessageTts(
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageTtsResponse> {
  const response = await apiFetch(`/api/messages/${encodeURIComponent(messageId)}/tts`, {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || `Voice render failed: HTTP ${response.status}`);
  }

  const data = await response.json() as Partial<MessageTtsResponse>;
  if (!data.url) throw new Error('Voice render did not return an audio URL');
  return { ...data, success: data.success !== false, url: data.url };
}

/**
 * Ask for an ordered voice manifest. Fresh replies expose one URL per
 * companion so playback starts before a combined multi-voice file exists;
 * cached replies may return their existing combined URL instead.
 */
export async function requestMessageTtsStream(
  messageId: string,
  signal?: AbortSignal,
): Promise<MessageTtsStreamResponse> {
  const response = await apiFetch(`/api/messages/${encodeURIComponent(messageId)}/tts/stream`, {
    method: 'POST',
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new MessageTtsStreamRequestError(
      data.error || `Voice stream failed: HTTP ${response.status}`,
      response.status,
    );
  }

  const data = await response.json() as unknown;
  return parseTtsStreamResponse(data);
}

/**
 * Play one same-origin segment URL on the shared Audio element and resolve
 * when it finishes. Waits for 'canplay' before starting because on-demand
 * segment GETs can be slow, then awaits 'ended'. Rejects with an AbortError on
 * signal abort (so isAbort handling stays intact) and on element 'error'.
 */
function playSegment(
  url: string,
  audio: HTMLAudioElement,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      audio.oncanplay = null;
      audio.onended = null;
      audio.onerror = null;
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      try { audio.pause(); } catch { /* already paused */ }
      try { audio.removeAttribute('src'); audio.load(); } catch { /* best effort */ }
      finish(abortError());
    };

    if (signal.aborted || generation !== playbackGeneration) {
      finish(abortError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    audio.onended = () => finish();
    audio.onerror = () => finish(new Error(`Could not load voice audio: ${url}`));
    audio.oncanplay = () => {
      if (settled) return;
      // Ready to play through: start now. A rejected play() (autoplay policy /
      // torn-down src) surfaces as an error so the sequence can react.
      audio.play().catch((error) => {
        if (signal.aborted || generation !== playbackGeneration) finish(abortError());
        else finish(error);
      });
    };

    audio.src = url;
    // Kick the load explicitly; on some mobile browsers setting src alone does
    // not begin buffering until a play() is attempted.
    try { audio.load(); } catch { /* best effort */ }
  });
}

/**
 * Fetch and play one same-origin voice file through the shared Audio element.
 * A new call always interrupts the prior one, making this the single playback
 * owner for voice conversations.
 */
export async function playVoiceUrl(url: string, signal?: AbortSignal): Promise<void> {
  return playVoiceSequence([url], signal);
}

/**
 * Play a manifest's URLs in order under one interruptible playback owner.
 * Segments play strictly in order on the shared element, chained on 'ended';
 * each waits for its own 'canplay' before starting so a slow on-demand render
 * never plays half-buffered.
 */
export async function playVoiceSequence(urls: string[], signal?: AbortSignal): Promise<void> {
  const playableUrls = urls.filter(url => typeof url === 'string' && url.length > 0);
  if (playableUrls.length === 0) throw new Error('Voice playback did not receive any audio');

  stopVoicePlayback();
  const generation = playbackGeneration;
  const audio = getAudioElement();

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();
    for (const url of playableUrls) {
      if (controller.signal.aborted || generation !== playbackGeneration) throw abortError();
      await playSegment(url, audio, controller.signal, generation);
    }
  } catch (error) {
    const interrupted = controller.signal.aborted
      || signal?.aborted
      || generation !== playbackGeneration;
    if (!controller.signal.aborted) controller.abort();
    if (interrupted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
  }
}
