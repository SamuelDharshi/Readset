/**
 * READSET_OFFLINE=1 makes every network-backed test skip deliberately, instead of each suite
 * discovering the network is down by probing it.
 *
 * Why this exists: the live tests are the ones that prove Readset works against the real chain,
 * so they must stay the default. But CI and a demo machine cannot be held hostage to a throttled
 * public RPC. With the flag set, `packages/core/test/offline.test.ts` still runs and still covers
 * the engine's pure logic against recorded real traces.
 *
 *   npx vitest run                      # everything, live RPC included
 *   READSET_OFFLINE=1 npx vitest run    # fixtures only, no network
 */
export function offline(): boolean {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.READSET_OFFLINE;
  return v === '1' || v === 'true';
}

/** Reason string for a skipped live test, so the output says why rather than going quiet. */
export const OFFLINE_REASON =
  'READSET_OFFLINE=1: skipping live-RPC tests. Recorded-fixture tests still ran.';
