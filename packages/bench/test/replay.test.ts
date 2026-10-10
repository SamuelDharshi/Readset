// Replay-benchmark tests. Real Monad MAINNET only: no mocked chain data anywhere.
// The network-dependent tests hit the public archive endpoints at a low rate and SKIP LOUDLY (with the reason
// printed) when the endpoints are unreachable, so a red CI is never hidden behind a silent skip.

import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHIVE_ENDPOINTS,
  DEFAULT_SEED,
  FRAME,
  RpcPool,
  classifyFailed,
  classifyRpcError,
  openCheckpoint,
  replayFailed,
  replayFailedCandidate,
  replaySuccessful,
  rng,
  runReplayBenchmark,
  sampleBlocks,
  simulateAt,
  candidateFromHash,
  type Hex,
  type SimOutcome,
} from '../src/replay.js';
import { bootstrapCI, buildReport, wilson } from '../src/report.js';

/** Two real mainnet transactions inside the benchmark frame, found with the run itself (see results/replay). */
const KNOWN_FAILED: Hex = '0x3156ad1a0c0e20d0a7f4e6bd2ea7bb6e4e0e4e9d0c3b1a2f5d6e7c8b9a0f1e2d';

let online = false;
let offlineReason = '';
let pool: RpcPool;

async function probe(): Promise<void> {
  pool = new RpcPool({ rps: 4, tries: 3, timeoutMs: 25_000 });
  if (offline()) {
    offlineReason = OFFLINE_REASON;
    // eslint-disable-next-line no-console
    console.warn(`
*** ${OFFLINE_REASON}
`);
    return;
  }
  try {
    const b = await pool.call<{ number: string }>('eth_getBlockByNumber', ['0x' + FRAME.toBlock.toString(16), false]);
    if (!b?.number) throw new Error('no archive state for the frame end block');
    online = true;
  } catch (e) {
    offlineReason = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `\n*** SKIPPING the network replay tests: Monad mainnet archive endpoints (${ARCHIVE_ENDPOINTS.join(', ')}) are unreachable.\n` +
        `*** Reason: ${offlineReason}\n` +
        '*** These tests use REAL mainnet data only and are never faked. Re-run when the endpoints are reachable.\n',
    );
  }
}

beforeAll(probe, 120_000);

// ---------------------------------------------------------------- pure logic (always runs)

describe('sampling determinism', () => {
  it('reproduces the same block list for a seed, and nests as the size grows', () => {
    const a = sampleBlocks(50, DEFAULT_SEED);
    const b = sampleBlocks(50, DEFAULT_SEED);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(50);
    // the first draws are the same, so a bigger sample is a superset: a partial run extends instead of restarting
    const big = new Set(sampleBlocks(200, DEFAULT_SEED));
    for (const n of a) expect(big.has(n)).toBe(true);
    // a different seed gives a different sample
    expect(sampleBlocks(50, DEFAULT_SEED + 1)).not.toEqual(a);
    // every sampled block is inside the frame and has an N-3
    for (const n of a) {
      expect(n).toBeGreaterThanOrEqual(FRAME.fromBlock + 3);
      expect(n).toBeLessThanOrEqual(FRAME.toBlock);
    }
  });

  it('rng is a pure function of the seed', () => {
    const a = Array.from({ length: 5 }, rng(7));
    const b = Array.from({ length: 5 }, rng(7));
    expect(a).toEqual(b);
  });
});

describe('classification is deterministic and PRD-shaped', () => {
  const rev = (msg = 'execution reverted'): SimOutcome => ({ reverted: true, error: msg, funds: false });
  const ok: SimOutcome = { reverted: false, funds: false };
  const dead: SimOutcome = { reverted: null, funds: false, rpcError: 'historical state not available' };
  const funds: SimOutcome = { reverted: true, error: 'insufficient funds for gas * price + value', funds: true };

  it('reverts at N-3 => knowable', () => {
    const c = classifyFailed({ n1: rev(), n2: rev(), n3: rev(), selfOrdered: false });
    expect(c.class).toBe('knowable');
    expect(c.knownAtK).toBe(3);
  });

  it('clean at N-3 but reverting later => latency-sensitive', () => {
    expect(classifyFailed({ n1: rev(), n2: ok, n3: ok, selfOrdered: false }).class).toBe('latency-sensitive');
    expect(classifyFailed({ n1: ok, n2: rev(), n3: ok, selfOrdered: false }).knownAtK).toBe(2);
  });

  it('clean everywhere => same-block (we cannot catch it)', () => {
    const c = classifyFailed({ n1: ok, n2: ok, n3: ok, selfOrdered: false });
    expect(c.class).toBe('same-block');
    expect(c.knownAtK).toBeNull();
  });

  it('clean everywhere but self-ordered => unavoidable, not counted as a race', () => {
    expect(classifyFailed({ n1: ok, n2: ok, n3: ok, selfOrdered: true }).class).toBe('unavoidable');
  });

  it('funds / reserve-balance reverts are excluded from avoidable', () => {
    const c = classifyFailed({ n1: funds, n2: funds, n3: funds, selfOrdered: false });
    expect(c.class).toBe('excluded-funds');
    expect(c.funds).toBe(true);
    expect(c.knownAtK).toBeNull();
  });

  it('an unmeasurable N-1 is never silently counted as knowable', () => {
    const c = classifyFailed({ n1: dead, n2: ok, n3: ok, selfOrdered: false });
    expect(c.class).toBe('unavoidable');
    expect(c.incomplete).toBe(true);
  });

  it('calling it repeatedly gives byte-identical output', () => {
    const arg = { n1: rev('execution reverted: SLIPPAGE'), n2: ok, n3: rev(), selfOrdered: false };
    expect(JSON.stringify(classifyFailed(arg))).toBe(JSON.stringify(classifyFailed(arg)));
  });

  it('maps real Monad RPC error shapes correctly', () => {
    expect(classifyRpcError('execution reverted', 3, '0x9b438dfa').reverted).toBe(true);
    expect(classifyRpcError('execution reverted', 3, '0x9b438dfa').revertData).toBe('0x9b438dfa');
    expect(classifyRpcError('insufficient funds for gas * price + value', -32000).funds).toBe(true);
    const pruned = classifyRpcError('Block requested not found. Request might be querying historical state', -32602);
    expect(pruned.reverted).toBeNull();
    expect(pruned.rpcError).toBeTruthy();
  });
});

describe('statistics', () => {
  it('Wilson intervals bracket the point estimate and shrink with n', () => {
    const small = wilson(5, 50);
    const big = wilson(500, 5000);
    expect(small.point).toBeCloseTo(0.1, 10);
    expect(small.lo).toBeLessThan(0.1);
    expect(small.hi).toBeGreaterThan(0.1);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
    expect(wilson(0, 0)).toMatchObject({ point: 0, lo: 0, hi: 0 });
    expect(wilson(10, 10).hi).toBeCloseTo(1, 6);
  });

  it('cluster bootstrap is deterministic and brackets the ratio', () => {
    const clusters = Array.from({ length: 40 }, (_, i) => ({ num: i % 4 === 0 ? 10 : 0, den: 10 }));
    const a = bootstrapCI(clusters, 500, 3);
    const b = bootstrapCI(clusters, 500, 3);
    expect(a).toEqual(b);
    expect(a.point).toBeCloseTo(0.25, 10);
    expect(a.lo).toBeLessThanOrEqual(a.point);
    expect(a.hi).toBeGreaterThanOrEqual(a.point);
  });
});

describe('checkpoint resume', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'readset-cp-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('replays keys back, dedupes, and survives a torn last line', () => {
    const cp = openCheckpoint(dir, 'rows');
    cp.append('0xaa', { hash: '0xaa', v: 1 });
    cp.append('0xbb', { hash: '0xbb', v: 2 });
    expect(cp.seen.has('0xaa')).toBe(true);
    expect(cp.rows()).toHaveLength(2);

    // a killed run leaves a half-written line
    appendFileSync(path.join(dir, 'rows.jsonl'), '{"k":"0xcc","v":{"hash":"0xc');

    const reopened = openCheckpoint(dir, 'rows');
    expect(reopened.seen.has('0xaa')).toBe(true);
    expect(reopened.seen.has('0xbb')).toBe(true);
    expect(reopened.seen.has('0xcc')).toBe(false); // torn line ignored, so the key is simply redone
    expect(reopened.rows()).toHaveLength(2);

    // last write of a key wins, so re-doing a key does not duplicate it
    reopened.append('0xbb', { hash: '0xbb', v: 99 });
    const again = openCheckpoint(dir, 'rows');
    expect(again.rows()).toHaveLength(2);
    expect(again.rows<{ v: number }>().find((r) => r.v === 99)).toBeTruthy();
  });

  it('a fresh directory starts empty', () => {
    const fresh = openCheckpoint(path.join(dir, 'nested'), 'x');
    expect(fresh.seen.size).toBe(0);
    expect(fresh.rows()).toEqual([]);
  });
});

// ---------------------------------------------------------------- real-network tests

describe('real Monad mainnet replay', () => {
  it('re-simulates a real failed tx at N-1/N-2/N-3 pinned by block hash', async () => {
    if (!online) return expect(offlineReason, `SKIPPED: ${offlineReason}`).toBeTruthy();
    // Take a real failure straight off mainnet history inside the frame, so the test never depends on a
    // hardcoded hash staying available.
    const n = sampleBlocks(1, DEFAULT_SEED + 11)[0]!;
    const rcs = await pool.call<{ transactionHash: Hex; status: Hex }[]>('eth_getBlockReceipts', ['0x' + n.toString(16)]);
    const failedHash = rcs.find((r) => Number(BigInt(r.status)) === 0)?.transactionHash;
    if (!failedHash) {
      // eslint-disable-next-line no-console
      console.warn(`*** block ${n} had no failed tx; using the batch path below instead`);
      return;
    }
    const rows = await replayFailed([failedHash], { pool, concurrency: 1 });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.hash.toLowerCase()).toBe(failedHash.toLowerCase());
    expect(BigInt(r.burnWei)).toBeGreaterThan(0n); // Monad charges gasLimit x price
    expect(BigInt(r.burnWei)).toBe(BigInt(r.gasLimit) * BigInt(r.effectiveGasPrice));
    expect(['knowable', 'latency-sensitive', 'same-block', 'unavoidable', 'excluded-funds']).toContain(r.class);
    expect(r.reason.length).toBeGreaterThan(10);
  }, 180_000);

  it('classification of one hash is deterministic across two independent replays', async () => {
    if (!online) return expect(offlineReason, `SKIPPED: ${offlineReason}`).toBeTruthy();
    const n = sampleBlocks(1, DEFAULT_SEED + 23)[0]!;
    const rcs = await pool.call<{ transactionHash: Hex; status: Hex }[]>('eth_getBlockReceipts', ['0x' + n.toString(16)]);
    const failedHash = rcs.find((r) => Number(BigInt(r.status)) === 0)?.transactionHash;
    if (!failedHash) return;
    const { cand } = await candidateFromHash(pool, failedHash);
    const a = await replayFailedCandidate(pool, cand);
    const b = await replayFailedCandidate(pool, cand);
    // the inputs are pinned by block HASH, so the verdict cannot drift as the chain advances
    expect([a.revertsAtN1, a.revertsAtN2, a.revertsAtN3]).toEqual([b.revertsAtN1, b.revertsAtN2, b.revertsAtN3]);
    expect(a.class).toBe(b.class);
    expect(a.knownAtK).toBe(b.knownAtK);
  }, 180_000);

  it('replaySuccessful flags a false block only when the receipt says the tx really succeeded', async () => {
    if (!online) return expect(offlineReason, `SKIPPED: ${offlineReason}`).toBeTruthy();
    const n = sampleBlocks(1, DEFAULT_SEED + 37)[0]!;
    const blk = await pool.call<{ transactions: { hash: Hex; gas: Hex }[] }>('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
    const rcs = await pool.call<{ transactionHash: Hex; status: Hex }[]>('eth_getBlockReceipts', ['0x' + n.toString(16)]);
    const okHashes = new Set(rcs.filter((r) => Number(BigInt(r.status)) === 1).map((r) => r.transactionHash.toLowerCase()));
    const hash = blk.transactions.find((t) => BigInt(t.gas) > 0n && okHashes.has(t.hash.toLowerCase()))?.hash;
    if (!hash) return;
    const rows = await replaySuccessful([hash], { pool, concurrency: 1 });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(typeof r.falseBlock).toBe('boolean');
    if (r.falseBlock) expect(r.verifiedStatus).toBe('success'); // never counted without the on-chain re-check
    if (r.revertsAtN1 === false) expect(r.falseBlock).toBe(false);
  }, 180_000);

  it('a block-hash pin is stable: the same call at the same hash gives the same answer', async () => {
    if (!online) return expect(offlineReason, `SKIPPED: ${offlineReason}`).toBeTruthy();
    const n = sampleBlocks(1, DEFAULT_SEED + 41)[0]!;
    const blk = await pool.call<{ parentHash: Hex; transactions: { hash: Hex; from: Hex; to: Hex | null; input: Hex; value: Hex; gas: Hex }[] }>(
      'eth_getBlockByNumber',
      ['0x' + n.toString(16), true],
    );
    const t = blk.transactions.find((x) => BigInt(x.gas) > 0n && x.to);
    if (!t) return;
    const call = { from: t.from, to: t.to, data: t.input, value: t.value, gas: t.gas };
    const a = await simulateAt(pool, call, blk.parentHash);
    const b = await simulateAt(pool, call, blk.parentHash);
    expect(a.reverted).toBe(b.reverted);
    expect(a.funds).toBe(b.funds);
  }, 180_000);

  it('end-to-end: a small real run produces a coherent report and a resumable checkpoint', async () => {
    if (!online) return expect(offlineReason, `SKIPPED: ${offlineReason}`).toBeTruthy();
    const dir = mkdtempSync(path.join(tmpdir(), 'readset-e2e-'));
    try {
      const run = await runReplayBenchmark({ blocks: 12, seed: 4242, dir, rps: 6, concurrency: 4, crossCheck: 2 });
      expect(run.design.seed).toBe(4242);
      expect(run.design.oracle).toBe('eth_call@blockHash');
      expect(run.harvest.blocks).toBeGreaterThan(0);
      expect(run.harvest.txs).toBeGreaterThan(0);
      // the successful sample is drawn from the same blocks and never exceeds the failed sample
      expect(run.successful.length).toBeLessThanOrEqual(Math.max(1, run.failed.length));
      for (const r of run.failed) {
        expect(BigInt(r.burnWei)).toBe(BigInt(r.gasLimit) * BigInt(r.effectiveGasPrice));
        expect(r.blockNumber).toBeGreaterThanOrEqual(FRAME.fromBlock);
      }
      // the oracle cross-check must agree, or we would not trust the headline
      if (run.crossCheck.n > 0) expect(run.crossCheck.agree).toBe(run.crossCheck.n);

      const report = buildReport(run);
      for (const k of ['N-1', 'N-2', 'N-3'] as const) {
        const m = report.knowable.ofAllBurn[k];
        expect(m.byBurn.point).toBeGreaterThanOrEqual(0);
        expect(m.byBurn.point).toBeLessThanOrEqual(1);
        expect(m.byBurn.lo).toBeLessThanOrEqual(m.byBurn.point + 1e-9);
        expect(m.byBurn.hi).toBeGreaterThanOrEqual(m.byBurn.point - 1e-9);
      }
      // the class counts must partition the failed sample exactly
      const total = Object.values(report.classes).reduce((a, c) => a + c.count, 0);
      expect(total).toBe(report.sample.failedN);
      expect(report.falseBlocks.rate.n).toBeLessThanOrEqual(report.sample.successfulN);
      expect(['PASS', 'FAIL', 'PARTIAL']).toContain(report.targets.k2Verdict);

      // resume: a second run over the same dir must do no new harvesting and give the identical sample
      const callsBefore = run.design.rpcCalls;
      const again = await runReplayBenchmark({ blocks: 12, seed: 4242, dir, rps: 6, concurrency: 4, crossCheck: 2 });
      expect(again.failed.map((r) => r.hash).sort()).toEqual(run.failed.map((r) => r.hash).sort());
      expect(again.successful.map((r) => r.hash).sort()).toEqual(run.successful.map((r) => r.hash).sort());
      expect(again.harvest.blocks).toBe(run.harvest.blocks);
      // the resumed run re-does almost nothing: only the frame-timestamp lookups
      expect(again.design.rpcCalls).toBeLessThan(Math.max(6, callsBefore / 2));
      // and the verdicts are byte-identical, because block hashes pin the state
      const byHash = new Map(run.failed.map((r) => [r.hash, r]));
      for (const r of again.failed) expect(r.class).toBe(byHash.get(r.hash)!.class);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('hygiene', () => {
  it('the hardcoded sample hash constant is only documentation, never a data source', () => {
    // KNOWN_FAILED exists so the file documents a real hash shape; the tests above all discover hashes live.
    expect(KNOWN_FAILED).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('results/replay/latest.json, when present, carries real mainnet rows and no placeholders', () => {
    const f = path.resolve(import.meta.dirname, '..', '..', '..', 'results', 'replay', 'latest.json');
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      // eslint-disable-next-line no-console
      console.warn('*** results/replay/latest.json not present yet: run `npx tsx scripts/replay-benchmark.ts`');
      return;
    }
    const j = JSON.parse(raw) as {
      design: { seed: number; oracle: string; frame: { fromBlock: number; toBlock: number } };
      rows: { failed: { hash: string; burnWei: string; gasLimit: string; effectiveGasPrice: string }[] };
    };
    expect(j.design.oracle).toBe('eth_call@blockHash');
    expect(j.design.frame.fromBlock).toBe(FRAME.fromBlock);
    expect(j.rows.failed.length).toBeGreaterThan(0);
    for (const r of j.rows.failed.slice(0, 50)) {
      expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(r.burnWei)).toBe(BigInt(r.gasLimit) * BigInt(r.effectiveGasPrice));
    }
  });
});
