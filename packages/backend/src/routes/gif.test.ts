import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, openSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Stage fixtures before importing the route: its TTL sweep runs at module load.
process.env.GIF_SESSION_TTL_HOURS = '48';
process.env.GIF_SESSION_MAX_MB = '64';

const { PROJECT_ROOT } = await import('../config.js');
const WORK_DIR = join(PROJECT_ROOT, 'data', 'gif-work');
const UPLOAD_DIR = join(WORK_DIR, 'uploads');
const STALE = 'test-stale-session';
const FRESH = 'test-fresh-session';
const CAPPED = 'test-capped-session';
const FULL = 'test-full-session';
const FIT = 'test-fit-session';
const KEEP = 'test-keep-session';
const ALL = [STALE, FRESH, CAPPED, FULL, FIT, KEEP];

const days = (n: number) => n * 24 * 60 * 60 * 1000;
function stageSession(name: string, files: Record<string, string | Buffer>, ageMs = 0): void {
  const dir = join(WORK_DIR, name);
  mkdirSync(dir, { recursive: true });
  const stamp = (Date.now() - ageMs) / 1000;
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
    if (ageMs) utimesSync(join(dir, file), stamp, stamp);
  }
  if (ageMs) utimesSync(dir, stamp, stamp);
}

mkdirSync(UPLOAD_DIR, { recursive: true });
stageSession(STALE, { 'frame-0001.png': 'old' }, days(3));
stageSession(FRESH, { 'frame-0001.png': 'new' });
const SCRAP = join(UPLOAD_DIR, 'test-scrap');
writeFileSync(SCRAP, 'orphaned multer temp file');
utimesSync(SCRAP, (Date.now() - days(3)) / 1000, (Date.now() - days(3)) / 1000);

const gifRouter = (await import('./gif.js')).default;
const { GALLERY_DIR, deleteGalleryItem, getGalleryMeta } = await import('../services/image-gen.js');
let keptGalleryFilename = '';

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type RouteResult = { status: number; body: unknown };
async function invoke(
  method: 'get' | 'post',
  path: string,
  request: Record<string, unknown> = {},
): Promise<RouteResult> {
  const layer = (gifRouter as any).stack.find((candidate: any) =>
    candidate.route?.path === path && candidate.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
  const handler = layer.route.stack.at(-1).handle;
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  await handler(
    { body: {}, params: {}, query: {}, ...request },
    response,
    (error?: unknown) => {
      if (error) throw error;
    },
  );
  return { status, body };
}

after(async () => {
  for (const name of ALL) rmSync(join(WORK_DIR, name), { recursive: true, force: true });
  rmSync(SCRAP, { force: true });
  if (keptGalleryFilename) await deleteGalleryItem(keptGalleryFilename);
});

describe('session sweep', () => {
  it('removes sessions whose newest file is older than the TTL', () => {
    assert.equal(existsSync(join(WORK_DIR, STALE)), false);
  });

  it('protects sessions with recent activity', () => {
    assert.equal(existsSync(join(WORK_DIR, FRESH, 'frame-0001.png')), true);
  });

  it('removes orphaned multer upload scraps', () => {
    assert.equal(existsSync(SCRAP), false);
  });
});

describe('session caps', () => {
  it('rejects uploads past the per-session frame cap', async () => {
    const frames: Record<string, string> = {};
    for (let i = 1; i <= 300; i++) {
      frames[`frame-${String(i).padStart(4, '0')}.png`] = '';
    }
    stageSession(CAPPED, frames);

    const uploadPath = join(UPLOAD_DIR, 'test-capped-upload');
    writeFileSync(uploadPath, TINY_PNG);
    const result = await invoke('post', '/gif/upload-frame', {
      body: { sessionId: CAPPED },
      file: { path: uploadPath, size: TINY_PNG.length, originalname: 'tiny.png' },
    });

    assert.equal(result.status, 400);
    const body = result.body as { error: string };
    assert.match(body.error, /frame limit/i);
    assert.equal(existsSync(uploadPath), false);
  });

  it('returns 413 for writes into a session over the disk cap', async () => {
    stageSession(FULL, { 'big.gif': '' });
    const fd = openSync(join(WORK_DIR, FULL, 'big.gif'), 'r+');
    ftruncateSync(fd, 65 * 1024 * 1024);
    closeSync(fd);

    const saved = await invoke('post', '/gif/save-frame/:sessionId/:filename', {
      params: { sessionId: FULL, filename: 'frame-0001.png' },
      body: { data: `data:image/png;base64,${TINY_PNG.toString('base64')}` },
    });
    assert.equal(saved.status, 413);

    const optimized = await invoke('post', '/gif/optimize/:sessionId/:filename', {
      params: { sessionId: FULL, filename: 'big.gif' },
      body: {},
    });
    assert.equal(optimized.status, 413);
  });
});

describe('maxBytes compatibility', () => {
  it('accepts the request field without bypassing the canonical session guard', async () => {
    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: 'no-such-session',
        frames: ['frame-0001.png'],
        maxBytes: 512 * 1024,
      },
    });
    assert.equal(result.status, 404);
  });

  it('runs the fit ladder and reports the target result', async (t) => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      execFileSync('gifsicle', ['--version'], { stdio: 'ignore' });
    } catch {
      t.skip('ffmpeg and gifsicle are required for the render pipeline');
      return;
    }
    stageSession(FIT, {
      'frame-0001.png': TINY_PNG,
      'frame-0002.png': TINY_PNG,
    });

    const result = await invoke('post', '/gif/create', {
      body: {
        sessionId: FIT,
        frames: ['frame-0001.png', 'frame-0002.png'],
        fps: 10,
        maxBytes: 1,
      },
    });

    assert.equal(result.status, 200);
    const body = result.body as {
      fitApplied: boolean;
      targetKb: number;
      fitMet: boolean;
      discordOk: boolean;
    };
    assert.equal(body.fitApplied, true);
    assert.equal(body.targetKb, 0);
    assert.equal(body.fitMet, false);
    assert.equal(body.discordOk, false);
  });
});

describe('tool status compatibility', () => {
  it('serves identical data from tools/status and the temporary capabilities alias', async () => {
    const [statusResult, aliasResult] = await Promise.all([
      invoke('get', '/gif/tools/status'),
      invoke('get', '/gif/capabilities'),
    ]);
    assert.equal(statusResult.status, 200);
    assert.equal(aliasResult.status, 200);

    const status = statusResult.body as Record<string, unknown>;
    const alias = aliasResult.body as Record<string, unknown>;
    assert.deepEqual(alias, status);
    assert.equal(typeof status.ready, 'boolean');
    assert.equal(typeof status.ffmpeg, 'boolean');
    assert.equal(typeof status.gifsicle, 'boolean');
  });

  it('reports cutout readiness without requiring a configured model', async () => {
    const result = await invoke('get', '/gif/cutout/status');
    assert.equal(result.status, 200);
    const body = result.body as { ready: boolean; reason: string | null };
    assert.equal(typeof body.ready, 'boolean');
    if (!body.ready) assert.equal(typeof body.reason, 'string');
  });
});

describe('keep finished GIF in the Studio gallery', () => {
  it('copies the GIF and records gallery metadata', async () => {
    stageSession(KEEP, { 'finished.gif': Buffer.from('GIF89a') });
    const result = await invoke('post', '/gif/keep/:sessionId/:filename', {
      params: { sessionId: KEEP, filename: 'finished.gif' },
    });

    assert.equal(result.status, 200);
    const body = result.body as { filename: string; url: string; location: string };
    keptGalleryFilename = body.filename;
    assert.match(body.filename, /^gif_.*\.gif$/);
    assert.equal(body.url, `/api/studio/gallery/${encodeURIComponent(body.filename)}`);
    assert.equal(body.location, 'Studio gallery');
    assert.equal(existsSync(join(GALLERY_DIR, body.filename)), true);
    const meta = await getGalleryMeta(body.filename);
    assert.equal(meta?.backend, 'gif');
    assert.equal(meta?.model, 'GIF Studio');
  });

  it('returns 404 when the finished GIF is missing', async () => {
    const result = await invoke('post', '/gif/keep/:sessionId/:filename', {
      params: { sessionId: KEEP, filename: 'missing.gif' },
    });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'GIF not found' });
  });
});
