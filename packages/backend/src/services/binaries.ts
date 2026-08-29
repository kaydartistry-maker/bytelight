/**
 * External binary discovery. Every spawn of a system tool goes through here:
 * env override first (FFMPEG_PATH, GIFSICLE_PATH, FC_LIST_PATH), then a bare
 * command name so the OS resolves it via PATH — which covers /usr/bin on the
 * production VM and package managers everywhere else. Missing binaries stay a
 * clean runtime error (spawn ENOENT), never a hardcoded wrong path.
 */
import { spawnSync } from 'child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const GIFSICLE = process.env.GIFSICLE_PATH || 'gifsicle';
export const FC_LIST = process.env.FC_LIST_PATH || 'fc-list';

/** True when the binary can actually be spawned (probed with --help/-version). */
export function binaryAvailable(binary: string): boolean {
  return !spawnSync(binary, ['-version'], { stdio: 'ignore', timeout: 5000 }).error;
}
