// Preflight validation — layered auth pipeline

import type { Message } from 'discord.js';
import type { PreflightResult, MessageBatch } from './types.js';
import { DISCORD_CONFIG } from './config.js';
import { PairingService } from './pairing.js';
import {
  isChannelIgnored,
  isChannelReadOnly,
  requiresMention,
  getUserRule,
  getServerRule,
  isUserAllowedInServer,
} from './rules.js';

export function isUserAllowed(userId: string): boolean {
  return DISCORD_CONFIG.allowedUsers.has(userId);
}

export function isGuildAllowed(guildId: string | null): boolean {
  if (!guildId) return true;
  return DISCORD_CONFIG.allowedGuilds.has(guildId);
}

export function mentionsBot(message: Message): boolean {
  if (!message.client.user) return false;
  // Direct @bot mention
  if (message.mentions.users.has(message.client.user.id)) return true;
  // Role mention — check if bot has any of the mentioned roles
  if (message.guild && message.mentions.roles.size > 0) {
    const botMember = message.guild.members.cache.get(message.client.user.id);
    if (botMember) {
      for (const [roleId] of message.mentions.roles) {
        if (botMember.roles.cache.has(roleId)) return true;
      }
    }
  }
  return false;
}

// True when this message is a direct reply to one of the bot's own messages.
// Discord surfaces the reply target as `message.mentions.repliedUser` (populated
// even when the reply does not @-ping); `message.reference` confirms it is a
// reply at all. A reply to the bot counts as a summon — it bypasses the
// listen-mode judge exactly the way an @-mention does.
export function repliesToBot(message: Message): boolean {
  if (!message.client.user) return false;
  if (!message.reference) return false;
  return message.mentions.repliedUser?.id === message.client.user.id;
}

export async function preflight(batch: MessageBatch, pairingService: PairingService): Promise<PreflightResult> {
  const { firstMessage, userId, guildId, channelId, parentChannelId } = batch;

  // Ignore bots — unless they have a UserRule
  if (firstMessage.author.bot) {
    const botRule = getUserRule(firstMessage.author.id);
    if (!botRule) {
      return { allowed: false, reason: 'Author is an unknown bot' };
    }
  }

  // Check if channel is ignored (threads inherit the parent channel's rule)
  if (isChannelIgnored(channelId, guildId, parentChannelId)) {
    return { allowed: false, reason: 'Channel is ignored' };
  }

  // Read-only channels never get a reply — outranks @-mentions (threads inherit parent)
  if (isChannelReadOnly(channelId, parentChannelId)) {
    return { allowed: false, reason: 'Channel is read-only' };
  }

  const userAllowed = isUserAllowed(userId);
  const userRule = getUserRule(userId);
  const serverRule = guildId ? getServerRule(guildId) : undefined;

  // Guild message flow
  if (guildId) {
    if (!userAllowed && !isGuildAllowed(guildId)) {
      return { allowed: false, reason: 'Guild not on allowlist' };
    }

    if (userRule && !isUserAllowedInServer(userId, guildId)) {
      return { allowed: false, reason: 'User not allowed in this server by rules' };
    }

    if (serverRule?.ignoredUsers?.includes(userId)) {
      return { allowed: false, reason: 'User is ignored in this server' };
    }

    const needsMention = requiresMention(channelId, guildId, DISCORD_CONFIG.requireMentionInGuilds, parentChannelId);
    if (needsMention && !mentionsBot(firstMessage)) {
      return { allowed: false, reason: 'Mention required in this channel' };
    }

    if (userAllowed || isGuildAllowed(guildId)) {
      return { allowed: true, reason: 'Guild message approved' };
    }

    if (serverRule?.allowPublicResponses && mentionsBot(firstMessage)) {
      return { allowed: true, reason: 'Public response allowed in this server' };
    }

    return { allowed: false, reason: 'User not allowed in this guild' };
  }

  // DM flow
  if (userAllowed) {
    return { allowed: true, reason: 'User is on allowlist' };
  }

  // Check SQLite-backed pairing
  if (pairingService.isApproved(userId)) {
    return { allowed: true, reason: 'User has approved pairing' };
  }

  // Need pairing
  const config = await import('../../config.js').then(m => m.getBytelightConfig());
  const code = pairingService.createOrGet(userId, firstMessage.author.username, channelId);
  return {
    allowed: false,
    reason: 'Pairing required for DM',
    requiresPairing: true,
    pairingCode: code,
  };
}
