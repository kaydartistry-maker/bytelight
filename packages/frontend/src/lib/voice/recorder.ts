// Browser microphone capture for the live voice-call loop and composer
// dictation. MediaRecorder streams encoded chunks over the existing
// WebSocket; an optional local VAD (voice-activity detector) ends a
// conversation turn a beat after the speaker stops.
//
// Behavioral translation of reference implementation's phone voice-recorder (web path only —
// there is nothing native to drop here). byte-light difference: the recorder
// does NOT own transcription UI state. The websocket store is the single
// owner of `transcription_status` (it arrives from the backend), so this
// module only emits the voice_* control/data frames and reports progress via
// callbacks. recordingId correlation is preserved end-to-end.

import { send } from '$lib/stores/websocket.svelte';
import {
  computeThreshold,
  updateNoiseFloor,
  computeRms,
  decideVad,
} from './vad';

export type VoiceRecordingMode = 'dictation' | 'conversation';

export interface VoiceRecordingOptions {
  mode?: VoiceRecordingMode;
  /** Opt in to the server-side tone sidecar for this utterance. */
  analyzeTone?: boolean;
  autoStopOnSilence?: boolean;
  silenceMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
  maxWaitForSpeechMs?: number;
  maxCaptureMs?: number;
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onSpeechTimeout?: () => void;
}

// --- Module state ---

let mediaRecorder: MediaRecorder | null = null;
let activeStream: MediaStream | null = null;
let activeRecordingId: string | null = null;
let pendingTranscriptionId: string | null = null;
let suppressStopFrame = false;
let audioContext: AudioContext | null = null;
let analyserFrame: number | null = null;
let levelCallback: ((level: number) => void) | null = null;
let captureGeneration = 0;
let startingGeneration: number | null = null;

function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return 'audio/webm';
  }
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export function makeRecordingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function stopAnalyser(): void {
  if (analyserFrame !== null) cancelAnimationFrame(analyserFrame);
  analyserFrame = null;
  levelCallback?.(0);
  levelCallback = null;
  if (audioContext && audioContext.state !== 'closed') {
    void audioContext.close().catch(() => {});
  }
  audioContext = null;
}

function beginVoiceActivityDetection(
  stream: MediaStream,
  recorder: MediaRecorder,
  recordingId: string,
  options: VoiceRecordingOptions,
): boolean {
  if (!options.autoStopOnSilence) return false;

  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) return false;

  let analyser: AnalyserNode;
  try {
    audioContext = new AudioContextCtor();
    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => {
        /* The initial call gesture normally unlocks this; levels stay at zero
           until the browser grants it if a stricter context is in play. */
      });
    }
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);
  } catch {
    stopAnalyser();
    return false;
  }

  const samples = new Float32Array(analyser.fftSize);
  const startedAt = performance.now();
  const calibrationUntil = startedAt + 600;
  const silenceMs = options.silenceMs ?? 1150;
  const minSpeechMs = options.minSpeechMs ?? 250;
  const maxUtteranceMs = options.maxUtteranceMs ?? 90_000;
  const maxWaitForSpeechMs = options.maxWaitForSpeechMs;
  let noiseFloor = 0.006;
  let speechFrames = 0;
  let speechStartedAt = 0;
  let lastSpeechAt = 0;
  let heardSpeech = false;
  let lastLevelAt = 0;
  levelCallback = options.onLevel || null;

  const tick = () => {
    if (activeRecordingId !== recordingId || recorder.state !== 'recording') return;

    analyser.getFloatTimeDomainData(samples);
    const rms = computeRms(samples);
    const now = performance.now();

    if (!heardSpeech && now < calibrationUntil) {
      noiseFloor = updateNoiseFloor(noiseFloor, rms);
    }
    const threshold = computeThreshold(noiseFloor);

    if (now - lastLevelAt >= 50) {
      levelCallback?.(Math.min(1, rms / Math.max(threshold * 1.8, 0.001)));
      lastLevelAt = now;
    }

    if (rms >= threshold) {
      speechFrames += 1;
      lastSpeechAt = now;
      if (!heardSpeech && speechFrames >= 3) {
        heardSpeech = true;
        speechStartedAt = now;
        options.onSpeechStart?.();
      }
    } else {
      speechFrames = Math.max(0, speechFrames - 1);
    }

    const decision = decideVad(
      { heardSpeech, speechStartedAt, lastSpeechAt, startedAt },
      { silenceMs, minSpeechMs, maxUtteranceMs, maxWaitForSpeechMs },
      now,
    );
    if (decision === 'timeout') {
      cancelSpecificRecording(recorder, recordingId);
      options.onSpeechTimeout?.();
      return;
    }
    if (decision === 'stop') {
      stopSpecificRecording(recorder, recordingId);
      return;
    }

    analyserFrame = requestAnimationFrame(tick);
  };

  analyserFrame = requestAnimationFrame(tick);
  return true;
}

function releaseCapture(recordingId: string, stream: MediaStream, recorder: MediaRecorder): void {
  // Always close this capture's own stream, never whichever stream happens
  // to be in the global slot by the time async Blob conversion finishes.
  stream.getTracks().forEach((track) => track.stop());
  if (activeRecordingId !== recordingId) return;
  stopAnalyser();
  if (activeStream === stream) activeStream = null;
  if (mediaRecorder === recorder) mediaRecorder = null;
  activeRecordingId = null;
  suppressStopFrame = false;
}

function stopSpecificRecording(recorder: MediaRecorder, recordingId: string): void {
  if (activeRecordingId !== recordingId || recorder.state === 'inactive') return;
  stopAnalyser();
  recorder.stop();
}

function cancelSpecificRecording(recorder: MediaRecorder, recordingId: string): void {
  if (activeRecordingId !== recordingId || recorder.state === 'inactive') return;
  suppressStopFrame = true;
  stopAnalyser();
  recorder.stop();
}

export async function startVoiceRecording(options: VoiceRecordingOptions = {}): Promise<string> {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return activeRecordingId || '';
  if (activeRecordingId) {
    // The recorder has stopped but its final MediaRecorder blob is still
    // converting. Refuse a handoff until that capture releases instead of
    // letting old audio bleed into a new recording.
    throw new Error('The previous microphone turn is still closing');
  }
  if (startingGeneration !== null) return '';

  const generation = ++captureGeneration;
  startingGeneration = generation;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (startingGeneration === generation) startingGeneration = null;
    if (generation !== captureGeneration) return '';
    throw err;
  }

  if (generation !== captureGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    if (startingGeneration === generation) startingGeneration = null;
    return '';
  }
  if (startingGeneration === generation) startingGeneration = null;
  activeStream = stream;

  const mimeType = pickMimeType();
  const recordingId = makeRecordingId();
  activeRecordingId = recordingId;
  pendingTranscriptionId = null;
  suppressStopFrame = false;

  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(activeStream, { mimeType })
      : new MediaRecorder(activeStream);
  } catch (err) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
    activeRecordingId = null;
    throw err;
  }

  const captureStream = stream;
  const captureRecorder = mediaRecorder;
  const pendingChunkSends = new Set<Promise<void>>();
  let chunkSendChain: Promise<void> = Promise.resolve();
  let hardCaptureTimer: number | null = null;
  const analyzeTone = options.analyzeTone === true && isRealtimeToneRecordingSupported();
  const actualMimeType = captureRecorder.mimeType || mimeType || 'audio/webm';

  captureRecorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size === 0) return;
    // Short chunks must retain recorder order. ArrayBuffer conversion is
    // asynchronous, so serialize the sends instead of trusting completion
    // order when several blobs are in flight at once.
    const task = chunkSendChain
      .then(() => blobToBase64(event.data))
      .then((data) => send({ type: 'voice_audio', data, recordingId }))
      .catch(() => {
        /* one broken chunk should not tear down the microphone */
      });
    chunkSendChain = task;
    pendingChunkSends.add(task);
    void task.finally(() => {
      pendingChunkSends.delete(task);
    });
  });

  captureRecorder.addEventListener('stop', () => {
    if (hardCaptureTimer !== null) window.clearTimeout(hardCaptureTimer);
    hardCaptureTimer = null;
    pendingTranscriptionId = recordingId;
    const pending = Array.from(pendingChunkSends);
    void Promise.allSettled(pending).then(() => {
      const cancelled = suppressStopFrame;
      if (cancelled) {
        send({ type: 'voice_cancel', recordingId });
        pendingTranscriptionId = null;
      } else {
        send({ type: 'voice_stop', recordingId });
        pendingTranscriptionId = recordingId;
      }
      releaseCapture(recordingId, captureStream, captureRecorder);
    });
  });

  captureRecorder.addEventListener('error', () => {
    if (hardCaptureTimer !== null) window.clearTimeout(hardCaptureTimer);
    hardCaptureTimer = null;
    suppressStopFrame = true;
    send({ type: 'voice_cancel', recordingId });
  });

  // A 100ms cadence carries enough resolution for real-time tone analysis.
  // Keep the quieter 1s cadence everywhere else so ordinary dictation and
  // tone-disabled calls do not create unnecessary WebSocket traffic.
  try {
    captureRecorder.start(options.mode === 'conversation' && analyzeTone ? 100 : 1000);
  } catch (err) {
    releaseCapture(recordingId, captureStream, captureRecorder);
    throw err;
  }
  // Start the backend turn only after MediaRecorder has accepted the stream.
  // dataavailable cannot fire until a later task, so the header still follows
  // this control frame while a failed recorder never opens a paid tone socket.
  send({
    type: 'voice_start',
    mimeType: actualMimeType,
    mode: options.mode || 'dictation',
    recordingId,
    analyzeTone,
  });
  if (options.maxCaptureMs !== undefined) {
    hardCaptureTimer = window.setTimeout(() => {
      cancelSpecificRecording(captureRecorder, recordingId);
      options.onSpeechTimeout?.();
    }, options.maxCaptureMs);
  }
  const vadStarted = beginVoiceActivityDetection(captureStream, captureRecorder, recordingId, {
    ...options,
    onSpeechStart: () => {
      options.onSpeechStart?.();
    },
  });
  // If an apparently available AudioContext still fails to initialize, close
  // the just-opened optional tone turn immediately rather than leaving a paid
  // paused socket behind an unbounded recorder.
  if (analyzeTone && !vadStarted) {
    cancelSpecificRecording(captureRecorder, recordingId);
    options.onSpeechTimeout?.();
  }
  return recordingId;
}

export function stopVoiceRecording(): void {
  if (!mediaRecorder || !activeRecordingId) return;
  stopSpecificRecording(mediaRecorder, activeRecordingId);
}

export function cancelVoiceRecording(): void {
  captureGeneration += 1;
  const recordingId = activeRecordingId;
  if (!mediaRecorder || mediaRecorder.state === 'inactive' || !recordingId) {
    suppressStopFrame = true;
    const pendingId = recordingId || pendingTranscriptionId;
    if (pendingId) {
      send({ type: 'voice_cancel', recordingId: pendingId });
      pendingTranscriptionId = null;
    }
    stopAnalyser();
    activeStream?.getTracks().forEach((track) => track.stop());
    activeStream = null;
    return;
  }
  suppressStopFrame = true;
  cancelSpecificRecording(mediaRecorder, recordingId);
}

export function clearTranscription(): void {
  pendingTranscriptionId = null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    && typeof MediaRecorder !== 'undefined'
  );
}

export function isRealtimeToneRecordingSupported(): boolean {
  return isRecordingSupported() && !!getAudioContextConstructor();
}

export function isVoiceRecording(): boolean {
  return !!mediaRecorder && mediaRecorder.state === 'recording';
}
