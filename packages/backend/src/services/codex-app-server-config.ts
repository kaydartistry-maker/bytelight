import { join } from 'node:path';
import { homedir } from 'node:os';
import { MCP_BELT_TOKEN_ENV } from './mcp-belt-auth.js';

export const BYTELIGHT_CODEX_SOCKET = process.env.BYTELIGHT_CODEX_SOCKET
  || join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control',
    'bytelight-app-server.sock',
  );

export const BYTELIGHT_MCP_BELT_URL = process.env.BYTELIGHT_MCP_BELT_URL
  || 'http://127.0.0.1:3002/mcp/belt';

/**
 * Override the whole local MCP table for the app-server byte-light owns. This
 * prevents ordinary Codex sessions from inheriting thread-aware byte-light
 * tools while leaving Codex-owned account/app surfaces in Codex's own layer.
 */
export function codexAppServerArgs(beltUrl = BYTELIGHT_MCP_BELT_URL): string[] {
  const mcpConfig = `mcp_servers={bytelight={url="${beltUrl}",bearer_token_env_var="${MCP_BELT_TOKEN_ENV}"}}`;
  return [
    '--dangerously-bypass-approvals-and-sandbox',
    'app-server',
    '--listen', `unix://${BYTELIGHT_CODEX_SOCKET}`,
    '-c', mcpConfig,
  ];
}
