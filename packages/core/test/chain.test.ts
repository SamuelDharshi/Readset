import { describe, expect, it, beforeAll } from 'vitest';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import {
  makePublicClient,
  makeWalletClient,
  probeCapabilities,
  resolveNetwork,
  resolveChainConfig,
  monadTestnet,
  monadMainnet,
  redactUrl,
} from '../src/chain/index.js';

const env = { READSET_NETWORK: 'testnet' } as Record<string, string | undefined>;
let reachable = false;
let reason = '';

beforeAll(async () => {
  try {
    const c = makePublicClient({ env, retryCount: 1, timeoutMs: 8000 });
    if (offline()) { reason = OFFLINE_REASON; return; }
    reachable = (await c.getChainId()) === 10143;
    if (!reachable) reason = 'public testnet RPC returned unexpected chain id';
  } catch (e) {
    reason = `Monad testnet RPC unreachable: ${(e as Error).message.split('\n')[0]}`;
  }
  if (!reachable) console.warn(`SKIPPING chain integration tests: ${reason}`);
}, 30_000);

describe('config logic', () => {
  it('resolves networks', () => {
    expect(resolveNetwork('testnet').id).toBe(10143);
    expect(resolveNetwork('mainnet').id).toBe(143);
    expect(() => resolveNetwork('nope')).toThrow(/READSET_NETWORK/);
    expect(monadTestnet.nativeCurrency.symbol).toBe('MON');
    expect(monadMainnet.nativeCurrency.symbol).toBe('MON');
  });
  it('prefers override, then alchemy, then public', () => {
    expect(resolveChainConfig({ env: { READSET_RPC_URL: 'http://x', ALCHEMY_API_KEY: 'k' } }).rpcSource).toBe(
      'READSET_RPC_URL',
    );
    const a = resolveChainConfig({ env: { ALCHEMY_API_KEY: 'k', READSET_NETWORK: 'mainnet' } });
    expect(a.rpcUrl).toBe('https://monad-mainnet.g.alchemy.com/v2/k');
    expect(redactUrl(a.rpcUrl)).toBe('https://monad-mainnet.g.alchemy.com/v2/***');
    expect(resolveChainConfig({ env: {} }).rpcSource).toBe('public');
  });
  it('wallet client requires READSET_PRIVATE_KEY and never echoes it', () => {
    expect(() => makeWalletClient({ env: {} })).toThrow(/READSET_PRIVATE_KEY/);
    // legacy HOTSLOT_* names still work as fallback; READSET_* wins
    expect(resolveChainConfig({ env: { HOTSLOT_NETWORK: 'mainnet' } }).network).toBe('mainnet');
    expect(resolveChainConfig({ env: { HOTSLOT_RPC_URL: 'http://legacy' } }).rpcUrl).toBe('http://legacy');
    expect(resolveChainConfig({ env: { READSET_NETWORK: 'testnet', HOTSLOT_NETWORK: 'mainnet' } }).network).toBe('testnet');
    const anvil = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(makeWalletClient({ env: { HOTSLOT_PRIVATE_KEY: anvil } }).account.address).toMatch(/^0x/);
    const bad = '0x1234';
    expect(() => makeWalletClient({ env: { READSET_PRIVATE_KEY: bad } })).toThrow(/READSET_PRIVATE_KEY is malformed/);
    // Public anvil dev key; only builds a local account, no network call.
    const w = makeWalletClient({
      env: { READSET_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
    });
    expect(w.account.address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });
});

describe('real Monad testnet RPC', () => {
  const live = (name: string, fn: () => Promise<void>) =>
    it(
      name,
      async (ctx) => {
        if (!reachable) return ctx.skip(reason);
        await fn();
      },
      90_000,
    );

  live('chain id and blocks are real', async () => {
    const c = makePublicClient({ env });
    expect(await c.getChainId()).toBe(10143);
    const n = await c.getBlockNumber();
    expect(n).toBeGreaterThan(1_000_000n);
    const blk = await c.getBlock({ blockNumber: n });
    expect(blk.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  live('probeCapabilities reports real data', async () => {
    const caps = await probeCapabilities(makePublicClient({ env }));
    expect(caps.chainId).toBe(10143);
    expect(caps.blockNumber).toBeGreaterThan(0n);
    expect(caps.clientVersion).toMatch(/Monad/i);
    expect(caps.probeTx).toMatch(/^0x[0-9a-f]{64}$/);
    for (const k of [
      'supportsCreateAccessList',
      'supportsDebugTraceTransaction',
      'supportsDebugTraceCall',
      'supportsPrestateTracer',
      'supportsTraceBlock',
    ] as const) {
      expect(['supported', 'unsupported', 'unknown']).toContain(caps[k].status);
      if (caps[k].status !== 'supported') expect(caps[k].error).toBeTruthy();
    }
    // Rate limiting yields 'unknown' (tolerated); a positive 'unsupported' is a failure.
    expect(caps.supportsCreateAccessList.status).not.toBe('unsupported');
    expect(caps.supportsDebugTraceTransaction.status).not.toBe('unsupported');
    expect(caps.supportsTraceBlock.status).not.toBe('supported'); // trace_block not implemented on Monad
  });
});
