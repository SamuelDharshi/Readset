/**
 * stdio entry point for the Readset MCP server.
 * Nothing but MCP frames may go to stdout, so all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makePublicClient } from '@readset/core';
import type { PublicClient } from 'viem';
import { createReadsetServer, registerExplainTool, SERVER_NAME, SERVER_VERSION } from './server.js';

export async function main(): Promise<void> {
  const publicClient = makePublicClient() as PublicClient;
  const { server, info } = createReadsetServer({ publicClient });
  const explain = await registerExplainTool(server, publicClient);
  await server.connect(new StdioServerTransport());
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} on stdio: chain ${info.chainId} (${info.network}) via ${info.rpcUrl}; ` +
      `signer ${info.signerConfigured ? 'configured' : 'ABSENT (readset_send send=true will refuse)'}; ` +
      `readset_explain ${explain ? 'registered' : 'not available (@readset/core does not export explain yet)'}`,
  );
}

main().catch((e: unknown) => {
  console.error(`readset mcp failed to start: ${(e as Error).message}`);
  process.exit(1);
});
