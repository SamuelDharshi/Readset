/**
 * @readset/mcp — the Readset gate, breaker and receipts as an MCP server.
 *
 * Run it over stdio with the bin entry `readset-mcp` (see docs/mcp.md for the exact
 * Claude Code / Claude Desktop config), or embed `createReadsetServer()` in your own host.
 */
export { createReadsetServer, registerExplainTool, SERVER_NAME, SERVER_VERSION } from './server.js';
export type { ReadsetServerOptions } from './server.js';

/** Tool names this server registers. readset_explain only when @readset/core exports `explain`. */
export const TOOL_NAMES = ['readset_send', 'readset_status', 'readset_policy', 'readset_explain'] as const;
