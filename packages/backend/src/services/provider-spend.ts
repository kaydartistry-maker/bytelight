/**
 * Local provider spend meters for byte-light's OpenRouter, xAI, and Groq
 * lanes.
 *
 * HOUSE EXTENSION: reference implementation has no equivalent service. byte-light already
 * records provider-attributed cost_usd in usage_events, so this deliberately
 * aggregates that ledger instead of calling provider billing APIs or
 * rebuilding token accounting.
 */
import { getDb } from './db.js';

export const SPEND_PROVIDERS = ['openrouter', 'xai', 'groq'] as const;
export type SpendProvider = typeof SPEND_PROVIDERS[number];

export interface ProviderSpendMeter {
  provider: SpendProvider;
  periodStart: string;
  periodEnd: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  spend: {
    usedFormatted: string;
    limitFormatted: null;
    percent: null;
    enabled: boolean;
    canPurchaseCredits: false;
  };
}

function defaultPeriod(now = new Date()): { since: string; until: string } {
  return {
    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    until: now.toISOString(),
  };
}

export function isSpendProvider(value: string): value is SpendProvider {
  return (SPEND_PROVIDERS as readonly string[]).includes(value);
}

export function getProviderSpend(
  provider: SpendProvider,
  range: { since?: string; until?: string } = {},
): ProviderSpendMeter {
  const period = defaultPeriod();
  const since = range.since ?? period.since;
  const until = range.until ?? period.until;
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM usage_events
    WHERE provider = ? AND created_at >= ? AND created_at <= ?
  `).get(provider, since, until) as {
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  const costUsd = Number(row.cost_usd);
  return {
    provider,
    periodStart: since,
    periodEnd: until,
    requestCount: Number(row.request_count),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costUsd,
    spend: {
      usedFormatted: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(costUsd),
      limitFormatted: null,
      percent: null,
      enabled: Number(row.request_count) > 0,
      canPurchaseCredits: false,
    },
  };
}

export function listProviderSpend(range: { since?: string; until?: string } = {}): ProviderSpendMeter[] {
  return SPEND_PROVIDERS.map((provider) => getProviderSpend(provider, range));
}
