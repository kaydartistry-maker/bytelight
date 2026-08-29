// DiscordService — Gateway listener that routes Discord messages through AgentService

import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  Partials,
  Routes,
} from 'discord.js';
import type { Message as DiscordMessage, TextChannel } from 'discord.js';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { FFMPEG } from '../binaries.js';
import { MessageDebouncer } from './debouncer.js';
import { preflight, mentionsBot, repliesToBot } from './preflight.js';
import { getSecret } from '../secrets.js';
import { PairingService } from './pairing.js';
import { getUserRule } from './rules.js';
import { buildRulesContext, getEffectiveChannelRule } from './rules.js';
import { judgeShouldRespond } from './judge.js';
import { DISCORD_CONFIG, getDiscordConfig } from './config.js';
import { splitResponse, formatChannelHistory, resolveEmoteShorthand } from './utils.js';
import type { MessageBatch } from './types.js';
import type { AgentService } from '../agent.js';
import { createMessage, resolveRoutingThread, updateThreadActivity } from '../db.js';
import { getBytelightConfig } from '../../config.js';
import type { registry as registryInstance } from '../registry.js';
import type { VoiceService } from '../voice.js';

type ConnectionRegistry = typeof registryInstance;

export type DiscordActionResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

function cleanId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(`${name} must be a Discord snowflake`);
  }
  return value;
}

function cleanText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} must be at most ${max} characters`);
  return value;
}

async function discordVoiceMetadata(mp3: Buffer): Promise<{ duration: number; waveform: string }> {
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
    proc.stdin.end(mp3);
  });

  const samples = Math.floor(pcm.length / 2);
  if (!samples) throw new Error('TTS produced no decodable audio');
  const points = Math.min(256, samples);
  const amplitudes = new Uint8Array(points);
  let peak = 1;
  for (let point = 0; point < points; point++) {
    const start = Math.floor(point * samples / points);
    const end = Math.max(start + 1, Math.floor((point + 1) * samples / points));
    let sum = 0;
    for (let i = start; i < end; i++) sum += Math.abs(pcm.readInt16LE(i * 2));
    const average = Math.round(sum / (end - start));
    amplitudes[point] = Math.min(255, average >> 7);
    peak = Math.max(peak, amplitudes[point]);
  }
  for (let i = 0; i < amplitudes.length; i++) {
    amplitudes[i] = Math.round(amplitudes[i] * 255 / peak);
  }
  return { duration: samples / 8000, waveform: Buffer.from(amplitudes).toString('base64') };
}

/** What the server actually calls this person: nickname > global name > username. */
function displayNameOf(message: DiscordMessage): string {
  return message.member?.displayName || message.author.displayName || message.author.username;
}

// Module-level activity tracker — records last message per Discord user
interface ActivityEntry {
  name: string;
  lastSeen: number;
  channelId: string;
}

const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000; // entries older than a day are no longer "recent"
const recentActivity = new Map<string, ActivityEntry>();

export function getDiscordActivity(): Map<string, ActivityEntry> {
  return recentActivity;
}

/** A single connected-guild custom emoji, flattened for orientation/resolver use. */
export interface CustomEmoji {
  name: string;
  id: string;
  animated: boolean;
  guild: string;
}

// Module-level pointer to the live gateway (set on start, cleared on stop) so
// non-Discord modules (hooks orientation, outbound resolver) can read the
// connected guilds' custom emojis without an import cycle — mirrors the
// recentActivity/getDiscordActivity module accessor above.
let activeDiscordService: DiscordService | null = null;

/**
 * Flat list of every custom emoji across the connected guilds. Empty when the
 * gateway isn't started or no guilds are cached — never throws. Read live from
 * the discord.js cache (always current), same as getStats() reads guild count.
 */
export function getCustomEmojiCatalog(): CustomEmoji[] {
  return activeDiscordService?.listCustomEmojis() ?? [];
}

/** Live Discord gateway service, or null before start/after stop. */
export function getActiveDiscordService(): DiscordService | null {
  return activeDiscordService;
}

export class DiscordService {
  private client: Client;
  private debouncer: MessageDebouncer;
  private pairingService: PairingService;
  private agentService: AgentService;
  private registry: ConnectionRegistry;
  private processing = new Set<string>();
  private started = false;

  // Deferred queue — holds non-owner Discord batches when owner is active on web UI
  private deferredBatches: Array<{ batch: MessageBatch; queuedAt: number }> = [];
  private deferTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private stats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    deferred: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(agentService: AgentService, registry: ConnectionRegistry) {
    this.agentService = agentService;
    this.registry = registry;
    this.pairingService = new PairingService();

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildExpressions, // keeps guild.emojis.cache fresh on add/update/delete
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
      ],
    });

    this.debouncer = new MessageDebouncer();
    this.debouncer.onBatch(this.handleBatch.bind(this));

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on(Events.MessageCreate, (message: DiscordMessage) => {
      // Ignore own messages
      if (message.author.id === this.client.user?.id) return;

      // Ignore unknown bots — allow bots with UserRules
      if (message.author.bot) {
        const botRule = getUserRule(message.author.id);
        if (!botRule) return;
        console.log(`[Discord] Known bot message: ${botRule.name}`);
      }

      this.stats.messagesReceived++;
      this.debouncer.add(message);
    });

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[Discord] Logged in as ${c.user.tag}`);
      console.log(`[Discord] Guilds: ${c.guilds.cache.size}`);
    });

    this.client.on('error', (error) => {
      console.error('[Discord] Client error:', error);
    });

    this.client.on('warn', (msg) => {
      console.warn('[Discord] Warning:', msg);
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      console.error(`[Discord] Shard ${shardId} disconnected (code ${event.code})`);
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      console.log(`[Discord] Shard ${shardId} reconnecting...`);
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      console.log(`[Discord] Shard ${shardId} resumed (${replayedEvents} events replayed)`);
    });
  }

  private async handleBatch(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage, channelId, userId } = batch;
    const isOwner = userId === DISCORD_CONFIG.ownerUserId;

    // Defer non-owner Discord messages when owner is actively chatting on web UI
    // This prevents Discord conversations from interrupting the owner's flow
    // Uses web-specific activity — Telegram activity should NOT trigger deferral
    if (!isOwner) {
      const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
      if (ownerActiveMinutes < getDiscordConfig().ownerActiveThresholdMin) {
        this.deferredBatches.push({ batch, queuedAt: Date.now() });
        this.stats.deferred++;
        lastMessage.react('\u23F3').catch(() => {}); // hourglass — message seen but delayed
        console.log(`[Discord] Deferred message from ${firstMessage.author.username} (owner active ${ownerActiveMinutes.toFixed(1)}m ago, ${this.deferredBatches.length} in queue)`);
        return;
      }
    }

    await this._processBatch(batch);
  }

  private async _processBatch(batch: MessageBatch): Promise<void> {
    const { firstMessage, lastMessage, channelId, userId } = batch;
    const isOwner = userId === DISCORD_CONFIG.ownerUserId;
    const key = `${channelId}:${userId}`;

    if (this.processing.has(key)) {
      console.log(`[Discord] Already processing ${key}, skipping`);
      return;
    }

    this.processing.add(key);

    // Track activity for relational field context. Sweep stale entries
    // occasionally — this map is keyed by every unique author ever seen and
    // previously had no eviction at all.
    if (recentActivity.size > 256) {
      const staleBefore = Date.now() - ACTIVITY_TTL_MS;
      for (const [id, entry] of recentActivity) {
        if (entry.lastSeen < staleBefore) recentActivity.delete(id);
      }
    }
    recentActivity.set(userId, {
      name: displayNameOf(firstMessage),
      lastSeen: Date.now(),
      channelId,
    });

    let typingInterval: ReturnType<typeof setInterval> | null = null;

    try {
      // Run preflight checks
      const result = await preflight(batch, this.pairingService);

      if (!result.allowed) {
        console.log(`[Discord] Preflight denied: ${result.reason}`);

        if (result.requiresPairing && result.pairingCode) {
          const config = getBytelightConfig();
          await lastMessage.reply(
            `I don't recognize you yet. To chat with me, ask ${config.identity.user_name} to approve this code: \`${result.pairingCode}\`\n\nThis code expires in 1 hour.`
          );
        }
        return;
      }

      // Touch owner's activity if they're the sender
      if (isOwner) {
        this.registry.touchUserActivity();
      }

      // Pre-fetch channel history (10 messages) — done BEFORE the listen-mode
      // judge so the judge has the same context block the agent prompt uses,
      // and so we fetch it exactly once for both.
      try {
        const channel = lastMessage.channel;
        if ('messages' in channel) {
          const history = await (channel as TextChannel).messages.fetch({ limit: 10 });
          batch.channelHistory = formatChannelHistory([...history.values()].reverse());
        }
      } catch (err) {
        console.warn('[Discord] Could not fetch channel history:', err);
      }

      // === Listen-mode judge gate (reference implementation port) ===
      // Preflight has ALLOWED this batch. The judge only runs when that allow
      // came via the effective channel rule's `alwaysListen` (threads inherit
      // it) AND the bot was NOT summoned. A summon = an @-mention OR a direct
      // reply to the bot's own message; both bypass the judge exactly as an
      // @-mention bypassed the mention requirement before Listen mode.
      // Precedence is untouched: ignore > readOnly > (mention/judge) all fired
      // inside preflight already; this gate sits strictly after that allow.
      const effectiveRule = getEffectiveChannelRule(channelId, batch.parentChannelId);
      const summoned = mentionsBot(firstMessage) || repliesToBot(firstMessage);
      if (batch.guildId && effectiveRule?.alwaysListen === true && !summoned) {
        const guild = this.client.guilds.cache.get(batch.guildId);
        const channelForName = this.client.channels.cache.get(channelId);
        const channelName = channelForName && 'name' in channelForName
          ? (channelForName as TextChannel).name
          : channelId;
        const decision = await judgeShouldRespond(
          {
            message: batch.combinedContent,
            authorName: displayNameOf(firstMessage),
            channelName,
            serverName: guild?.name,
            channelHistory: batch.channelHistory,
          },
          summoned,
        );
        const tag = decision.fellBack ? 'fallback' : decision.engine;
        console.log(
          `[Discord] Judge: ${decision.respond ? 'yes' : 'no'} (${decision.reason}) ${decision.latencyMs}ms [${tag}]`
        );
        if (!decision.respond) {
          // SILENT SKIP — return before any typing indicator, reaction, thread
          // creation, message persistence, or agent call. Zero footprint: the
          // room never knows we read it. (The `finally` below only clears the
          // processing lock and the not-yet-started typing interval.)
          return;
        }
      }

      // Show typing indicator (refresh every 8s — Discord typing expires after 10s)
      if ('sendTyping' in lastMessage.channel) {
        await lastMessage.channel.sendTyping();
      }
      typingInterval = setInterval(() => {
        if ('sendTyping' in lastMessage.channel) {
          (lastMessage.channel as TextChannel).sendTyping().catch(() => {});
        }
      }, 8000);

      console.log(`[Discord] Processing from ${firstMessage.author.username} in ${channelId}`);

      // All Discord messages route to the routing thread ("Home") — owner,
      // community, DMs. This ensures social interactions and community
      // conversations are visible in the handoff context alongside everything
      // else. (reference implementation port: per-channel threads stop being created.)
      const routedThread = resolveRoutingThread('discord', this.registry);
      const threadId = routedThread.id;
      const threadName = routedThread.name;
      console.log(`[Discord] ${isOwner ? 'Owner' : 'Community'} routed to routing thread: ${threadName} (${threadId})`);

      // Store incoming message in SQLite
      const now = new Date().toISOString();
      const senderRole = isOwner ? 'user' : 'system';
      // Collect sticker metadata across the batch — content carries readable
      // [sticker: Name] tokens; metadata keeps the structured ids/urls.
      const stickers = batch.messages.flatMap(m =>
        [...m.stickers.values()].map(s => ({ id: s.id, name: s.name, url: s.url, format: s.format }))
      );
      const incomingMsg = createMessage({
        id: crypto.randomUUID(),
        threadId,
        role: senderRole as 'user' | 'system',
        content: batch.combinedContent,
        contentType: 'text',
        platform: 'discord',
        metadata: {
          discordUserId: userId,
          discordUsername: firstMessage.author.username,
          discordDisplayName: displayNameOf(firstMessage),
          discordChannelId: channelId,
          discordGuildId: batch.guildId,
          discordMessageId: lastMessage.id,
          ...(stickers.length > 0 ? { discordStickers: stickers } : {}),
        },
        createdAt: now,
      });

      updateThreadActivity(threadId, now, true);
      this.registry.broadcast({ type: 'message', message: incomingMsg });

      // Build platform context (platform info + rules + channel history)
      const platformHeader = batch.guildId
        ? `=== PLATFORM: DISCORD ===\nResponding in #${(this.client.channels.cache.get(channelId) as TextChannel)?.name || channelId} on ${this.client.guilds.cache.get(batch.guildId)?.name || batch.guildId}.`
        : `=== PLATFORM: DISCORD ===\nResponding in DM with ${firstMessage.author.username}.`;
      const platformGuidance = [
        platformHeader,
        `Discord IDs for native actions: channelId=${channelId}, guildId=${batch.guildId ?? 'DM'}, lastMessageId=${lastMessage.id}.`,
        'Discord formatting: **bold**, *italic*, `code`, ```codeblocks```, > quotes, ||spoilers||.',
        'Max message length: 2000 chars (responses auto-split at 1900).',
        'Replying to the last message in this batch.',
        'Keep responses appropriate to the platform — not as terse as Telegram, but don\'t write essays.',
        'IMPORTANT: Do NOT use --- (horizontal rules) between Companion A and Companion B sections — they render as literal dashes in Discord. Use a blank line instead.',
      ].join('\n');

      const rulesContext = buildRulesContext(userId, channelId, batch.guildId);
      const historyContext = batch.channelHistory
        ? `\n\n=== RECENT CHANNEL HISTORY (last 10 messages) ===\n${batch.channelHistory}`
        : '';
      const platformContext = `${platformGuidance}\n\n${rulesContext}${historyContext}`;

      this.stats.messagesProcessed++;

      // Process through AgentService
      const response = await this.agentService.processMessage(
        threadId,
        batch.combinedContent,
        { name: threadName, type: 'named' },
        {
          platform: 'discord',
          platformContext,
          discordChannelId: batch.channelId,
          discordGuildId: batch.guildId ?? undefined,
          discordMessageId: batch.lastMessage.id,
        },
      );

      if (!response || response.trim() === '' || response === '[No response]') {
        console.log('[Discord] Empty response from agent');
        return;
      }

      // Resolve :name: shorthand into real custom-emoji tokens before splitting,
      // so shorthand the companion wrote renders as the server's actual emoji.
      // Empty index / gateway down → identity (no-op). Done pre-split so a token
      // is never severed across a chunk boundary.
      const resolved = resolveEmoteShorthand(response, this.listCustomEmojis());

      // Split and send response with rate limit delay
      const chunks = splitResponse(resolved, 1900);

      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await lastMessage.reply(chunks[i]);
        } else {
          // 200ms delay between chunks to avoid rate limits
          await new Promise(r => setTimeout(r, 200));
          if ('send' in lastMessage.channel) {
            await (lastMessage.channel as TextChannel).send(chunks[i]);
          }
        }
      }

      console.log(`[Discord] Sent ${chunks.length} chunk(s) to ${channelId}`);

    } catch (error) {
      console.error('[Discord] Handler error:', error);
      this.stats.errors++;
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      this.processing.delete(key);
    }
  }

  private async drainDeferredQueue(): Promise<void> {
    if (this.deferredBatches.length === 0) return;

    const config = getDiscordConfig();

    // Prune expired batches BEFORE the owner-active hold below. When the
    // prune sat behind that early return, a continuously-active owner meant
    // expired batches (each pinning full discord.js Message objects) were
    // never dropped and the queue grew for as long as the owner kept chatting.
    const now = Date.now();
    this.deferredBatches = this.deferredBatches.filter(entry => {
      if (now - entry.queuedAt > config.deferMaxAgeMs) {
        console.log(`[Discord] Dropping expired deferred batch from ${entry.batch.firstMessage.author.username}`);
        return false;
      }
      return true;
    });

    const ownerActiveMinutes = this.registry.minutesSinceLastUserWebActivity();
    if (ownerActiveMinutes < config.ownerActiveThresholdMin) return; // Owner still active on web — keep holding

    if (this.deferredBatches.length === 0) return;

    console.log(`[Discord] Owner idle ${ownerActiveMinutes.toFixed(1)}m — draining ${this.deferredBatches.length} deferred messages`);

    // Process one at a time to avoid flooding
    while (this.deferredBatches.length > 0) {
      // Re-check owner's web activity before each batch — stop draining if they come back to web
      if (this.registry.minutesSinceLastUserWebActivity() < config.ownerActiveThresholdMin) {
        console.log(`[Discord] Owner returned — pausing drain (${this.deferredBatches.length} remaining)`);
        break;
      }
      const entry = this.deferredBatches.shift()!;
      await this._processBatch(entry.batch);
    }
  }

  async start(): Promise<void> {
    const token = getSecret('discord_bot_token'); // DB → env; takes effect on restart
    if (!token) {
      console.error('[Discord] DISCORD_BOT_TOKEN not set — gateway disabled');
      return;
    }

    try {
      await this.client.login(token);
      this.started = true;
      activeDiscordService = this; // expose emoji catalog to orientation/resolver

      // Start deferred queue drain timer
      this.deferTimer = setInterval(() => {
        this.drainDeferredQueue().catch(err =>
          console.error('[Discord] Drain error:', err)
        );
      }, getDiscordConfig().deferPollIntervalMs);

      console.log('[Discord] Gateway started');
    } catch (error) {
      console.error('[Discord] Failed to login:', error);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    console.log('[Discord] Shutting down gateway...');
    if (this.deferTimer) {
      clearInterval(this.deferTimer);
      this.deferTimer = null;
    }
    this.deferredBatches = [];
    this.debouncer.destroy();
    this.client.destroy();
    this.started = false;
    if (activeDiscordService === this) activeDiscordService = null;
  }

  isConnected(): boolean {
    return this.started && this.client.isReady();
  }

  getStats() {
    return {
      ...this.stats,
      deferredPending: this.deferredBatches.length,
      connected: this.isConnected(),
      username: this.client.user?.username || null,
      guilds: this.client.guilds.cache.size,
    };
  }

  getPairingService(): PairingService {
    return this.pairingService;
  }

  private async action(fn: () => Promise<Record<string, unknown>>): Promise<DiscordActionResult> {
    if (!this.client.isReady()) return { ok: false, error: 'Discord gateway is not started' };
    try {
      return { ok: true, ...(await fn()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async textChannel(channelId: unknown) {
    const id = cleanId(channelId, 'channelId');
    const channel = await this.client.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !('send' in channel) || !('messages' in channel)) {
      throw new Error('Channel is not a message-capable text channel');
    }
    return channel;
  }

  async sendMessage(channelId: unknown, message: unknown, replyToMessageId?: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const content = cleanText(message, 'message', 2000);
      const sent = replyToMessageId
        ? await (await channel.messages.fetch(cleanId(replyToMessageId, 'replyToMessageId'))).reply(content)
        : await channel.send(content);
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendImage(channelId: unknown, url: unknown, description?: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const imageUrl = cleanText(url, 'url', 2048);
      let parsed: URL;
      try { parsed = new URL(imageUrl); } catch { throw new Error('url must be a valid URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use http or https');
      const desc = description === undefined ? undefined : cleanText(description, 'description', 4096);
      const sent = await channel.send({ embeds: [{ ...(desc ? { description: desc } : {}), image: { url: imageUrl } }] });
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendSticker(channelId: unknown, stickerId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const sent = await channel.send({ stickers: [cleanId(stickerId, 'stickerId')] });
      return { messageId: sent.id, channelId: sent.channelId };
    });
  }

  async sendVoice(channelId: unknown, text: unknown, voice: unknown, voiceService: VoiceService): Promise<DiscordActionResult> {
    return this.action(async () => {
      const id = cleanId(channelId, 'channelId');
      await this.textChannel(id);
      const spoken = cleanText(text, 'text', 20000);
      if (voice !== undefined && voice !== 'companion-a' && voice !== 'companion-b') throw new Error('voice must be companion-a or companion-b');
      if (!voiceService.canTTS) throw new Error('Voice service is not configured');
      const audio = await voiceService.generateTTS(spoken, voice as string | undefined);
      const metadata = await discordVoiceMetadata(audio);
      const sent = await this.client.rest.post(Routes.channelMessages(id), {
        files: [{ data: audio, name: 'voice-message.mp3', contentType: 'audio/mpeg' }],
        body: {
          flags: MessageFlags.IsVoiceMessage,
          attachments: [{ id: 0, filename: 'voice-message.mp3', duration_secs: metadata.duration, waveform: metadata.waveform }],
        },
      }) as { id: string; channel_id: string };
      return { messageId: sent.id, channelId: sent.channel_id, duration: metadata.duration };
    });
  }

  async addReaction(channelId: unknown, messageId: unknown, emoji: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      await message.react(cleanText(emoji, 'emoji', 100));
      return { messageId: message.id, emoji };
    });
  }

  async editOwnMessage(channelId: unknown, messageId: unknown, content: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      if (message.author.id !== this.client.user!.id) throw new Error('Refusing to edit a message not authored by this bot');
      const edited = await message.edit(cleanText(content, 'content', 2000));
      return { messageId: edited.id, channelId: edited.channelId };
    });
  }

  async deleteOwnMessage(channelId: unknown, messageId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const message = await channel.messages.fetch(cleanId(messageId, 'messageId'));
      if (message.author.id !== this.client.user!.id) throw new Error('Refusing to delete a message not authored by this bot');
      await message.delete();
      return { messageId: message.id, deleted: true };
    });
  }

  async readMessages(channelId: unknown, limit: unknown = 50): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 50;
      const messages = await channel.messages.fetch({ limit: count });
      return { messages: [...messages.values()].map(m => ({ messageId: m.id, authorId: m.author.id, author: m.author.username, content: m.content, timestamp: m.createdAt.toISOString() })) };
    });
  }

  async sendTypingTo(channelId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const channel = await this.textChannel(channelId);
      await channel.sendTyping();
      return { channelId: channel.id, typing: true };
    });
  }

  async getServerInfo(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      return { guild: { guildId: guild.id, name: guild.name, description: guild.description, ownerId: guild.ownerId, memberCount: guild.memberCount, createdAt: guild.createdAt.toISOString(), iconUrl: guild.iconURL() } };
    });
  }

  async listServers(): Promise<DiscordActionResult> {
    return this.action(async () => ({
      guilds: [...this.client.guilds.cache.values()].map(g => ({ guildId: g.id, name: g.name, memberCount: g.memberCount, iconUrl: g.iconURL() })),
    }));
  }

  async listEmojis(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      await guild.emojis.fetch();
      return { emojis: [...guild.emojis.cache.values()].map(e => ({ emojiId: e.id, name: e.name, animated: e.animated ?? false, available: e.available })) };
    });
  }

  async listStickers(guildId: unknown): Promise<DiscordActionResult> {
    return this.action(async () => {
      const guild = await this.client.guilds.fetch(cleanId(guildId, 'guildId'));
      const stickers = await guild.stickers.fetch();
      return { stickers: [...stickers.values()].map(s => ({ stickerId: s.id, name: s.name, description: s.description, format: s.format, tags: s.tags, url: s.url })) };
    });
  }

  async searchMessages(guildId: unknown, options: { content?: unknown; authorId?: unknown; channelId?: unknown; has?: unknown; limit?: unknown }): Promise<DiscordActionResult> {
    return this.action(async () => {
      const id = cleanId(guildId, 'guildId');
      const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) ? Math.max(1, Math.min(Math.floor(options.limit), 25)) : 25;
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.content !== undefined) query.set('content', cleanText(options.content, 'content', 1024));
      if (options.authorId !== undefined) query.append('author_id', cleanId(options.authorId, 'authorId'));
      if (options.channelId !== undefined) query.append('channel_id', cleanId(options.channelId, 'channelId'));
      if (options.has !== undefined) {
        const values = Array.isArray(options.has) ? options.has : [options.has];
        const allowed = new Set(['link', 'embed', 'file', 'video', 'image', 'sound', 'sticker', 'snapshot', 'poll']);
        for (const value of values) {
          const filter = cleanText(value, 'has', 50);
          if (!allowed.has(filter)) throw new Error(`Unsupported has filter: ${filter}`);
          query.append('has', filter);
        }
      }
      const result = await this.client.rest.get(Routes.guildMessagesSearch(id), { query }) as {
        total_results?: number;
        messages?: Array<Array<{ id: string; channel_id: string; content: string; timestamp: string; author: { id: string; username: string; global_name?: string | null } }>>;
        message?: string;
        retry_after?: number;
      };
      if (!result.messages) throw new Error(result.message ?? `Discord search index is pending; retry after ${result.retry_after ?? 'a moment'}`);
      return {
        totalResults: result.total_results ?? 0,
        messages: result.messages.flatMap(group => group.slice(-1)).map(m => ({
          messageId: m.id,
          channelId: m.channel_id,
          authorId: m.author.id,
          author: m.author.global_name || m.author.username,
          content: m.content,
          timestamp: m.timestamp,
        })),
      };
    });
  }

  /**
   * Flatten every custom emoji across the connected guilds. Reads the discord.js
   * cache live (kept current by the Guilds intent), so no snapshot to go stale.
   * Returns [] if the gateway isn't ready — never throws.
   */
  listCustomEmojis(): CustomEmoji[] {
    if (!this.client.isReady()) return [];
    const out: CustomEmoji[] = [];
    for (const guild of this.client.guilds.cache.values()) {
      for (const emoji of guild.emojis.cache.values()) {
        if (!emoji.name) continue; // deleted/partial emojis can have null name
        out.push({
          name: emoji.name,
          id: emoji.id,
          animated: emoji.animated ?? false,
          guild: guild.name,
        });
      }
    }
    return out;
  }
}
