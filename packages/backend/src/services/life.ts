// Life status and mood history services — extracted from hooks.ts

import { getBytelightConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Life API status — cached fetch for orientation context
// ---------------------------------------------------------------------------

const LIFE_STATUS_CACHE_MS = 5 * 60 * 1000; // 5 minutes
let lifeStatusCache: { text: string; fetchedAt: number } | null = null;

const MOOD_HISTORY_CACHE_MS = 30 * 60 * 1000; // 30 minutes
let moodHistoryCache: { text: string; fetchedAt: number } | null = null;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function condenseLifeStatus(markdown: string): string {
  if (!markdown) return '';

  const config = getBytelightConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;
  const lines: string[] = [];

  // --- User's line ---
  const userParts: string[] = [];

  // Extract user's mood (format: "- **UserName:** mood text")
  const userMoodRegex = new RegExp(`\\*\\*${escapeRegExp(userName)}:\\*\\*\\s*(.+?)(?:\\n|$)`);
  const userMoodMatch = markdown.match(userMoodRegex);
  if (userMoodMatch) {
    const mood = userMoodMatch[1].trim();
    if (mood && mood !== '\u2013' && mood !== '-') userParts.push(`Mood ${mood}`);
  }

  // Extract routines from "## Today's Routines" section
  const routineSection = markdown.match(/## Today's Routines\n([\s\S]*?)(?:\n##|\n\n##|$)/);
  if (routineSection) {
    const routineItems: string[] = [];
    const routineLines = routineSection[1].split('\n').filter(l => l.startsWith('- '));
    for (const line of routineLines) {
      const match = line.match(/^-\s+(.+?):\s+(.+)$/);
      if (match) {
        const name = match[1].trim().toLowerCase();
        const val = match[2].trim();
        if (val === '\u2013' || val === '-') {
          routineItems.push(`${name}: no`);
        } else if (val.toLowerCase() === 'yes') {
          routineItems.push(`${name}: yes`);
        } else {
          routineItems.push(`${name}: ${val}`);
        }
      }
    }
    if (routineItems.length > 0) userParts.push(`Routines: ${routineItems.join(', ')}`);
  }

  // Extract cycle info
  const cycleSection = markdown.match(/## Cycle\n([\s\S]*?)(?:\n##|$)/);
  if (cycleSection) {
    const cycleText = cycleSection[1].trim();
    if (cycleText) userParts.push(`Cycle: ${cycleText.split('\n')[0]}`);
  }

  if (userParts.length > 0) lines.push(`${userName}: ${userParts.join('. ')}`);

  // --- Companion's line ---
  const companionMoodRegex = new RegExp(`\\*\\*${escapeRegExp(companionName)}:\\*\\*\\s*(.+?)(?:\\n|$)`);
  const companionMoodMatch = markdown.match(companionMoodRegex);
  if (companionMoodMatch) {
    const mood = companionMoodMatch[1].trim();
    if (mood && mood !== '\u2013' && mood !== '-') lines.push(`${companionName}: Mood ${mood}`);
  }

  // --- Task count ---
  const taskSection = markdown.match(/## Active Tasks\n([\s\S]*?)(?:\n##|$)/);
  if (taskSection) {
    const taskLines = taskSection[1].split('\n').filter(l => l.startsWith('- '));
    if (taskLines.length > 0) lines.push(`Tasks: ${taskLines.length} active`);
  }

  // --- Countdowns (first line only) ---
  const countdownSection = markdown.match(/## Countdowns\n([\s\S]*?)(?:\n##|$)/);
  if (countdownSection) {
    const firstCountdown = countdownSection[1].trim().split('\n')[0];
    if (firstCountdown && firstCountdown.startsWith('-')) {
      lines.push(firstCountdown.replace(/^-\s*/, '').trim());
    }
  }

  return lines.join('\n');
}

export async function fetchLifeStatus(): Promise<string> {
  const config = getBytelightConfig();
  const lifeApiUrl = config.integrations.life_api_url;

  // If Command Center is enabled and no external life API, use local CC service
  if (!lifeApiUrl && config.command_center.enabled) {
    if (lifeStatusCache && (Date.now() - lifeStatusCache.fetchedAt) < LIFE_STATUS_CACHE_MS) {
      return lifeStatusCache.text;
    }
    try {
      const { getCcStatus } = await import('./cc.js');
      const rawText = getCcStatus();
      // getCcStatus() already returns compact format — no condensation needed
      lifeStatusCache = { text: rawText, fetchedAt: Date.now() };
      return rawText;
    } catch (e) {
      console.warn('[Hook] CC status error:', (e as Error).message);
      return '';
    }
  }

  // If no life API configured and no CC, return empty
  if (!lifeApiUrl) return '';

  // Return cached if fresh
  if (lifeStatusCache && (Date.now() - lifeStatusCache.fetchedAt) < LIFE_STATUS_CACHE_MS) {
    return lifeStatusCache.text;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(lifeApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 1,
        params: { name: 'vale_status', arguments: {} },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Hook] Life status fetch failed: ${res.status}`);
      return '';
    }

    const json = await res.json() as any;
    const rawText = json?.result?.content?.[0]?.text || '';

    // Condense the markdown status into compact lines
    const condensed = condenseLifeStatus(rawText);
    lifeStatusCache = { text: condensed, fetchedAt: Date.now() };
    return condensed;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.warn('[Hook] Life status fetch timed out (2s)');
    } else {
      console.warn('[Hook] Life status fetch error:', (error as Error).message);
    }
    return '';
  }
}

export async function fetchMoodHistory(): Promise<string | null> {
  const config = getBytelightConfig();
  const lifeApiUrl = config.integrations.life_api_url;

  // If Command Center is enabled and no external life API, read from local DB
  if (!lifeApiUrl && config.command_center.enabled) {
    if (moodHistoryCache && (Date.now() - moodHistoryCache.fetchedAt) < MOOD_HISTORY_CACHE_MS) {
      return moodHistoryCache.text;
    }
    try {
      const { getCareEntries } = await import('./cc.js');
      const today = new Date();
      const trajectory: string[] = [];

      for (const daysAgo of [2, 1]) {
        const dt = new Date(today);
        dt.setDate(dt.getDate() - daysAgo);
        const dateStr = dt.toISOString().split('T')[0];
        const entries = getCareEntries(dateStr);
        const moodEntries = entries.filter((e: any) => e.category === 'mood' && e.value);
        if (moodEntries.length > 0) {
          const label = daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;
          const moodParts = moodEntries.map((m: any) => {
            const name = (m.person || 'user').charAt(0).toUpperCase() + (m.person || 'user').slice(1);
            return `${name}: ${m.value}${m.note ? ' ' + m.note : ''}`;
          });
          trajectory.push(`${label}: ${moodParts.join(', ')}`);
        }
      }

      if (trajectory.length === 0) return null;
      const text = `Mood history: ${trajectory.join(' → ')}`;
      moodHistoryCache = { text, fetchedAt: Date.now() };
      return text;
    } catch {
      return null;
    }
  }

  // If no life API configured and no CC, skip
  if (!lifeApiUrl) return null;

  if (moodHistoryCache && (Date.now() - moodHistoryCache.fetchedAt) < MOOD_HISTORY_CACHE_MS) {
    return moodHistoryCache.text;
  }

  // Derive REST base URL from MCP URL (strip the MCP path segment)
  const restBaseUrl = lifeApiUrl.replace(/\/mcp\/.*$/, '');
  if (!restBaseUrl || restBaseUrl === lifeApiUrl) return null;

  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;

  try {
    const today = new Date();
    const dates = [1, 2].map(d => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() - d);
      return dt.toISOString().split('T')[0];
    });

    const [day1, day2] = await Promise.all(
      dates.map(async (date) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${restBaseUrl}/api/moods/${date}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) return [];
        return res.json() as Promise<Array<{ who: string; emoji: string; note?: string }>>;
      })
    );

    // Build trajectory: day-before-yesterday -> yesterday -> (today from status)
    const trajectory: string[] = [];
    for (const [i, dayMoods] of [day2, day1].entries()) {
      const label = i === 0 ? '2d ago' : 'yesterday';
      // Match mood entries by normalized who field
      const userMood = (dayMoods as any[]).find((m: any) =>
        m.who?.toLowerCase() === userName.toLowerCase() || m.who === 'user'
      );
      const companionMood = (dayMoods as any[]).find((m: any) =>
        m.who?.toLowerCase() === companionName.toLowerCase() || m.who === 'companion'
      );
      if (userMood || companionMood) {
        const moodParts: string[] = [];
        if (userMood) moodParts.push(`${userName}: ${userMood.emoji || '\u2013'}${userMood.note ? ' ' + userMood.note : ''}`);
        if (companionMood) moodParts.push(`${companionName}: ${companionMood.emoji || '\u2013'}${companionMood.note ? ' ' + companionMood.note : ''}`);
        trajectory.push(`${label}: ${moodParts.join(', ')}`);
      }
    }

    if (trajectory.length === 0) return null;
    const text = `Mood history: ${trajectory.join(' \u2192 ')}`;
    moodHistoryCache = { text, fetchedAt: Date.now() };
    return text;
  } catch {
    return null;
  }
}
