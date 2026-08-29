/**
 * Per-tool output budget — UTF-8 byte-counted truncation helper.
 *
 * The Codex tool-calling loop driver (6B-B Slice 2) applies a 200KB
 * per-turn cap on total tool-result bytes sent back to the model.
 * Inside that cap, every individual tool result is bounded by the
 * per-result cap below so a single huge result (e.g. a 4MB file dump,
 * a base64 image blob, an unbounded grep) doesn't single-handedly
 * exhaust the turn budget.
 *
 * Lives as a sibling to codex.ts (not inlined) so it can be:
 *   - Unit tested in isolation (output-budget.test.ts).
 *   - Shared with future runtimes (Ollama tool loop, OpenAI-compat
 *     tool loop) that need the same defense-in-depth.
 *   - Audited by the operator without scrolling through the codex runtime.
 *
 * Why UTF-8 bytes, not JS chars:
 *   JavaScript `String.length` returns the count of UTF-16 code units.
 *   For ASCII source code that equals the UTF-8 byte length, but for
 *   emoji / CJK / accented text every visible char takes 2-4 UTF-8
 *   bytes. The provider (OpenAI Codex Responses) tokenizes the wire
 *   bytes, not the JS chars — so a 4-byte emoji counted as 1 char
 *   would sneak past a char-based cap and inflate the actual context
 *   payload by up to 4x. Byte counting closes that gap.
 *
 * Defensive layering:
 *   - The built-in tools already self-cap output (their own check).
 *   - This helper is the second line of defense at the loop driver
 *     boundary: ANY tool result passing through here is bounded.
 *   - The loop driver also tracks a 200KB total-turn cap that uses
 *     this same byte-counting (see codex.ts MAX_OUTPUT_BYTES).
 */

/**
 * Default per-tool result cap. UTF-8 bytes. 50KB matches reference implementation
 * E3b's `MAX_TOOL_OUTPUT_CHARS` cap on its own scale (chars vs bytes
 * agree on ASCII; bytes are stricter for non-ASCII content, which is
 * the safer default for a tool-result wire budget).
 *
 * Kept distinct from the loop driver's 200KB total-turn cap so a
 * future tool with a legitimate 100KB result won't single-handedly
 * exhaust the turn — but a runaway tool emitting MB-scale output
 * still gets clipped here before the per-turn accountant ever sees it.
 */
export const MAX_TOOL_OUTPUT_BYTES = 50_000;

/**
 * UTF-8 byte length of a string. Uses Node's Buffer.byteLength so
 * the count exactly matches what hits the wire after JSON.stringify.
 *
 * Exported so the loop driver can use the SAME byte-counting routine
 * for its per-turn accountant. Single-source-of-truth — if we ever
 * swap the byte-count implementation (e.g. to a non-Node-coupled one)
 * the change lands in one place.
 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes, appending a
 * clear truncation notice when truncation actually fires. Returns
 * the input unchanged when already within budget.
 *
 * Guarantees:
 *   - Output's UTF-8 byte length is ALWAYS <= `maxBytes`.
 *   - Output is valid UTF-8 (we slice at a JS-char boundary so we
 *     never split a surrogate pair, then verify the byte count and
 *     back off chars one at a time until it fits — this matters for
 *     emoji / CJK content where a single char can be 2-4 bytes).
 *   - The notice text is INSIDE the cap (so a max=200 result is never
 *     201 bytes regardless of how the notice rendered).
 *   - When `maxBytes` is too small to fit even the notice
 *     (pathological), the result is a truncated notice — no content.
 *     Production usage always passes 50KB which is ~500x the notice
 *     size, so this branch is paranoia, not the hot path.
 *
 * Notice content:
 *   - Names the cap that fired (so the model can adapt its next
 *     call: "ask for a smaller page", "use a tighter pattern").
 *   - Reports bytes omitted (so the model knows "I'm missing 100
 *     bytes" vs "I'm missing 4MB").
 */
export function applyOutputBudget(
  text: string,
  maxBytes: number = MAX_TOOL_OUTPUT_BYTES,
): string {
  const inputBytes = utf8ByteLength(text);
  if (inputBytes <= maxBytes) return text;

  const omitted = inputBytes - maxBytes;
  const notice = `\n[tool output truncated at ${maxBytes} bytes; ${omitted} bytes omitted — narrow the request to see more]`;
  const noticeBytes = utf8ByteLength(notice);

  // Pathological case: caller passed a max so small that even the
  // notice doesn't fit. Sacrifice the notice rather than overshoot.
  if (maxBytes <= noticeBytes) {
    return sliceToByteBudget(notice, maxBytes);
  }

  const contentBudget = maxBytes - noticeBytes;
  const trimmedContent = sliceToByteBudget(text, contentBudget);
  return trimmedContent + notice;
}

/**
 * Slice `text` so its UTF-8 byte length is at most `maxBytes`. Slices
 * at JS-char boundaries (never splits a UTF-16 surrogate pair, which
 * would produce invalid UTF-8 once re-encoded), then backs off one
 * char at a time until the byte count fits the budget.
 *
 * For mostly-ASCII input the loop runs at most once. For dense
 * multi-byte input (CJK ~3 bytes/char, emoji 4 bytes/char) it may
 * back off a handful of chars. Either way the runtime cost is
 * negligible compared to the network call that would otherwise
 * carry the over-budget bytes.
 *
 * Exported for the loop driver's mid-chunk byte accountant, which
 * uses the same primitive to make "would this push us over?" calls
 * before queuing a tool result onto the next iteration's input.
 */
export function sliceToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  // Fast path: whole-string ASCII often falls here without iterating.
  if (utf8ByteLength(text) <= maxBytes) return text;

  // Walk codepoints with a streaming byte accountant. Stop when the
  // next codepoint would push us over the budget. Operating on
  // codepoints (not UTF-16 code units) guarantees we never split a
  // surrogate pair, so the returned string round-trips through UTF-8
  // intact.
  //
  // Complexity: O(N) in the input length — one pass, accumulator
  // updated per codepoint. The naive `slice + join` per back-off
  // step is O(N^2) and stalls on dense emoji/CJK input where every
  // step back is one codepoint.
  let bytes = 0;
  let out = '';
  for (const cp of text) {
    const cpBytes = utf8ByteLength(cp);
    if (bytes + cpBytes > maxBytes) break;
    bytes += cpBytes;
    out += cp;
  }
  return out;
}
