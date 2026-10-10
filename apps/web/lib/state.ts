import path from 'node:path';

/**
 * Receipts, policy and breaker state live in ONE place for the whole repo.
 *
 * Next runs with cwd = apps/web, so core's default of `<cwd>/.readset` would point this app at
 * its own empty directory while the viem wrapper, the MCP server and the plugin all write to the
 * repo root. Every route therefore passes this root explicitly.
 */
export const STATE_ROOT =
  process.env.READSET_HOME?.trim() ||
  process.env.READSET_STATE_DIR?.trim() ||
  path.resolve(process.cwd(), '../../.readset');
