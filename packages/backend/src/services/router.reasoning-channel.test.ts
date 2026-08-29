/**
 * Regression pins for the reasoning-channel fix (H4 leg 1).
 *
 * Reasoning models never showed thinking blocks on the API lanes: the
 * stream parser read only `delta.content`, dropping the separate
 * reasoning channel (OpenRouter `delta.reasoning`, DeepSeek-native
 * `delta.reasoning_content`, Ollama-native `message.thinking`), and the
 * request never asked for the channel. The fix wraps reasoning tokens in
 * the synthetic <think>…</think> stream protocol the downstream
 * api-router state machine already parses into thinking_delta events.
 *
 * These tests stub global fetch — no network, no DB, no server.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  streamInference,
  inferenceWithTools,
  type ProviderConfig,
  type StreamInferenceEvent,
  type InferenceEvent,
} from './router.js';

const OPENROUTER_CONFIG: ProviderConfig = { openrouter: { api_key: 'test-key' } };

function sseResponse(chunks: unknown[], withDone = true): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join('')
    + (withDone ? 'data: [DONE]\n' : '');
  return new Response(body, { status: 200 });
}

async function drainTokens(gen: AsyncGenerator<StreamInferenceEvent>): Promise<string> {
  let out = '';
  for await (const ev of gen) {
    if (ev.type === 'token') out += ev.text;
  }
  return out;
}

async function drainEvents(gen: AsyncGenerator<InferenceEvent, void, void>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('streamInference — OpenAI-compat reasoning channel', () => {
  test('delta.reasoning tokens are wrapped in <think>…</think> before content', async () => {
    globalThis.fetch = (async () => sseResponse([
      { choices: [{ delta: { reasoning: 'step one. ' } }] },
      { choices: [{ delta: { reasoning: 'step two.' } }] },
      { choices: [{ delta: { content: 'Hello the operator' } }] },
    ])) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, true),
    );
    assert.equal(text, '<think>step one. step two.</think>\nHello the operator');
  });

  test('DeepSeek-native delta.reasoning_content is treated the same', async () => {
    globalThis.fetch = (async () => sseResponse([
      { choices: [{ delta: { reasoning_content: 'pondering' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
    ])) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'deepseek-reasoner', 'openrouter', OPENROUTER_CONFIG, true),
    );
    assert.equal(text, '<think>pondering</think>\nanswer');
  });

  test('reasoning-only stream still closes the block at [DONE]', async () => {
    globalThis.fetch = (async () => sseResponse([
      { choices: [{ delta: { reasoning: 'all thought, no talk' } }] },
    ])) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, true),
    );
    assert.equal(text, '<think>all thought, no talk</think>\n');
  });

  test('stream ending without [DONE] also closes an open reasoning block', async () => {
    globalThis.fetch = (async () => sseResponse([
      { choices: [{ delta: { reasoning: 'cut off mid-thought' } }] },
    ], false)) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, true),
    );
    assert.equal(text, '<think>cut off mid-thought</think>\n');
  });

  test('plain content stream is unchanged (no reasoning channel, no wrapping)', async () => {
    globalThis.fetch = (async () => sseResponse([
      { choices: [{ delta: { content: 'just words' } }] },
    ])) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'meta-llama/llama-3-8b', 'openrouter', OPENROUTER_CONFIG, true),
    );
    assert.equal(text, 'just words');
  });

  test('thinking=true sends the OpenRouter reasoning param; thinking=false omits it', async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }]);
    }) as typeof globalThis.fetch;

    await drainTokens(streamInference([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, true));
    await drainTokens(streamInference([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, false));

    assert.deepEqual(bodies[0].reasoning, { effort: 'high' });
    assert.equal('reasoning' in bodies[1], false);
  });
});

describe('streamInference — Ollama native reasoning channel', () => {
  const OLLAMA_CONFIG: ProviderConfig = { ollama: { base_url: 'http://localhost:11434' } } as ProviderConfig;

  function nativeLines(chunks: unknown[]): Response {
    return new Response(chunks.map(c => `${JSON.stringify(c)}\n`).join(''), { status: 200 });
  }

  test('message.thinking wraps in <think>; think:true rides the native request', async () => {
    const bodies: any[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return new Response('nope', { status: 404 }); // OpenAI-compat fails → native fallback
      return nativeLines([
        { message: { thinking: 'hmm' } },
        { message: { content: 'oi' } },
        { done: true, message: { content: '' } },
      ]);
    }) as typeof globalThis.fetch;

    const text = await drainTokens(
      streamInference([{ role: 'user', content: 'hi' }], 'qwen3', 'ollama', OLLAMA_CONFIG, true),
    );
    assert.equal(text, '<think>hmm</think>\noi');
    assert.equal(bodies[1].think, true);
  });
});

describe('inferenceWithTools — non-streaming reasoning channel', () => {
  test('message.reasoning is re-wrapped as a leading <think> block', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'final answer', reasoning: 'chain of thought' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof globalThis.fetch;

    const events = await drainEvents(
      inferenceWithTools([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-r1', 'openrouter', OPENROUTER_CONFIG, [], async () => ({ result: '', ok: true }), true),
    );
    const done = events.find(e => e.type === 'done') as Extract<InferenceEvent, { type: 'done' }>;
    assert.equal(done.content, '<think>chain of thought</think>\nfinal answer');
  });

  test('no reasoning field → content passes through untouched', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'plain' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof globalThis.fetch;

    const events = await drainEvents(
      inferenceWithTools([{ role: 'user', content: 'hi' }], 'x-ai/grok-4.5', 'openrouter', OPENROUTER_CONFIG, [], async () => ({ result: '', ok: true }), false),
    );
    const done = events.find(e => e.type === 'done') as Extract<InferenceEvent, { type: 'done' }>;
    assert.equal(done.content, 'plain');
  });
});
