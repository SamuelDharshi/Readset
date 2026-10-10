// Real-network tests against Monad mainnet (SQD portal + public RPC). No mocks.
// If the network is unreachable the suite SKIPS LOUDLY (console.error banner) rather than passing silently.
import { describe, it, expect, beforeAll } from 'vitest';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ArchivePacer, RpcError, fetchFailedTxs, planChunks, resimGas, rpcCall, RunTracker, sqdHead, traceFailure, weiToMon,
  type FailedTx, type Hex,
} from '../src/failed-index.js';

let reachable = false;
let head = 0;
beforeAll(async () => {
  if (offline()) {
    console.warn(`
##### ${OFFLINE_REASON} #####
`);
    return;
  }
  try {
    head = (await sqdHead()).finalized;
    await rpcCall('eth_chainId', []);
    reachable = true;
  } catch (e) {
    console.error('\n##### SKIPPING K2 failed-index REAL-NETWORK TESTS: Monad mainnet / SQD unreachable: ' + (e as Error).message + ' #####\n');
  }
});
const t = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!reachable) return ctx.skip(); await fn(); });

describe('failed-index (real Monad mainnet)', () => {
  it('plans grid-aligned chunks', () => {
    expect(planChunks(5, 25, 10)).toEqual([[5, 9], [10, 19], [20, 25]]);
  });

  t('SQD returns failed txs where receipt gasUsed == gasLimit, burn = limit x price; caches and resumes', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'k2-'));
    const to = head - 20_000, from = to - 1_199;
    const a = await fetchFailedTxs({ fromBlock: from, toBlock: to, cacheDir, chunkBlocks: 600 });
    expect(a.chunks.length).toBeGreaterThanOrEqual(2);
    expect(a.rows.length).toBeGreaterThan(0);
    for (const r of a.rows) {
      expect(r.status).toBe(0);
      expect(r.gasUsed).toBe(r.gasLimit);                 // Category Labs: top-level gasUsed == gasLimit
      expect(r.burnWei).toBe(r.gasLimit * r.effectiveGasPrice);
      expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
    }
    const userTxs = a.chunks.reduce((s, c) => s + c.userTxs, 0);
    const rate = a.rows.length / userTxs;
    console.log(`failure rate ${(rate * 100).toFixed(2)}% over ${userTxs} user txs, burn ${weiToMon(a.chunks.reduce((s, c) => s + BigInt(c.failedBurnWei), 0n))} MON`);
    expect(rate).toBeGreaterThan(0.005); expect(rate).toBeLessThan(0.3);
    const b = await fetchFailedTxs({ fromBlock: from, toBlock: to, cacheDir, chunkBlocks: 600 }); // from cache
    expect(b.rows.map((r) => r.hash)).toEqual(a.rows.map((r) => r.hash));
    expect(b.rows[0].burnWei).toBe(a.rows[0].burnWei);
  });

  t('SQD and public RPC agree on the same blocks (cross-validation)', async () => {
    const to = head - 30_000, from = to - 7;
    const s = await fetchFailedTxs({ fromBlock: from, toBlock: to, source: 'sqd', cacheDir: mkdtempSync(path.join(tmpdir(), 'k2s-')) });
    const r = await fetchFailedTxs({ fromBlock: from, toBlock: to, source: 'rpc', cacheDir: mkdtempSync(path.join(tmpdir(), 'k2r-')) });
    expect(r.rows.map((x) => x.hash)).toEqual(s.rows.map((x) => x.hash));
    expect(r.chunks[0].totalTxs).toBe(s.chunks[0].totalTxs);
    for (let i = 0; i < s.rows.length; i++) {
      expect(r.rows[i].burnWei).toBe(s.rows[i].burnWei);
      expect(r.rows[i].from).toBe(s.rows[i].from);
      expect(r.rows[i].selector).toBe(s.rows[i].selector);
    }
  });

  it('RpcError classifies node answers without mistaking "limit" for throttling', () => {
    expect(new RpcError('eth_call', -32003, 'out of gas').isOutOfGas).toBe(true);
    expect(new RpcError('eth_call', -32000, 'intrinsic gas greater than limit').isOutOfGas).toBe(true);
    expect(new RpcError('eth_call', 3, 'execution reverted: SLIPPAGE').isRevert).toBe(true);
    expect(new RpcError('eth_call', 3, 'execution reverted').isOutOfGas).toBe(false);
    expect(new RpcError('debug_traceCall', -32602, 'historical state that is not available').isPrunedState).toBe(true);
  });

  t('traces a real failed tx and re-simulates its gas at the parent block (hardcoded-gas proxy input)', async () => {
    // Take real failed txs from a recent block range; the archive pair is the only free tracing option (K1).
    const to = head - 50_000, from = to - 599;
    const { rows } = await fetchFailedTxs({ fromBlock: from, toBlock: to, cacheDir: mkdtempSync(path.join(tmpdir(), 'k2t-')), chunkBlocks: 600 });
    expect(rows.length).toBeGreaterThan(0);
    const pacer = new ArchivePacer(undefined, 6);
    let checked = 0;
    for (const r of rows.slice(0, 4)) {
      const tr = await traceFailure(r.hash, pacer);
      expect(tr.hash).toBe(r.hash);
      // every failed tx has a top-level callTracer error; Monad reports gasUsed == gasLimit so `error` is the signal
      expect(tr.error, `no trace error for ${r.hash}`).toBeTruthy();
      expect(tr.outOfGas).toBe(/out of gas/i.test(tr.error!));

      const tx = await pacer.call<any>('eth_getTransactionByHash', [r.hash]);
      expect(tx.hash).toBe(r.hash);
      expect(BigInt(tx.gas)).toBe(r.gasLimit); // SQD gas == RPC gas limit
      const rg = await resimGas(
        { from: tx.from, to: tx.to ?? null, input: tx.input ?? '0x', value: tx.value ?? '0x0', gasLimit: BigInt(tx.gas) },
        r.blockNumber - 1, pacer,
      );
      expect(['estimate', 'bisect', 'unavailable']).toContain(rg.mode);
      if (rg.gas !== null) {
        expect(rg.gas).toBeGreaterThan(20_999n);          // above the 21k intrinsic floor
        expect(rg.gas).toBeLessThanOrEqual(r.gasLimit);   // it is a bound on what the tx could consume
        console.log(`${r.hash} ${rg.mode} atParent=${rg.atParent} resim=${rg.gas} limit=${r.gasLimit} ratio=${(Number(r.gasLimit) / Number(rg.gas)).toFixed(2)}x`);
        checked++;
      } else {
        console.log(`${r.hash} ${rg.mode} atParent=${rg.atParent} note=${rg.note}`);
      }
    }
    expect(checked, 'no tx re-simulated to a gas number on either archive endpoint').toBeGreaterThan(0);
    expect(Object.values(pacer.calls).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  t('ArchivePacer surfaces a node revert instead of retrying it, and paces below the target rate', async () => {
    const pacer = new ArchivePacer(undefined, 4);
    const t0 = Date.now();
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => pacer.call<Hex>('eth_chainId', [])));
    expect(new Set(ids)).toEqual(new Set(['0x8f'])); // Monad mainnet = 143
    expect(Date.now() - t0).toBeGreaterThan(400);    // 6 calls at 4 rps across 2 endpoints cannot be instant
    // A deliberate revert must come back as RpcError, not be retried as a transport failure.
    await expect(pacer.call('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0xdeadbeef', gas: '0x5208' }, 'latest']))
      .rejects.toBeInstanceOf(RpcError);
  });

  it('RunTracker finds >=10 contiguous-nonce failures only', () => {
    const mk = (nonce: number, block: number, from = '0xaa'): FailedTx => ({
      hash: '0x00', blockNumber: block, blockTimestamp: 0, txIndex: 0, from: from as any, to: null, selector: null, nonce,
      gasLimit: 1n, gasUsed: 1n, effectiveGasPrice: 10n, burnWei: 10n, status: 0,
    });
    const rt = new RunTracker(10, 5);
    for (let n = 0; n < 12; n++) rt.feed(mk(n, n));          // run of 12
    for (let n = 20; n < 29; n++) rt.feed(mk(n, 100 + n));   // run of 9 (gap at 12..19 = successes)
    const runs = rt.finish();
    expect(runs.length).toBe(1);
    expect(runs[0].failures).toBe(12);
    expect(runs[0].burnWei).toBe(120n);
    expect(runs[0].burnAfterBreakerWei).toBe(70n);
  });
});
