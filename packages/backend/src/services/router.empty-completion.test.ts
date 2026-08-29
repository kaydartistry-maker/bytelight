/**
 * Regression pin for the OpenRouter "[No response from model]" corpse bug.
 *
 * When an OpenAI-compatible provider (OpenRouter/Grok etc.) returns a
 * 200 response whose final completion carries empty content across the
 * whole tool loop AND the max-iterations nudge, `inferenceWithTools` used
 * to fabricate the literal string '[No response from model]' as the `done`
 * content. That non-empty placeholder rode downstream as a real
 * `text_delta` (api-router.ts) and slipped past the agent's empty-stream
 * corpse suppression (which only skips persistence when the response text
 * is blank — agent.ts), leaving a visible corpse in the thread with no
 * real model turn behind it.
 *
 * Fix: the no-tools empty case yields empty content ('') so the shared
 * empty-stream path suppresses persistence. The tools-ran case keeps its
 * factual `[Used tools: …]` trailer (tools genuinely executed).
 *
 * These tests stub global fetch — no network, no DB, no server.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inferenceWithTools, type ProviderConfig, type ToolSchema, type InferenceEvent } from './router.js';

const CONFIG: ProviderConfig = { openrouter: { api_key: 'test-key' } };

// A minimal OpenAI-compat 200 response whose assistant message has empty
// content and no tool_calls — the "silent model" shape.
function emptyCompletionResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: '', tool_calls: [] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function drain(gen: AsyncGenerator<InferenceEvent, void, void>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('inferenceWithTools — empty-completion fallback (OpenRouter corpse fix)', () => {
  test('no-tools path yields EMPTY content, never the "[No response]" placeholder', async () => {
    // Every request returns an empty completion → loop breaks immediately,
    // nudge also empty → fallback fires.
    globalThis.fetch = (async () => emptyCompletionResponse()) as typeof globalThis.fetch;

    const events = await drain(
      inferenceWithTools(
        [{ role: 'user', content: 'hey' }],
        'x-ai/grok-4.5',
        'openrouter',
        CONFIG,
        [], // no tools offered
        async () => ({ result: '', ok: true }),
      ),
    );

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'expected a done event');
    assert.equal(done!.type === 'done' && done!.content, '', 'empty completion must yield empty content, not a placeholder corpse');
    // The pre-fix behavior would have produced this string; guard against regression.
    assert.notEqual(
      done!.type === 'done' && done!.content,
      '[No response from model]',
      'must not fabricate the "[No response from model]" placeholder',
    );
  });

  test('tools-ran path keeps the factual "[Used tools: …]" trailer', async () => {
    const tool: ToolSchema = { name: 'search', description: 'search', input_schema: { type: 'object' } };

    // First call: model asks for a tool. Subsequent calls: empty completions,
    // so the loop exhausts / nudge empties and the tools-ran fallback fires.
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{}' } }] } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return emptyCompletionResponse();
    }) as typeof globalThis.fetch;

    const events = await drain(
      inferenceWithTools(
        [{ role: 'user', content: 'find it' }],
        'x-ai/grok-4.5',
        'openrouter',
        CONFIG,
        [tool],
        async () => ({ result: 'ok', ok: true }),
      ),
    );

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'expected a done event');
    assert.ok(
      done!.type === 'done' && done!.content.startsWith('[Used tools:'),
      `tools-ran fallback must keep its factual trailer, got: ${done!.type === 'done' ? done!.content : '(none)'}`,
    );
  });
});
