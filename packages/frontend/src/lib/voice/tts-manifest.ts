// Pure parsing/normalization for the TTS stream manifest. Kept free of any
// DOM/network import so the segment-ordering and fallback-detection logic is
// unit-testable (playback.ts consumes these; tts-manifest.test.ts pins them).

export interface MessageTtsStreamSegment {
  index: number;
  voice?: string;
  url: string;
}

export interface MessageTtsStreamResponse {
  success: boolean;
  cached?: boolean;
  /**
   * Always normalized to playback order. A cached combined render is exposed
   * as one segment so callers have a single playback path.
   */
  segments: MessageTtsStreamSegment[];
}

/** HTTP statuses that mean "this backend has no stream route" → use /tts. */
export function isStreamRouteUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * Normalize a raw /tts/stream JSON body into an ordered segment manifest.
 * Segments sort by their declared index (stable on ties via original
 * position), drop entries with no URL, and a bare cached combined `url` with
 * no segment list becomes a single playback segment.
 *
 * Throws when there is nothing playable at all.
 */
export function parseTtsStreamResponse(data: unknown): MessageTtsStreamResponse {
  const body = (data ?? {}) as {
    success?: boolean;
    cached?: boolean;
    url?: unknown;
    segments?: Array<{ index?: unknown; voice?: unknown; url?: unknown }>;
  };

  const segments: MessageTtsStreamSegment[] = Array.isArray(body.segments)
    ? body.segments
      .map((segment, position) => ({
        index: typeof segment.index === 'number' && Number.isFinite(segment.index)
          ? segment.index
          : position,
        voice: typeof segment.voice === 'string' ? segment.voice : undefined,
        url: typeof segment.url === 'string' ? segment.url : '',
        position,
      }))
      .filter(segment => Boolean(segment.url))
      .sort((left, right) => left.index - right.index || left.position - right.position)
      .map(({ index, voice, url }) => ({ index, voice, url }))
    : [];

  // A cached combined file is already correctly ordered and should not be
  // split again. Prefer it when the server returns no fresh segment list.
  if (segments.length === 0 && typeof body.url === 'string' && body.url) {
    segments.push({ index: 0, url: body.url });
  }
  if (segments.length === 0) throw new Error('Voice stream did not return any audio');

  return {
    success: body.success !== false,
    cached: body.cached,
    segments,
  };
}
