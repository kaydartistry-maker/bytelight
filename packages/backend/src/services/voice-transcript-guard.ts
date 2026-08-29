/**
 * Whole-utterance Whisper hallucination guard.
 *
 * Groq Whisper occasionally substitutes a stock video sign-off for speech it
 * couldn't hear — "Thank you for watching" replaced two real utterances on
 * Jul 21, 2026. The guard only fires when the ENTIRE transcript (after
 * normalization) is one of the known stock phrases, optionally repeated —
 * a genuine sentence that merely contains one of them always passes through.
 */

const STOCK_PHRASES = [
  'thank you for watching',
  'thanks for watching',
  'thank you so much for watching',
  'thank you for watching and see you in the next video',
  'see you in the next video',
  'dont forget to like and subscribe',
  'please like and subscribe',
  'like and subscribe',
  'please subscribe',
  'subtitles by the amara org community',
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns the matched stock phrase when the whole transcript is a known
 * Whisper hallucination (possibly looped back-to-back), otherwise null.
 */
export function detectWhisperHallucination(transcript: string): string | null {
  const normalized = normalize(transcript);
  if (!normalized) return null;
  for (const phrase of STOCK_PHRASES) {
    if (normalized === phrase) return phrase;
    if (new RegExp(`^(?:${phrase} )+${phrase}$`).test(normalized)) return phrase;
  }
  return null;
}
