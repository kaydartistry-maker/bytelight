import type { ClientMessage } from '@bytelight/shared';

export type PendingMessage = Extract<ClientMessage, { type: 'message' }> & { clientId: string };

export const OUTBOX_STORAGE_KEY = 'bytelight.message-outbox.v1';

export function readOutbox(storage?: Pick<Storage, 'getItem'>): PendingMessage[] {
  if (!storage) return [];
  try {
    const value = storage.getItem(OUTBOX_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingMessage =>
      item?.type === 'message' && typeof item.clientId === 'string' &&
      typeof item.threadId === 'string' && typeof item.content === 'string'
    );
  } catch {
    return [];
  }
}

export function writeOutbox(messages: PendingMessage[], storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  if (!storage) return;
  try {
    if (messages.length === 0) storage.removeItem(OUTBOX_STORAGE_KEY);
    else storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts. The
    // in-memory outbox still protects ordinary reconnects in that case.
  }
}

export function upsertPending(messages: PendingMessage[], message: PendingMessage): PendingMessage[] {
  const index = messages.findIndex(item => item.clientId === message.clientId);
  if (index === -1) return [...messages, message];
  return messages.map((item, i) => i === index ? message : item);
}

export function acknowledgePending(messages: PendingMessage[], clientId: string): PendingMessage[] {
  return messages.filter(item => item.clientId !== clientId);
}
