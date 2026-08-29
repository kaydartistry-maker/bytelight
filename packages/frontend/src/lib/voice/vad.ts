// Pure voice-activity-detection math for the conversation recorder. Kept free
// of any DOM or store import so the turn-end logic is unit-testable in
// isolation (recorder.ts consumes these; recorder.vad.test.ts pins them).

/**
 * Adaptive speech threshold. Tracks a noise floor during calibration, then
 * scales it up with a floor and ceiling so a fan or a noisy calibration
 * window can neither hide speech nor make silence read as speech.
 */
export function computeThreshold(noiseFloor: number): number {
  return Math.max(0.018, Math.min(0.08, noiseFloor * 2.4 + 0.006));
}

/** Update the running noise floor during the calibration window (EMA). */
export function updateNoiseFloor(current: number, rms: number): number {
  return current * 0.88 + rms * 0.12;
}

/** Root-mean-square of a time-domain sample block — the loudness proxy. */
export function computeRms(samples: Float32Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * The turn-end decision, factored out of the animation frame. Given the VAD's
 * timing state and the elapsed clock, decide whether to keep listening, stop
 * (a complete utterance), or time out (heard nothing before the wait cap).
 */
export interface VadTimingState {
  heardSpeech: boolean;
  speechStartedAt: number;
  lastSpeechAt: number;
  startedAt: number;
}
export interface VadThresholds {
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  maxWaitForSpeechMs?: number;
}
export type VadDecision = 'continue' | 'stop' | 'timeout';

export function decideVad(state: VadTimingState, thresholds: VadThresholds, now: number): VadDecision {
  if (
    !state.heardSpeech
    && thresholds.maxWaitForSpeechMs !== undefined
    && now - state.startedAt >= thresholds.maxWaitForSpeechMs
  ) {
    return 'timeout';
  }
  if (
    state.heardSpeech
    && now - state.speechStartedAt >= thresholds.minSpeechMs
    && now - state.lastSpeechAt >= thresholds.silenceMs
  ) {
    return 'stop';
  }
  if (state.heardSpeech && now - state.speechStartedAt >= thresholds.maxUtteranceMs) {
    return 'stop';
  }
  return 'continue';
}
