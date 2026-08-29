// Telegram configuration — DB-backed with config.yaml fallback defaults

import { getConfig, getConfigNumber } from '../db.js';
import { getBytelightConfig } from '../../config.js';
import type { TelegramConfigValues } from './types.js';

const DEFAULTS = {
  maxMessageLength: 4096,
};

export function getTelegramConfig(): TelegramConfigValues {
  const appConfig = getBytelightConfig();
  return {
    ownerChatId: getConfig('telegram.ownerChatId') || appConfig.telegram.owner_chat_id || '',
    groupChatId: getConfig('telegram.groupChatId') || appConfig.telegram.group_chat_id || '',
    maxMessageLength: getConfigNumber('telegram.maxMessageLength', DEFAULTS.maxMessageLength),
  };
}
