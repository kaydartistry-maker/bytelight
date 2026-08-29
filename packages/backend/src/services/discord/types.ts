// Discord gateway types

import type { Message } from 'discord.js';

export interface QueuedMessage {
  message: Message;
  timestamp: number;
}

export interface MessageBatch {
  messages: Message[];
  channelId: string;
  // For messages in a thread, the parent channel's id (rules are inherited from
  // the parent). Null/undefined for messages posted directly in a channel or DM.
  parentChannelId?: string | null;
  userId: string;
  guildId: string | null;
  combinedContent: string;
  firstMessage: Message;
  lastMessage: Message;
  channelHistory?: string;
}

export interface PairingCode {
  code: string;
  userId: string;
  username?: string;
  channelId: string;
  createdAt: string;
  expiresAt: string;
}

export interface PreflightResult {
  allowed: boolean;
  reason: string;
  requiresPairing?: boolean;
  pairingCode?: string;
}
