import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getStickerRefMap } from '$lib/stores/stickers.svelte';

// Patterns for embeddable media URLs (bare links on their own line)
const MEDIA_URL_RE = /^(https?:\/\/(?:media[0-9]*\.giphy\.com\/media\/[^\s]+\.gif|(?:i\.)?giphy\.com\/media\/[^\s]+\.gif|tenor\.com\/view\/[^\s]+|media\.tenor\.com\/[^\s]+\.gif))$/i;

// Convert bare media URLs to inline images before markdown parsing
function embedMediaUrls(text: string): string {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    const match = trimmed.match(MEDIA_URL_RE);
    if (match) {
      const url = match[1];
      // Tenor view pages need their URL kept as a link with an embedded gif
      if (/tenor\.com\/view\//.test(url)) {
        return `[![gif](${url}.gif)](${url})`;
      }
      return `![gif](${url})`;
    }
    return line;
  }).join('\n');
}

// Canvas reference pattern: <<canvas:UUID:Title>>
const CANVAS_REF_RE = /&lt;&lt;canvas:([a-f0-9-]+):([^&]+)&gt;&gt;/gi;

// Convert canvas references to clickable chips (runs on HTML output)
function renderCanvasChips(html: string): string {
  return html.replace(CANVAS_REF_RE, (_, id, title) => {
    const decoded = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return `<span class="canvas-chip" data-canvas-id="${id}" onclick="window.dispatchEvent(new CustomEvent('open-canvas', {detail:'${id}'}))" title="Open canvas">${decoded}</span>`;
  });
}

// Configure marked for chat messages
marked.setOptions({
  breaks: true,  // \n becomes <br>
  gfm: true,     // GitHub flavored markdown
});

// Replace `:packname_stickername:` refs with inline <img> tags
function substituteStickers(text: string): string {
  const map = getStickerRefMap();
  if (map.size === 0) return text;
  // Process line by line: sticker alone on line = block-sticker (128px),
  // sticker with other text = inline-sticker (64px)
  const lines = text.split('\n');
  return lines.map(line => {
    const aloneOnLine = line.match(/^\s*:([a-z0-9_-]+_[a-z0-9_-]+):\s*$/i);
    if (aloneOnLine) {
      const ref = `:${aloneOnLine[1]}:`;
      const url = map.get(ref.toLowerCase());
      if (url) {
        return `<img src="${url}" alt="${aloneOnLine[1]}" class="block-sticker" />`;
      }
    }
    return line.replace(/:([a-z0-9_-]+_[a-z0-9_-]+):/gi, (full) => {
      const url = map.get(full.toLowerCase());
      if (!url) return full;
      const alt = full.replace(/:/g, '');
      return `<img src="${url}" alt="${alt}" class="inline-sticker" />`;
    });
  }).join('\n');
}

// Discord markup: turn custom emoji into images and any unresolved
// mention markup (<@id>, <#id>, <@&id>) into clean pills instead of raw digits.
// Ported from the reference implementation fork (credit: reference implementation).
function applyDiscordMarkup(text: string): string {
  return text
    .replace(/<(a)?:(\w+):(\d+)>/g, (_m, animated, name, id) =>
      `<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=48" alt=":${name}:" title=":${name}:" />`)
    .replace(/<@!?\d+>/g, '<span class="discord-mention">@mention</span>')
    .replace(/<@&\d+>/g, '<span class="discord-mention">@role</span>')
    .replace(/<#\d+>/g, '<span class="discord-mention">#channel</span>');
}

// Discord-style subtext: a line beginning with "-# " renders small and muted.
// Ported from the reference implementation fork (credit: reference implementation).
function applySubtext(text: string): string {
  return text.split('\n').map(line => {
    const m = line.match(/^-#\s+(.*)$/);
    if (!m) return line;
    return `<div class="md-subtext">${marked.parseInline(m[1], { async: false }) as string}</div>`;
  }).join('\n');
}

export function renderMarkdown(text: string): string {
  const withStickers = substituteStickers(text);
  const processed = applySubtext(applyDiscordMarkup(embedMediaUrls(withStickers)));
  const html = marked.parse(processed, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'div'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'loading', 'data-canvas-id', 'onclick'],
  });
  return renderCanvasChips(sanitized);
}
