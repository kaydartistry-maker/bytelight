/**
 * Automatic local embeddings are opt-in. The ONNX runtime can reserve more
 * than 1GB of native memory on first inference, so ordinary message delivery
 * and autonomous wakes must not start it implicitly.
 *
 * Explicit semantic search/backfill remains available; this policy governs
 * only the fire-and-forget indexing attached to createMessage().
 */
export const AUTO_EMBED_CONFIG_KEY = 'semantic_search.auto_embed';

export function automaticEmbeddingsEnabled(value: string | null | undefined): boolean {
  return value === 'true';
}

export function shouldAutomaticallyEmbed(input: {
  setting: string | null | undefined;
  role: 'companion' | 'user' | 'system';
  contentType?: 'text' | 'image' | 'audio' | 'file';
  contentLength: number;
}): boolean {
  return automaticEmbeddingsEnabled(input.setting)
    && input.role !== 'system'
    && (!input.contentType || input.contentType === 'text')
    && input.contentLength > 10;
}
