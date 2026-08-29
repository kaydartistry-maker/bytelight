/**
 * Codex image / vision helpers (6B-B Slice 3).
 *
 * Lives as a sibling to `codex.ts` (mirroring the `output-budget.ts`
 * precedent from Slice 2) so the codex runtime stays under control as
 * vision support lands. The helper is:
 *
 *   - Unit-tested in isolation (`codex-images.test.ts`).
 *   - Read by `codex.ts`'s tool loop to extract images from JSON-wrapped
 *     MCP tool results (the reference implementation-pattern graft).
 *   - The single place where the data-URI / base64-shape detection
 *     pattern lives — `codex.ts` should never call `JSON.parse` on a
 *     tool result directly.
 *
 * What this file does NOT do:
 *   - Convert user-image input. That path is already wired in
 *     `codex.ts` (`imagesToPiAi` at codex.ts:141-149) and stays there —
 *     the user-image translation is a 1:1 rename, not a parser.
 *   - Send images directly inside `function_call_output`. The runtime
 *     instead extracts images to a separate follow-up user message
 *     (reference implementation pattern; see `codex.ts` tool loop). Even though pi-ai's
 *     openai-responses-shared provider tolerates images inside
 *     `function_call_output` for vision-capable models, the safer
 *     contract is text-only function_call_output + follow-up user
 *     message — this is what tests assert and what the spec locks.
 *   - Log or emit raw base64. The redaction marker
 *     (`[image omitted: <mime>, <bytes> bytes]`) is the ONLY thing
 *     that should appear in events/errors/logs for an image.
 *
 * Out-of-scope diff guard (Slice 3): like `codex.ts`, this file MUST
 * NOT import `tools-bridge`, `agent.ts`, frontend, or sensitive-paths.
 * The import guard test at the bottom of `codex.test.ts` (Slice 1)
 * and the matching guard in `codex-images.test.ts` enforce this so a
 * future reader can audit the dep graph at a glance.
 */

// ─────────────────────────────────────────────────────────────────────────
// Public block shape
//
// Mirrors pi-ai's `(TextContent | ImageContent)[]` shape so that
// `codex.ts` can splice the result straight into a pi-ai `Message.content`
// array without a second translation. `data` is raw base64 (no
// `data:image/...;base64,` prefix) and `mimeType` is the MIME string —
// the same surface as `NormalizedImage` in `types.ts` plus the pi-ai
// `type: 'image'` tag.
// ─────────────────────────────────────────────────────────────────────────

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

// ─────────────────────────────────────────────────────────────────────────
// Detection thresholds
//
// `MIN_BASE64_LEN` is the lower bound on a base64 payload that we
// consider "image-shaped". 256 bytes of base64 = ~192 bytes decoded —
// well below the size of any real image (a 1x1 PNG is ~70 bytes
// encoded, but real screenshots/photos run 10KB+). The threshold is
// deliberately loose so we don't miss tiny test images, but tight
// enough that random base64-looking strings (request ids, JWTs) don't
// trigger.
//
// `DATA_URI_RE` matches `data:image/<subtype>;base64,<payload>` where
// `<payload>` is at least MIN_BASE64_LEN chars. The MIME type captured
// in group 1 propagates straight through (we never normalize
// 'image/png' → 'image/PNG' or similar — pi-ai accepts any standard
// MIME).
//
// Why a regex, not a parser: the input is "whatever the tool decided
// to print". MCP tools sometimes JSON-stringify image blocks; non-MCP
// tools sometimes inline data URIs into prose. reference implementation two-stage
// (JSON first, regex fallback) covers both observed shapes without
// inventing a third.
// ─────────────────────────────────────────────────────────────────────────

const MIN_BASE64_LEN = 256;
const DATA_URI_RE = /data:(image\/[^;]+);base64,([A-Za-z0-9+/=]{256,})/g;

// ─────────────────────────────────────────────────────────────────────────
// Default MIME for image blocks that omit a MIME field.
//
// Some MCP tools emit `{ type: 'image', data: '<base64>' }` without
// `mimeType`/`mime_type`. We assume PNG because (a) it's the most
// common screenshot format, (b) it's lossless so a wrong guess never
// silently corrupts the payload, (c) every Codex vision-capable model
// accepts it. Tools that produce JPEG/WebP universally set the MIME
// field so the default never overrides their choice.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE_MIME = 'image/png';

// ─────────────────────────────────────────────────────────────────────────
// Redaction marker
//
// The ONLY representation of an image that should appear in logs,
// runtime events, or error messages. Per Slice 3 data-safety contract:
// raw base64 must never appear in `provider_diagnostic.data`,
// `error.message`, or any event field. The marker carries the MIME
// type (useful for diagnostics — "we dropped a PNG vs a JPEG") and
// the byte count (useful for "did the budget cut us short?") but
// NOTHING from the payload itself.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the redaction marker for an image block. Used in tool-result
 * summaries, diagnostic event `data` fields, and anywhere else an
 * image needs a stand-in. Format is stable so call sites and tests
 * agree on what to assert.
 */
export function redactedImageMarker(mimeType: string, byteLength: number): string {
  return `[image omitted: ${mimeType}, ${byteLength} bytes]`;
}

// ─────────────────────────────────────────────────────────────────────────
// JSON-content array walker
//
// Lifted from the reference implementation's `extractFromArray` with
// two differences:
//   1. Unknown blocks are serialized as compact JSON (no pretty-print)
//      so the model sees a single-line representation it can parse.
//      Pretty-printed JSON-in-JSON confuses some models.
//   2. Empty `data` strings are NOT extracted as images — they'd
//      pass an `input_image` to the provider with zero bytes, which
//      every provider rejects. They fall through to the JSON-as-text
//      branch and become a debug breadcrumb.
//
// The shape probe (`item.type === 'image' && typeof item.data ===
// 'string' && item.data.length > MIN_BASE64_LEN`) is the same heuristic
// reference implementation uses. We tolerate `mimeType` vs `mime_type` vs
// `source.media_type` (Anthropic-style ImageBlock fallback) because
// different MCP servers emit different shapes — claim-staked compatibility
// with the in-the-wild data we've seen.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Walk an array of content blocks, pulling out images vs text.
 *
 * Block kinds handled:
 *   - `{ type: 'image', data: '<base64>', mimeType }` (pi-ai shape)
 *   - `{ type: 'image', data: '<base64>', mime_type }` (snake_case)
 *   - `{ type: 'image', source: { media_type, data } }` (Anthropic shape)
 *   - `{ type: 'text', text: '...' }` (pi-ai shape)
 *   - anything else → JSON-stringify into a text block (no data loss).
 */
export function extractFromArray(arr: unknown[]): ToolResultContentBlock[] {
  const out: ToolResultContentBlock[] = [];
  for (const raw of arr) {
    if (raw === null || typeof raw !== 'object') {
      // Primitive — stringify as text so it survives the round trip.
      out.push({ type: 'text', text: JSON.stringify(raw) });
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'image') {
      const data = pickImageData(item);
      if (data && data.length >= MIN_BASE64_LEN) {
        out.push({
          type: 'image',
          data,
          mimeType: pickImageMime(item) ?? DEFAULT_IMAGE_MIME,
        });
        continue;
      }
      // Image-tagged but no usable data — fall through to text so the
      // tool's intent (it tried to send an image) is at least visible.
      out.push({ type: 'text', text: JSON.stringify(item) });
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      out.push({ type: 'text', text: item.text });
      continue;
    }
    // Unknown block — serialize as text. The model sees the raw JSON
    // and can adapt; we don't drop data.
    out.push({ type: 'text', text: JSON.stringify(item) });
  }
  return out;
}

function pickImageData(item: Record<string, unknown>): string | null {
  if (typeof item.data === 'string') return item.data;
  // Anthropic-style nested source.data fallback.
  if (
    item.source &&
    typeof item.source === 'object' &&
    item.source !== null &&
    typeof (item.source as Record<string, unknown>).data === 'string'
  ) {
    return (item.source as Record<string, unknown>).data as string;
  }
  return null;
}

function pickImageMime(item: Record<string, unknown>): string | null {
  if (typeof item.mimeType === 'string') return item.mimeType;
  if (typeof item.mime_type === 'string') return item.mime_type;
  if (
    item.source &&
    typeof item.source === 'object' &&
    item.source !== null &&
    typeof (item.source as Record<string, unknown>).media_type === 'string'
  ) {
    return (item.source as Record<string, unknown>).media_type as string;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level tool-result parser
//
// Strategy mirrors reference implementation (`parseToolResultContent`):
//   1. Try `JSON.parse(raw)`. If it parses, three sub-shapes are
//      recognized:
//        a. Single image object: `{ type: 'image', data: '...' }`.
//        b. Array of content blocks (MCP-style).
//        c. Object with nested `content: [...]` array (MCP server
//           wrapper). Any top-level non-content fields become a meta
//           text block so the model sees the structure.
//      Other JSON shapes fall through to the regex stage with the
//      original raw text (so we don't strip the JSON).
//   2. Regex stage: scan `raw` for `data:image/...;base64,...` URIs.
//      Each URI becomes an image block; text between URIs becomes
//      text blocks.
//   3. Fallback: a single text block containing the original raw
//      string. ALWAYS returns at least one block (never an empty
//      array) so call sites have a useful summary.
//
// Failure mode: the parser NEVER throws. Inputs that look like
// random binary garbage, ill-formed JSON, half-truncated strings, etc.
// all funnel to "single text block with raw". The runtime separately
// applies the output-budget cap so unbounded base64 can't flood
// downstream.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a raw tool result string into content blocks separating
 * extracted images from text.
 *
 * Returns an array of `(TextContent | ImageContent)`-shaped blocks
 * suitable for splicing into pi-ai's `ToolResultMessage.content`. The
 * runtime then filters images out of `function_call_output` (text-only,
 * provider-safe) and injects them in a follow-up user message.
 *
 * Always returns at least one block — never an empty array.
 */
export function parseToolResultContent(raw: string): ToolResultContentBlock[] {
  // ── Stage 1: JSON ────────────────────────────────────────────────
  try {
    const parsed = JSON.parse(raw) as unknown;

    // a. Single image object.
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).type === 'image'
    ) {
      const obj = parsed as Record<string, unknown>;
      const data = pickImageData(obj);
      if (data && data.length >= MIN_BASE64_LEN) {
        return [
          {
            type: 'image',
            data,
            mimeType: pickImageMime(obj) ?? DEFAULT_IMAGE_MIME,
          },
        ];
      }
      // Image-tagged but data missing — fall through to text.
      return [{ type: 'text', text: raw }];
    }

    // b. Array of content blocks.
    if (Array.isArray(parsed)) {
      const blocks = extractFromArray(parsed);
      return blocks.length > 0 ? blocks : [{ type: 'text', text: raw }];
    }

    // c. Object with nested content array.
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as Record<string, unknown>).content)
    ) {
      const outer = parsed as Record<string, unknown>;
      const extracted = extractFromArray(outer.content as unknown[]);
      // Only re-shape when at least one image is present — otherwise
      // dropping the wrapper would just produce a noisier text block
      // than the original raw string.
      if (extracted.some((b) => b.type === 'image')) {
        const meta: ToolResultContentBlock[] = [];
        // Preserve any top-level non-content fields as a meta text
        // block so the model can still read the wrapper structure.
        // Compact JSON (no pretty-print) keeps the model's parser
        // happy and minimizes token cost.
        const { content: _content, ...rest } = outer;
        if (Object.keys(rest).length > 0) {
          meta.push({ type: 'text', text: JSON.stringify(rest) });
        }
        return [...meta, ...extracted];
      }
      // No images extracted — fall through to text so we don't drop
      // the wrapper.
      return [{ type: 'text', text: raw }];
    }
    // Other JSON (strings, numbers, plain objects) — fall through.
  } catch {
    // Not JSON — fall through to regex.
  }

  // ── Stage 2: data-URI regex ─────────────────────────────────────
  const blocks: ToolResultContentBlock[] = [];
  // `RegExp` with `/g` flag is stateful; capture & reset by creating
  // a local copy. `DATA_URI_RE.lastIndex = 0` would work too but
  // a fresh RegExp is more robust against concurrent callers.
  const re = new RegExp(DATA_URI_RE.source, DATA_URI_RE.flags);
  let cursor = 0;
  let m: RegExpExecArray | null;
  let found = false;
  while ((m = re.exec(raw)) !== null) {
    found = true;
    const before = raw.slice(cursor, m.index).trim();
    if (before) blocks.push({ type: 'text', text: before });
    blocks.push({ type: 'image', data: m[2], mimeType: m[1] });
    cursor = m.index + m[0].length;
  }
  if (found) {
    const trailing = raw.slice(cursor).trim();
    if (trailing) blocks.push({ type: 'text', text: trailing });
    return blocks.length > 0 ? blocks : [{ type: 'text', text: raw }];
  }

  // ── Stage 3: plain text fallback ────────────────────────────────
  return [{ type: 'text', text: raw }];
}

// ─────────────────────────────────────────────────────────────────────────
// Tool-result splitting
//
// The runtime tool loop calls this after parsing. It separates the
// extracted blocks into:
//   - `toolResultText`: the text that will land in `function_call_output`.
//     This is ALWAYS a string (Responses API contract) and never
//     contains raw base64. If the only useful content was an image,
//     the text becomes "(image returned — see attached)" so the
//     `function_call_output` still has a non-empty body the model can
//     reference. If both text and images were present, the text
//     parts are concatenated (newline-joined).
//   - `images`: an array of pi-ai `ImageContent`-shaped blocks for
//     splicing into a follow-up user message.
//
// Mirrors the reference implementation's extractor pattern with one
// tightening: when the only text block is a JSON wrapper that the
// extractor produced as a meta breadcrumb, we keep it (the model
// often relies on the wrapper's other fields for grounding).
// ─────────────────────────────────────────────────────────────────────────

export interface ToolResultSplit {
  /** Safe text for `function_call_output`. Never contains raw base64. */
  toolResultText: string;
  /** Image blocks for the follow-up user message. Empty when none. */
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
}

/**
 * Apply `parseToolResultContent` and split into text-for-`function_call_output`
 * vs image-blocks-for-follow-up-user-message.
 */
export function splitToolResultForCodex(raw: string): ToolResultSplit {
  const blocks = parseToolResultContent(raw);
  const texts: string[] = [];
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      texts.push(b.text);
    } else {
      images.push({ type: 'image', data: b.data, mimeType: b.mimeType });
    }
  }
  let toolResultText: string;
  if (texts.length === 0 && images.length > 0) {
    toolResultText = '(image returned — see attached)';
  } else if (texts.length === 0) {
    // Shouldn't happen — parseToolResultContent never returns empty.
    // Defensive: emit a noise-free placeholder so `function_call_output`
    // has a non-empty body.
    toolResultText = '(empty tool result)';
  } else {
    toolResultText = texts.join('\n');
  }
  return { toolResultText, images };
}

// ─────────────────────────────────────────────────────────────────────────
// Image translation (re-exported for symmetry)
//
// The user-image translation lives in `codex.ts` (`imagesToPiAi`) and
// stays there — it predates Slice 3 and the import paths into that
// file are stable. This helper exists for the symmetrical case: image
// blocks coming OUT of a tool result that need the same pi-ai content
// shape. Same fields, same rename, no decode/re-encode.
//
// Exported so `codex.ts` can call this with the `images` from
// `splitToolResultForCodex` to build the follow-up user message.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a follow-up user message body carrying extracted images. The
 * message text is a short banner so the model knows the images came
 * from a tool result (not the user's original turn). The image blocks
 * are spliced in after the banner.
 *
 * Used by the runtime tool loop right after appending per-tool
 * `toolResult` messages. When no images were extracted, the caller
 * should NOT call this — the empty array branch is undefined.
 */
export function buildToolResultImageFollowup(
  images: Array<{ type: 'image'; data: string; mimeType: string }>,
): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
> {
  return [
    { type: 'text', text: '[Tool returned the following image(s):]' },
    ...images,
  ];
}
