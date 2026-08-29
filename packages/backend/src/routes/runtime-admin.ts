// Ported from reference implementation (reference implementation) — adapted for byte-light.
//
// Mounted at `/runtime` in api.ts, AFTER authMiddleware, so
// GET /api/runtime/health and POST /api/runtime/update-sdk both sit
// behind byte-light's auth boundary.

import { Router, type Request, type Response } from 'express';
import { spawn } from 'child_process';
import { PROJECT_ROOT, getBytelightConfig } from '../config.js';
import {
  getRuntimeHealth,
  getActiveRuntimeVersion,
  getInstalledRuntimeVersion,
} from '../services/runtime-health.js';

const router = Router();
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const TAIL_BYTES = 2000;

// Module-level lock — prevents two concurrent SDK updates from racing.
// Survives across HTTP requests but NOT across backend restarts (which
// is the right behavior — restart effectively releases the lock since
// any in-flight install was either complete or interrupted).
const updateSdkLock = { running: false };

/**
 * Read-only health snapshot. Active runtime (cached at module load),
 * installed runtime (fresh from disk), system Claude Code, computed
 * minimum requirement across configured tiers, restart-required flag.
 */
router.get('/runtime/health', (_req: Request, res: Response) => {
  try {
    res.json(getRuntimeHealth());
  } catch (error) {
    console.error('Runtime health read error:', error);
    res.status(500).json({ error: 'Failed to read runtime health' });
  }
});

/**
 * Destructive: runs `npm install @anthropic-ai/claude-agent-sdk@latest`
 * in the repo root. Modifies `package-lock.json` and possibly
 * `packages/backend/package.json`. Backend restart required after.
 *
 * Auth gating: requires `auth.password` to be configured in bytelight.yaml.
 * The existing authMiddleware in api.ts validates the session before this
 * handler runs. We deliberately do NOT fall back to a "direct localhost"
 * check in passwordless mode: when the backend sits behind a same-host
 * reverse proxy (e.g. nginx forwarding from a public interface to
 * 127.0.0.1), the TCP peer is always loopback, so any localhost-based
 * fallback would expose this destructive endpoint to the public internet.
 * Setting a password is the only safe gate here.
 *
 * Concurrency: in-memory lock prevents two simultaneous updates.
 */
router.post('/runtime/update-sdk', async (_req: Request, res: Response) => {
  const cfg = getBytelightConfig();
  if (!cfg.auth.password) {
    res.status(403).json({
      error: 'Set auth.password in bytelight.yaml before using in-app SDK updates. Passwordless deployments cannot trigger destructive runtime changes (a same-host reverse proxy would otherwise make this endpoint publicly reachable).',
    });
    return;
  }

  if (updateSdkLock.running) {
    res.status(409).json({ error: 'An SDK update is already in progress' });
    return;
  }
  updateSdkLock.running = true;

  try {
    // Platform-aware npm command — `npm.cmd` on Windows, `npm` elsewhere.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    // Use spawn (not execFile) so npm progress streams to the backend
    // terminal in real time. We still buffer stdout/stderr so the UI
    // response can include the last 2KB of each on failure.
    console.log('[Runtime SDK] update started');

    const { stdoutTail, stderrTail, exitCode, timedOut } = await new Promise<{
      stdoutTail: string;
      stderrTail: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      // `shell: true` is required on Windows since Node 20.12 / 18.20 to
      // spawn `.cmd`/`.bat` files (CVE-2024-27980 hardening). The args are
      // all static literals — no user input — so shell expansion isn't a
      // vector here.
      const child = spawn(
        npm,
        ['install', '@anthropic-ai/claude-agent-sdk@latest', '--workspace=packages/backend'],
        {
          cwd: PROJECT_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        },
      );

      let stdoutBuf = '';
      let stderrBuf = '';
      let timedOutFlag = false;

      const timer = setTimeout(() => {
        timedOutFlag = true;
        child.kill('SIGKILL');
      }, UPDATE_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        stdoutBuf = (stdoutBuf + s).slice(-TAIL_BYTES);
        process.stdout.write(`[Runtime SDK] ${s}`);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        stderrBuf = (stderrBuf + s).slice(-TAIL_BYTES);
        process.stderr.write(`[Runtime SDK] ${s}`);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdoutTail: stdoutBuf,
          stderrTail: stderrBuf,
          exitCode: code,
          timedOut: timedOutFlag,
        });
      });
    });

    if (timedOut) {
      console.error(`[Runtime SDK] update timed out after ${UPDATE_TIMEOUT_MS}ms`);
      res.status(500).json({
        success: false,
        error: `npm install timed out after ${UPDATE_TIMEOUT_MS / 1000}s`,
        stdoutTail,
        stderrTail,
      });
      return;
    }

    if (exitCode !== 0) {
      console.error(`[Runtime SDK] update failed (exit ${exitCode})`);
      res.status(500).json({
        success: false,
        error: `npm install exited with code ${exitCode}`,
        stdoutTail,
        stderrTail,
      });
      return;
    }

    console.log('[Runtime SDK] update complete — restart required');
    res.json({
      success: true,
      newInstalledVersion: getInstalledRuntimeVersion(),
      activeVersion: getActiveRuntimeVersion(),
      restartRequired: true,
      message: 'SDK updated. Restart the backend for the new bundled runtime to load.',
      stdoutTail,
    });
  } catch (error) {
    const err = error as { message?: string };
    console.error('[Runtime SDK] update threw:', err?.message ?? error);
    res.status(500).json({
      success: false,
      error: err?.message ?? String(error),
    });
  } finally {
    updateSdkLock.running = false;
  }
});

export default router;
