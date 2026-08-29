import type { NormalizedImage, NormalizedMessage } from '../runtimes/types.js';

/** Attach turn-local images to exactly the current user entry. */
export function attachImagesToLatestUserMessage(
  messages: readonly NormalizedMessage[],
  images: readonly NormalizedImage[],
  fallbackContent: string,
  now: () => string = () => new Date().toISOString(),
): NormalizedMessage[] {
  const result = messages.map((message) => ({ ...message }));
  const latest = result[result.length - 1];
  if (latest?.role === 'user' && latest.content === fallbackContent) {
    result[result.length - 1] = images.length > 0
      ? { ...latest, images: [...images] }
      : latest;
    return result;
  }

  // Persisted web attachment rows may follow the caption row. Append the
  // actual dispatched prompt so mixed text and images stay in one message.
  result.push({
    role: 'user',
    content: fallbackContent,
    createdAt: now(),
    ...(images.length > 0 ? { images: [...images] } : {}),
  });
  return result;
}
