// Call-mode capture correlation + caps (reference implementation s3).
//
// Pure, dependency-free helpers factored out of ws.ts so the recordingId
// supersede/discard rule can be unit-tested without importing the WebSocket
// server (and its heavy agent/runtime dependency chain).

// At the opted-in 100ms cadence this allows five minutes of one uninterrupted
// utterance while still bounding frames that bypass the general WS rate cap.
export const MAX_AUDIO_CHUNKS_PER_RECORDING = 3_000;
export const MAX_AUDIO_BUFFER_SIZE = 25 * 1024 * 1024; // 25MB security cap

/**
 * A frame belongs to the active recording when it carries no id (legacy
 * clients) or an id that matches the one voice_start opened. A stale id from a
 * superseded recording is dropped so an older result can never land on a newer
 * turn.
 */
export function matchesActiveRecording(
  ws: { activeRecordingId: string | null },
  recordingId: unknown,
): boolean {
  return recordingId === undefined || (
    typeof recordingId === 'string'
    && (!ws.activeRecordingId || recordingId === ws.activeRecordingId)
  );
}

/**
 * Normalize a client-supplied audio MIME type. Rejects anything that isn't a
 * plausible `audio/*` (optionally with a codecs parameter), falling back to
 * webm — the browser MediaRecorder default.
 */
export function safeAudioMimeType(value?: string): string {
  const candidate = value?.trim().toLowerCase();
  if (!candidate || candidate.length > 100) return 'audio/webm';
  return /^audio\/[a-z0-9.+-]+(?:;\s*codecs=[a-z0-9.,_+-]+)?$/.test(candidate)
    ? candidate
    : 'audio/webm';
}
