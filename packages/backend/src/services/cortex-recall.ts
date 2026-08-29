// cortex-recall.ts — reading from the archive instead of carrying it.
//
// Neuralis IS this house's Cortex. It exposes semantic recall over HTTP:
//
//   GET {MIND_API_URL}/api/cortex/thoughts?query=...&limit=N[&type=][&domain=]
//   -> { result: "<formatted prose>" }
//
// Verified live from this machine (HTTP 200, real matches) before this file
// was written. The endpoint runs an embedding query against the vector index
// filtered to source:cortex — genuine semantic search, not keyword matching,
// which is why the caller can hand it a whole sentence.
//
// Credentials resolve through the BYOK secrets store, same as mind-routes.ts,
// so a key saved via /api/secrets takes effect without a restart.
//
// The contract this file owes the rest of the system: it NEVER throws and it
// NEVER outlives its timeout. A slow or unreachable Cortex means no recall
// this turn — it must never delay or fail a delivery.

import { getSecret } from './secrets.js';

const DEFAULT_TIMEOUT_MS = 3500;

export interface CortexRecallOptions {
  limit?: number;
  type?: 'decision' | 'principle' | 'insight' | 'observation' | 'question';
  domain?: string;
  timeoutMs?: number;
}

export interface CortexRememberOptions {
  domain?: string;
  context?: string;
  timeoutMs?: number;
}

/** Mirror text into Cortex. False means callers must retain their local copy. */
export async function cortexRemember(
  content: string,
  opts: CortexRememberOptions = {},
): Promise<boolean> {
  const url = getSecret('mind_api_url');
  const key = getSecret('mind_api_key');
  if (!url || !key || !content.trim()) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/cortex/thoughts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'observation',
        content,
        domain: opts.domain ?? 'core-memory-archive',
        context: opts.context,
        importance: 'routine',
      }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: unknown };
    if (typeof body.result !== 'string') return false;
    const acknowledgement = body.result.trim();
    return /^(?:ok|success(?:ful(?:ly)?)?|remembered|saved|stored|created)\b/i.test(acknowledgement);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One scored hit from the archive, when the worker exposes structured results.
 *
 * SHIVER ADAPTATION: byte-light's Cortex is a REMOTE worker (Neuralis over
 * HTTP), unlike reference implementation's LOCAL vector index which hands the whisper
 * `{id, similarity}[]` directly. The déjà-vu near-miss mechanic needs a
 * confidence score, and the prose endpoint (`/api/cortex/thoughts`) does not
 * carry one — it answers in formatted prose only. `cortexRecallScored` asks
 * the worker for a structured answer and parses scores IF they arrive; when
 * the worker only speaks prose (the current contract), `scored` is empty and
 * `dejavu` never fires. Recall itself is unaffected — it rides the prose path.
 */
export interface CortexScoredHit {
  id: string;
  /** Cosine similarity 0..1, as reported by the worker. */
  similarity: number;
  content?: string;
  domain?: string;
  created_at?: string;
}

export interface CortexScoredRecall {
  /** The archive's own formatted prose block (same as `cortexRecall`), or ''. */
  prose: string;
  /** Structured scored hits, or [] when the worker speaks prose only. */
  scored: CortexScoredHit[];
}

/** Configured only when BOTH halves of the credential are present. */
export function cortexConfigured(): boolean {
  return Boolean(getSecret('mind_api_url') && getSecret('mind_api_key'));
}

/** Coerce one loosely-typed worker row into a scored hit, or null if unusable. */
function parseScoredHit(row: unknown): CortexScoredHit | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id =
    typeof r.id === 'string' ? r.id : typeof r.id === 'number' ? String(r.id) : null;
  // Accept the common score field names a worker might use; first present wins.
  const rawScore = r.similarity ?? r.score ?? r._score ?? r.distance;
  const similarity = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;
  if (id === null || similarity === null) return null;
  return {
    id,
    similarity,
    content: typeof r.content === 'string' ? r.content : undefined,
    domain: typeof r.domain === 'string' ? r.domain : undefined,
    created_at: typeof r.created_at === 'string' ? r.created_at : undefined,
  };
}

/**
 * Scored semantic recall against Cortex.
 *
 * Requests a structured answer (`format=scored`) and parses whatever the
 * worker returns: prose for the recall block, plus scored hits for the
 * déjà-vu near-miss test when the worker carries them. Same fail-quiet
 * contract as `cortexRecall` — never throws, never outlives its timeout;
 * every failure mode returns `{ prose: '', scored: [] }`.
 */
export async function cortexRecallScored(
  query: string,
  opts: CortexRecallOptions = {},
): Promise<CortexScoredRecall> {
  const empty: CortexScoredRecall = { prose: '', scored: [] };
  const url = getSecret('mind_api_url');
  const key = getSecret('mind_api_key');
  if (!url || !key || !query.trim()) return empty;

  const params = new URLSearchParams({ query, limit: String(opts.limit ?? 3) });
  if (opts.type) params.set('type', opts.type);
  if (opts.domain) params.set('domain', opts.domain);
  // Ask for scored rows. A worker that ignores the hint just answers prose,
  // which is exactly the graceful-degrade path — no scores, no déjà vu.
  params.set('format', 'scored');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/cortex/thoughts?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return empty;

    const body = (await res.json()) as {
      result?: unknown;
      results?: unknown;
      matches?: unknown;
    };
    let prose = typeof body?.result === 'string' ? body.result.trim() : '';
    if (/^No cortex (memories|thoughts) found/im.test(prose)) prose = '';

    const rawRows = Array.isArray(body?.results)
      ? body.results
      : Array.isArray(body?.matches)
        ? body.matches
        : [];
    const scored: CortexScoredHit[] = [];
    for (const row of rawRows) {
      const hit = parseScoredHit(row);
      if (hit) scored.push(hit);
    }
    return { prose, scored };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Semantic recall against Cortex.
 *
 * Returns the archive's own formatted prose, or '' for every failure mode —
 * unconfigured, unreachable, slow, non-200, malformed, or simply nothing
 * relevant. Callers do not need to try/catch; '' means "no recall this turn."
 */
export async function cortexRecall(
  query: string,
  opts: CortexRecallOptions = {},
): Promise<string> {
  const url = getSecret('mind_api_url');
  const key = getSecret('mind_api_key');
  if (!url || !key || !query.trim()) return '';

  const params = new URLSearchParams({ query, limit: String(opts.limit ?? 3) });
  if (opts.type) params.set('type', opts.type);
  if (opts.domain) params.set('domain', opts.domain);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/cortex/thoughts?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return '';

    const body = (await res.json()) as { result?: unknown };
    const result = typeof body?.result === 'string' ? body.result : '';

    // The worker answers a miss in prose rather than with an empty payload.
    // Treat those as nothing found — they are not memories.
    if (/^No cortex (memories|thoughts) found/im.test(result.trim())) return '';
    return result.trim();
  } catch {
    // Abort, network failure, bad JSON — all the same answer: no recall.
    return '';
  } finally {
    clearTimeout(timer);
  }
}
