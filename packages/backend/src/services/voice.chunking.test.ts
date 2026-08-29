import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Configure TTS via env BEFORE constructing the service — getSecret falls
// back to env when the DB isn't initialized (test process has no DB).
process.env.ELEVENLABS_API_KEY = 'test-key';
process.env.ELEVENLABS_VOICE_ID = 'test-voice';

const { VoiceService } = await import('./voice.js');

const LIMIT = VoiceService.TTS_CHUNK_LIMIT;

describe('VoiceService.chunkTextForTTS', () => {
  it('passes under-limit text through untouched as a single chunk', () => {
    const text = 'hey friend\n\n-# be good\n\nsee you soon  ';
    assert.deepEqual(VoiceService.chunkTextForTTS(text), [text]);
  });

  it('passes text at exactly the limit through untouched', () => {
    const text = 'word '.repeat(LIMIT / 5); // exactly 4500 chars
    assert.equal(text.length, LIMIT);
    assert.deepEqual(VoiceService.chunkTextForTTS(text), [text]);
  });

  it('splits text one char over the limit into multiple chunks, all within it', () => {
    const text = 'a'.repeat(LIMIT) + 'b';
    const chunks = VoiceService.chunkTextForTTS(text);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= LIMIT);
    assert.equal(chunks.join(''), text);
  });

  it('prefers paragraph boundaries', () => {
    const chunks = VoiceService.chunkTextForTTS(
      'Alpha beta gamma.\n\nDelta epsilon zeta.',
      25,
    );
    assert.deepEqual(chunks, ['Alpha beta gamma.', 'Delta epsilon zeta.']);
  });

  it('falls back to sentence boundaries inside an oversized paragraph', () => {
    const chunks = VoiceService.chunkTextForTTS(
      'One two three. Four five six. Seven eight nine.',
      25,
    );
    assert.deepEqual(chunks, ['One two three.', 'Four five six.', 'Seven eight nine.']);
  });

  it('packs multiple sentences per chunk when they fit', () => {
    const chunks = VoiceService.chunkTextForTTS(
      'One two three. Four five six. Seven eight nine.',
      31,
    );
    assert.deepEqual(chunks, ['One two three. Four five six.', 'Seven eight nine.']);
  });

  it('never splits mid-word when text has no sentence punctuation', () => {
    const word = 'supercalifragilistic';
    const text = (word + ' ').repeat(40).trim(); // no . ! ? — forces word-level splits
    const chunks = VoiceService.chunkTextForTTS(text, 50);
    assert.ok(chunks.length > 1);
    const words = chunks.flatMap(c => c.split(/\s+/));
    for (const w of words) assert.equal(w, word);
    assert.equal(words.length, 40); // every word survives, none broken
    for (const c of chunks) assert.ok(c.length <= 50);
  });

  it('preserves every word across chunks of realistic long text', () => {
    const text = ('The jungle hums tonight. Candles flicker by the waterfall, ' +
      'and the fire cracks low.\n\n').repeat(80); // ~7000 chars
    const chunks = VoiceService.chunkTextForTTS(text);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= LIMIT);
    const original = text.split(/\s+/).filter(Boolean);
    const rejoined = chunks.join(' ').split(/\s+/).filter(Boolean);
    assert.deepEqual(rejoined, original);
  });

  it('hard-slices a single word longer than the limit (last resort)', () => {
    const text = 'x'.repeat(100);
    const chunks = VoiceService.chunkTextForTTS(text, 30);
    for (const c of chunks) assert.ok(c.length <= 30);
    assert.equal(chunks.join(''), text);
  });
});

describe('VoiceService.generateTTS chunked API calls (mocked fetch)', () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; body: { text: string; model_id: string; voice_settings: unknown } }>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const buf = Buffer.from(`SEG${calls.length}|`);
      return {
        ok: true,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('under-limit text makes exactly one API call with the text unchanged', async () => {
    const svc = new VoiceService();
    const out = await svc.generateTTS('hey friend, long day?');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.text, 'hey friend, long day?');
    assert.equal(out.toString(), 'SEG1|');
  });

  it('over-limit text fans out to multiple calls and concatenates in order', async () => {
    const svc = new VoiceService();
    const text = 'One two three. Four five six. '.repeat(220); // 6600 chars
    const out = await svc.generateTTS(text);
    assert.ok(calls.length > 1);
    for (const call of calls) {
      assert.ok(call.body.text.length <= LIMIT);
      assert.equal(call.body.model_id, 'eleven_v3');
    }
    const expected = calls.map((_, i) => `SEG${i + 1}|`).join('');
    assert.equal(out.toString(), expected);
  });

  it('applies whisperSubtext before chunking (no -# spoken in any chunk)', async () => {
    const svc = new VoiceService();
    const text = ('A long paragraph of prose sits here.\n\n-# be good\n\n').repeat(150);
    await svc.generateTTS(text);
    assert.ok(calls.length > 1);
    const sent = calls.map(c => c.body.text).join('\n');
    assert.ok(!/^-#\s/m.test(sent));
    assert.ok(sent.includes('[whispers] be good'));
  });

  it('uses the same voice settings on every chunk', async () => {
    const svc = new VoiceService();
    const text = 'Steady prose, sentence by sentence. '.repeat(200); // 7200 chars
    await svc.generateTTS(text);
    assert.ok(calls.length > 1);
    for (const call of calls) {
      assert.deepEqual(call.body.voice_settings, { stability: 0.5, similarity_boost: 0.75 });
      assert.ok(call.url.endsWith('/test-voice'));
    }
  });
});
