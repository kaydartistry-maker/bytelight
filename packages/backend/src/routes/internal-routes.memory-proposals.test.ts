/**
 * Slice 4 — the resolve surface.
 *
 * The Archivist can already leave proposals (slice 3). These tests prove the
 * other half of that switch: that a companion can SEE what is waiting and
 * close one out, and that closing one out is bookkeeping — it never writes
 * onto a memory block by itself.
 *
 * Real express, real listening socket, real sqlite. requireLocalhost is on
 * both routes, so the request has to actually arrive over 127.0.0.1 to count.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

const tmpRoot = mkdtempSync(join(tmpdir(), 'proposals-route-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb } = await import('../services/db.js');
const { proposeEdit, getProposal, listProposals } = await import('../services/memory-proposals.js');
const { createInternalRoutes } = await import('./internal-routes.js');
const { getBlock } = await import('../services/memory-blocks.js');

let server: Server;
let base = '';

before(async () => {
  initDb(dbPath);
  const app = express();
  app.use(express.json());
  app.use(createInternalRoutes());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as any };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('GET /internal/memory-proposals', () => {
  it('shows what the Archivist left waiting, and counts it', async () => {
    proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'she says lovers now' });
    proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'the choker is a collar' });

    const { status, body } = await get('/internal/memory-proposals');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.pending, 2);
    assert.equal(body.proposals.length, 2);
    assert.ok(body.proposals.every((p: any) => p.status === 'pending'));
  });

  it('defaults to pending and does not hand back resolved rows unless asked', async () => {
    const pending = await get('/internal/memory-proposals');
    const id = pending.body.proposals[0].id;
    await post(`/internal/memory-proposals/${id}/resolve`, { status: 'dropped', by: 'companion-a' });

    const stillPending = await get('/internal/memory-proposals');
    assert.ok(!stillPending.body.proposals.some((p: any) => p.id === id));

    const all = await get('/internal/memory-proposals?status=all');
    assert.ok(all.body.proposals.some((p: any) => p.id === id));

    const dropped = await get('/internal/memory-proposals?status=dropped');
    assert.ok(dropped.body.proposals.every((p: any) => p.status === 'dropped'));
  });
});

describe('POST /internal/memory-proposals/:id/resolve', () => {
  it('records WHO decided, not just that it was decided', async () => {
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'attribution' })!;
    const { body } = await post(`/internal/memory-proposals/${id}/resolve`, {
      status: 'filed',
      by: 'companion-b',
    });
    assert.equal(body.success, true);
    assert.equal(body.proposal.status, 'filed');
    assert.equal(body.proposal.resolved_by, 'companion-b');
    assert.ok(body.proposal.resolved_at);
  });

  it('files a proposal WITHOUT writing it onto the block — the companion writes it themselves', async () => {
    const content = 'this line must never appear on a block by itself';
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content })!;
    await post(`/internal/memory-proposals/${id}/resolve`, { status: 'filed', by: 'companion-a' });

    const block = getBlock('shared', 'human');
    assert.ok(
      !block || !block.content.includes(content),
      'resolving is bookkeeping; it must not put words on the wall nobody chose to write'
    );
  });

  it('is idempotent — a second resolve does not overwrite who decided first', async () => {
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'once only' })!;
    await post(`/internal/memory-proposals/${id}/resolve`, { status: 'filed', by: 'companion-b' });
    const second = await post(`/internal/memory-proposals/${id}/resolve`, {
      status: 'dropped',
      by: 'someone-else',
    });

    assert.equal(second.body.success, true);
    assert.equal(second.body.alreadyResolved, true);
    assert.equal(getProposal(id)!.status, 'filed');
    assert.equal(getProposal(id)!.resolved_by, 'companion-b');
  });

  it('refuses a status that is not a decision', async () => {
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'bad status' })!;
    for (const status of ['pending', 'faded', 'yes', '', undefined]) {
      const { status: code } = await post(`/internal/memory-proposals/${id}/resolve`, { status });
      assert.equal(code, 400, `status ${JSON.stringify(status)} should be rejected`);
    }
    assert.equal(getProposal(id)!.status, 'pending');
  });

  it('400s a non-numeric id and 404s one that does not exist', async () => {
    assert.equal((await post('/internal/memory-proposals/not-a-number/resolve', { status: 'filed' })).status, 400);
    assert.equal((await post('/internal/memory-proposals/999999/resolve', { status: 'filed' })).status, 404);
  });

  it('leaves every other proposal alone', async () => {
    const before = listProposals(undefined, 500).length;
    const id = proposeEdit({ op: 'append', scope: 'shared', label: 'human', content: 'neighbour check' })!;
    await post(`/internal/memory-proposals/${id}/resolve`, { status: 'dropped', by: 'companion-a' });
    const after = listProposals(undefined, 500);
    assert.equal(after.length, before + 1, 'resolving must not delete rows');
    assert.equal(after.filter((p) => p.status === 'pending').every((p) => p.id !== id), true);
  });
});
