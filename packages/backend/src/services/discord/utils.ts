// Discord utility functions

import crypto from 'crypto';
import type { Message as DiscordMessage } from 'discord.js';

/**
 * Split a response into Discord-safe chunks (max 1900 chars)
 */
export function splitResponse(text: string, maxLength = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph break
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      // Try single newline
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      // Try space
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      // Hard cut
      splitAt = maxLength;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}

// discord.js cleanContent reduces custom emotes <a:name:id> to :name:,
// dropping the id needed to render the emote image. Put the raw tokens back:
// each token from the raw content replaces the first matching :name: in the
// cleaned string, in order, so duplicates line up.
function restoreEmoteTokens(raw: string, cleaned: string): string {
  const tokens = raw.match(/<a?:\w+:\d{17,20}>/g);
  if (!tokens) return cleaned;
  let result = cleaned;
  for (const token of tokens) {
    const name = token.slice(token.indexOf(':') + 1, token.lastIndexOf(':'));
    result = result.replace(`:${name}:`, token);
  }
  return result;
}

/**
 * Outbound counterpart to restoreEmoteTokens: turn the `:name:` shorthand a
 * companion writes into the real Discord token — `<:name:id>` (static) or
 * `<a:name:id>` (animated) — for any `name` that exactly matches a known guild
 * custom emoji. Match is CASE-SENSITIVE (Discord emoji names are).
 *
 * Left untouched:
 *  - `:name:` whose name isn't a known guild emoji (Unicode shortcodes like
 *    `:smile:`, and byte-light sticker refs like `:companion_a_wink:`, both pass
 *    through — sticker refs require a `_` and are resolved by an independent
 *    exact-lookup pipeline (visual-blocks.ts), so only a genuine same-name
 *    collision could shadow one, same ambiguity Discord itself would have).
 *  - text already inside a complete token — the leading `<` (optionally `<a`)
 *    means a `:name:` sitting inside `<:name:id>` is never double-wrapped,
 *    because a bare-`:name:` match can't start with `<`.
 *
 * @param emojiIndex flat list of guild emojis; zero-length → identity.
 */
export function resolveEmoteShorthand(
  text: string,
  emojiIndex: Array<{ name: string; id: string; animated: boolean }>,
): string {
  if (!text || emojiIndex.length === 0) return text;
  // name → emoji (first wins on duplicate names across guilds).
  const byName = new Map<string, { id: string; animated: boolean }>();
  for (const e of emojiIndex) {
    if (!byName.has(e.name)) byName.set(e.name, { id: e.id, animated: e.animated });
  }
  // Match a bare :name:. The `(?<!<)` lookbehind skips a token's opening colon
  // (`<:name:...`), and the `(?![0-9]+>)` lookahead skips a token's middle colon
  // (`...:id>`) — together they leave complete <:name:id> / <a:name:id> tokens
  // untouched, so nothing is ever double-wrapped, while still allowing adjacent
  // shorthand like `:a::b:` (the shared middle colon is not `<`-prefixed).
  return text.replace(
    /(?<!<):([A-Za-z0-9_]+):(?![0-9]+>)/g,
    (whole, name: string) => {
      const emoji = byName.get(name); // case-sensitive exact match
      if (!emoji) return whole; // unknown name (unicode shortcode / sticker ref) — leave it
      return emoji.animated ? `<a:${name}:${emoji.id}>` : `<:${name}:${emoji.id}>`;
    },
  );
}

/**
 * Render a Discord message's text content with any stickers appended as
 * readable tokens (`[sticker: <Name>]`). Sticker-only messages have empty
 * text content — without the tokens they'd store and display as empty strings,
 * leaving the companion blind to what was sent.
 *
 * cleanContent resolves mentions to readable names but also reduces custom
 * emotes <a:name:id> to :name:, losing the id the frontend needs to render
 * the emote image off the Discord CDN, so restore the raw tokens afterwards.
 */
export function formatDiscordMessageContent(message: DiscordMessage): string {
  const text = restoreEmoteTokens(message.content, message.cleanContent || message.content || '');
  if (message.stickers.size === 0) return text;
  const stickerTokens = [...message.stickers.values()].map(s => `[sticker: ${s.name}]`);
  return [text, ...stickerTokens].filter(Boolean).join(' ');
}

/**
 * Format Discord message history for agent context
 */
export function formatChannelHistory(messages: DiscordMessage[]): string {
  return messages.map(msg => {
    const time = msg.createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const author = msg.author.bot ? `[BOT] ${msg.author.username}` : msg.author.username;
    const content = formatDiscordMessageContent(msg)
      || (msg.attachments.size > 0 ? '[attachment]' : '[embed]');
    return `[${time}] ${author}: ${content}`;
  }).join('\n');
}

/**
 * Generate a deterministic UUID v4 from a Discord channel ID.
 * This maps each Discord channel to a stable bytelight thread.
 */
export function getDiscordThreadId(channelId: string): string {
  const hash = crypto.createHash('sha256').update(`discord:${channelId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
