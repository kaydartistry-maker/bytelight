// Message debouncer — combines rapid messages from same user/channel

import type { Message } from 'discord.js';
import type { MessageBatch, QueuedMessage } from './types.js';
import { DISCORD_CONFIG } from './config.js';
import { formatDiscordMessageContent } from './utils.js';

type BatchHandler = (batch: MessageBatch) => Promise<void>;

export class MessageDebouncer {
  private queues: Map<string, QueuedMessage[]> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private handler: BatchHandler | null = null;

  private getKey(message: Message): string {
    return `${message.channelId}:${message.author.id}`;
  }

  onBatch(handler: BatchHandler): void {
    this.handler = handler;
  }

  add(message: Message): void {
    const key = this.getKey(message);

    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    queue.push({ message, timestamp: Date.now() });

    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (this.shouldProcessImmediately(message)) {
      this.flush(key);
      return;
    }

    const timer = setTimeout(() => {
      this.flush(key);
    }, DISCORD_CONFIG.debounceMs);

    this.timers.set(key, timer);
  }

  private shouldProcessImmediately(message: Message): boolean {
    if (message.attachments.size > 0) return true;
    if (message.content.startsWith('/')) return true;
    const content = message.content.toLowerCase();
    if (content === 'send' || content === 'go' || content === 'done') return true;
    return false;
  }

  private async flush(key: string): Promise<void> {
    const queue = this.queues.get(key);
    const timer = this.timers.get(key);

    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    if (!queue || queue.length === 0) {
      this.queues.delete(key);
      return;
    }

    const messages = queue.map(q => q.message);
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];

    // Thread messages carry the thread's own channel id; capture the parent
    // channel id so rule evaluation can inherit the parent's rules (ignore,
    // readOnly, requireMention). Batching stays keyed by the raw thread id.
    const channel = firstMessage.channel;
    const parentChannelId = channel.isThread() ? channel.parentId : null;

    const batch: MessageBatch = {
      messages,
      channelId: firstMessage.channelId,
      parentChannelId,
      userId: firstMessage.author.id,
      guildId: firstMessage.guildId,
      // Includes sticker tokens — a sticker-only message would otherwise
      // produce an empty string here and store as blank content.
      combinedContent: messages.map(m => formatDiscordMessageContent(m)).join('\n'),
      firstMessage,
      lastMessage,
    };

    this.queues.delete(key);

    if (this.handler) {
      await this.handler(batch);
    }
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.queues.clear();
  }
}
