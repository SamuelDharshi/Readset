#!/usr/bin/env node
// Bin entry for the Readset MCP server.
// The repo ships TypeScript sources (no build step: package main points at src/), so this
// shim registers tsx's ESM loader and then imports the real stdio entry point.
// stdout is reserved for MCP frames; diagnostics go to stderr.
try {
  const { register } = await import('tsx/esm/api');
  register();
} catch (e) {
  console.error(
    'readset-mcp needs tsx to run the TypeScript sources. Install it (npm i -D tsx) or run ' +
      '`npx tsx packages/mcp/src/bin.ts` directly. Cause: ' + (e?.message ?? e),
  );
  process.exit(1);
}
await import('../src/bin.ts');
