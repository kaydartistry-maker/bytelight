/**
 * API-backed foreign runtimes need byte-light to carry ToolDefinition[] into
 * the turn. The warm Codex CLI daemon owns MCP itself and must not perform the
 * same managed-server discovery before connecting to /mcp/belt again.
 */
export function runtimeNeedsRouterToolPayload(runtimeId: string): boolean {
  return runtimeId !== 'codex-cli';
}
