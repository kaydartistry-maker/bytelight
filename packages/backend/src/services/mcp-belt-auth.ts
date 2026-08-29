import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MCP_BELT_TOKEN_ENV = 'BYTELIGHT_MCP_BELT_TOKEN';
const TOKEN_FILE = join(process.cwd(), 'data', 'runtime', 'mcp-belt-token');

let cachedToken: string | null = null;

/**
 * One private credential shared only by byte-light and the Codex app-server
 * process it owns. The file survives backend restarts so an adopted warm
 * daemon keeps working; mode 0600 keeps it inside the single-user boundary.
 */
export function getMcpBeltToken(): string {
  const fromEnv = process.env[MCP_BELT_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (cachedToken) return cachedToken;

  if (existsSync(TOKEN_FILE)) {
    const stored = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (stored) {
      cachedToken = stored;
      return stored;
    }
  }

  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const generated = randomBytes(32).toString('base64url');
  try {
    writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(TOKEN_FILE, 0o600);
    cachedToken = generated;
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!winner) throw new Error('MCP belt token file exists but is empty');
    cachedToken = winner;
    return winner;
  }
}

export function bearerTokenFromHeader(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function validMcpBeltBearer(header: string | string[] | undefined, expected = getMcpBeltToken()): boolean {
  const actual = bearerTokenFromHeader(header);
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function _resetMcpBeltTokenForTests(): void {
  cachedToken = null;
}
