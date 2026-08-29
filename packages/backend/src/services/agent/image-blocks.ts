/**
 * buildImageBlocksForPrompt — Slice 3.1 extraction of the sticker image
 * extraction + cap composition from agent.ts (formerly inline at lines
 * 912-915, sticker extraction + cap two-step).
 *
 * This is a sync composition seam, NOT a pure function. The default
 * extractor (stickerRefsToImageBlocks) performs DB lookups via
 * getStickerByRef and filesystem reads via fileToImageBlock — both live
 * in visual-blocks.ts. The seam exists so the agent.ts call site
 * composes the two-step (extract + cap) in a single call, and so tests
 * can inject pure stubs for the extractor and capper.
 *
 * Behavior preservation (extraction, not correction):
 *   - extractor defaults to stickerRefsToImageBlocks (regex match,
 *     dedupe, DB resolve, FS read, base64-encode)
 *   - capper defaults to capImageBlocks (MAX_IMAGES_PER_TURN=8,
 *     MAX_TOTAL_IMAGE_BYTES=25MB; first-in-first-kept)
 *   - result shape { kept, dropped } matches capImageBlocks output
 *   - no logging side effect inside the helper — the
 *     `[Agent] Dropped N sticker images (cap reached)` log stays at the
 *     agent.ts call site so it remains visible at the dispatch boundary
 *   - no provider/runtime branching; image extraction is identical
 *     across Claude / Codex / ApiRouter paths
 *
 * Not in scope:
 *   - changing cap thresholds (MAX_IMAGES_PER_TURN, MAX_TOTAL_IMAGE_BYTES)
 *   - changing the ImageBlock contract
 *   - non-sticker image sources (attachment-path images are handled
 *     separately via attachmentPathsToImageBlocks in visual-blocks.ts)
 *   - downstream consumption of imageBlocks (Claude SDK multimodal
 *     prompt construction stays at the agent.ts call site)
 */

import {
  capImageBlocks,
  stickerRefsToImageBlocks,
  type ImageBlock,
} from '../visual-blocks.js';

export interface BuildImageBlocksForPromptResult {
  kept: ImageBlock[];
  dropped: number;
}

type StickerExtractor = (text: string) => ImageBlock[];
type BlockCapper = (blocks: ImageBlock[]) => BuildImageBlocksForPromptResult;

export function buildImageBlocksForPrompt(
  userContent: string,
  extractor: StickerExtractor = stickerRefsToImageBlocks,
  capper: BlockCapper = capImageBlocks,
): BuildImageBlocksForPromptResult {
  const stickerImages = extractor(userContent);
  return capper(stickerImages);
}
