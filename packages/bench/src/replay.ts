// Replay benchmark (K2): how much Monad revert burn was knowable BEFORE the transaction was sent?
//
// Real Monad MAINNET (chain 143) data only. Nothing here is mocked or synthesised.
//   - failed txs come from the cached SQD `monad-mainnet` index (packages/bench/src/failed-index.ts)
//   - every re-simulation is a live archive-RPC call pinned to a historical BLOCK HASH (kill test K1)
//
// Method
//   For a tx that failed in block N we re-simulate the exact same call (from/to/data/value/gas) against the
//   committed state at N-1, N-2 and N-3, pinned by block hash via EIP-1898. A revert at N-k means the state
//   that doomed the tx had already moved k blocks before it landed, i.e. a gate simulating at `latest` would
//   have refused it. The same re-simulation is run on an equal-size sample of SUCCESSFUL sends: a revert there
//   is a FALSE BLOCK (the gate would have wrongly refused a tx that actually worked).
//
// Oracle
//   `eth_call` at the pinned block hash is the revert oracle, because that is literally what a client-side gate
//   does (viem's estimateGas/simulate path). It runs on the same execution engine as debug_traceCall; the run
//   cross-checks a random subsample against `debug_traceCall` + callTracer and reports the agreement rate.
//   TODO(explain): when `@readset/core` exports `explainFailedTx` / `classifyBatch` (packages/core/src/explain/**),
//   switch `simulateAt()` to it so the per-tx output also carries the moved slot and its writer. Until then this
//   file keeps its own minimal re-simulation (non-diff prestateTracer is available via `dependencySetAt()` and is
//   used for the cross-check / spot explanations) so the benchmark is never blocked.
//
// Honest limits (also in docs/benchmark.md)
//   - re-simulating at N-1 approximates, but is not, the real pre-send moment: a bot may have signed many blocks
//     earlier, or microseconds before inclusion;
//   - `latest` on Monad is a Proposed block and can be abandoned, so a live gate sees slightly worse state than
//     our finalized N-1 (see packages/bench/src/abandonment-*.ts);
//   - there is no pending-transaction feed, so same-block races are invisible by construction;
//   - a tx whose sender had an earlier tx in the same block is simulated against stale own-state; those rows are
//     marked `selfOrdered` and reported separately instead of being silently counted.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadChunk, DEFAULT_CHUNK, type FailedTx, type Hex } from './failed-index.js';

export type { Hex, FailedTx };

// ---------------------------------------------------------------- sampling frame

/**
 * Sampling frame: the 30-day, grid-aligned mainnet block window that the cached failed-tx index covers
 * (identical to the frame used by `scripts/k2-sample.ts`, so the burn denominators line up).
 * 8,568,000 blocks at ~301.9 ms = 29.9 days ending 2026-10-07T04:45Z.
 */
export interface SampleFrame {
  readonly fromBlock: number;
  readonly toBlock: number;
}
export const FRAME: SampleFrame = { fromBlock: 102_648_000, toBlock: 111_215_999 };
export const DEFAULT_SEED = 20_261_007;

/** Archive endpoints that are full-archive AND allow debug_* on mainnet (K1). Order = failover order. */
export const ARCHIVE_ENDPOINTS = ['https://rpc2.monad.xyz', 'https://rpc-mainnet.monadinfra.com'] as const;
/** Global request budget. Public archive endpoints document 15-25 rps; we stay under 10 rps in total. */
export const DEFAULT_RPS = 9;

/** mulberry32: same generator as scripts/k2-sample.ts, so a seed reproduces a sample exactly. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic uniform sample of `count` DISTINCT block numbers from the frame, without replacement.
 * Blocks are the primary sampling unit: a block gives us every failed tx in it (from the cached index) and a
 * uniformly chosen successful tx, so the failed and successful samples share one frame and one design.
 * Sorted ascending so the run reads each cache chunk once.
 */
export function sampleBlocks(count: number, seed = DEFAULT_SEED, frame: SampleFrame = FRAME): number[] {
  const span = frame.toBlock - frame.fromBlock + 1;
  if (count > span) throw new Error(`cannot sample ${count} distinct blocks from ${span}`);
  const R = rng(seed);
  const seen = new Set<number>();
  // The first three blocks of the frame have no N-3, so they are excluded from the frame edge.
  const lo = frame.fromBlock + 3;
  while (seen.size < count) seen.add(lo + Math.floor(R() * (frame.toBlock - lo + 1)));
  return [...seen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- rate-limited, failing-over RPC pool

export interface RpcPoolOptions {
  urls?: readonly string[];
  /** total requests per second across all endpoints (default 9) */
  rps?: number;
  timeoutMs?: number;
  tries?: number;
  onStat?: (s: { url: string; method: string; ms: number; ok: boolean }) => void;
}

export interface RpcError extends Error {
  /** JSON-RPC error code, when the node returned one. */
  rpcCode?: number;
  /** JSON-RPC error data (revert data for code 3). */
  rpcData?: string;
  /** true for a JSON-RPC application error (do not retry / do not fail over) */
  rpcLevel?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = /rate.?limit|too many|429|50\d|capacity|throttl|timeout|timed out|fetch failed|ECONNRESET|socket|network/i;

/**
 * Token-bucket limited JSON-RPC pool with round-robin endpoint choice and failover.
 * Only transport / rate-limit failures are retried; a JSON-RPC application error (e.g. `execution reverted`)
 * is returned to the caller as an RpcError straight away, because that is the measurement we want.
 */
export class RpcPool {
  readonly urls: readonly string[];
  readonly rps: number;
  private readonly timeoutMs: number;
  private readonly tries: number;
  private readonly onStat?: RpcPoolOptions['onStat'];
  private next = 0;
  private slot = 0;
  calls = 0;
  failures = 0;
  readonly perUrl = new Map<string, { calls: number; errors: number }>();

  constructor(o: RpcPoolOptions = {}) {
    this.urls = o.urls?.length ? o.urls : ARCHIVE_ENDPOINTS;
    this.rps = o.rps ?? DEFAULT_RPS;
    this.timeoutMs = o.timeoutMs ?? 40_000;
    this.tries = o.tries ?? 6;
    this.onStat = o.onStat;
    for (const u of this.urls) this.perUrl.set(u, { calls: 0, errors: 0 });
  }

  /** Reserve the next slot in the global token bucket and wait for it. */
  private async gate(): Promise<void> {
    const gap = 1000 / this.rps;
    const now = Date.now();
    this.slot = Math.max(now, this.slot) + gap;
    const wait = this.slot - gap - now;
    if (wait > 0) await sleep(wait);
  }

  private async once(url: string, method: string, params: unknown[]): Promise<unknown> {
    const t0 = Date.now();
    let ok = false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      if (j.error) {
        const msg = j.error.message ?? 'rpc error';
        if (RETRYABLE.test(msg)) throw new Error(msg);
        const e: RpcError = Object.assign(new Error(msg), {
          rpcCode: j.error.code,
          rpcData: typeof j.error.data === 'string' ? j.error.data : undefined,
          rpcLevel: true,
        });
        throw e;
      }
      ok = true;
      return j.result;
    } finally {
      this.onStat?.({ url, method, ms: Date.now() - t0, ok });
    }
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < this.tries; attempt++) {
      const url = this.urls[this.next++ % this.urls.length]!;
      const st = this.perUrl.get(url)!;
      await this.gate();
      this.calls++;
      st.calls++;
      try {
        return (await this.once(url, method, params)) as T;
      } catch (e) {
        last = e;
        st.errors++;
        if ((e as RpcError).rpcLevel) throw e; // application-level: the answer, not a failure
        if (!RETRYABLE.test(e instanceof Error ? e.message : String(e)) && attempt >= 1) break;
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 300);
      }
    }
    this.failures++;
    throw last instanceof Error ? last : new Error(String(last));
  }
}

const hexQty = (n: number | bigint): Hex => `0x${n.toString(16)}`;

// ---------------------------------------------------------------- the revert oracle

export type ReplayClass = 'knowable' | 'latency-sensitive' | 'same-block' | 'unavoidable' | 'excluded-funds';

export interface SimCall {
  from: Hex;
  to: Hex | null;
  data: Hex;
  value: Hex;
  gas: Hex;
}

export interface SimOutcome {
  /** true = the call reverted, false = it returned, null = we could not simulate (RPC/state error) */
  reverted: boolean | null;
  /** decoded-ish revert message or the node's error text */
  error?: string;
  revertData?: Hex;
  /** the revert/failure is a sender-funds or Monad reserve-balance condition, not a logic revert */
  funds: boolean;
  /** set when `reverted` is null */
  rpcError?: string;
}

/** Sender-funds / Monad reserve-balance conditions. PRD: these are excluded from "avoidable". */
const FUNDS_RE = /insufficient funds|insufficient balance|reserve balance|exceeds balance|balance too low|max fee per gas|intrinsic gas/i;
/** Node-side problems that mean "we could not measure", not "it reverted". */
const UNUSABLE_RE = /historical state|not found|not available|pruned|missing trie|unsupported|method not|too large|out of memory/i;

export function classifyRpcError(msg: string, code?: number, data?: string): SimOutcome {
  if (code === 3 || /execution reverted/i.test(msg)) {
    return { reverted: true, error: msg, revertData: data as Hex | undefined, funds: FUNDS_RE.test(msg) };
  }
  if (FUNDS_RE.test(msg)) return { reverted: true, error: msg, funds: true };
  if (UNUSABLE_RE.test(msg)) return { reverted: null, funds: false, rpcError: msg };
  // Anything else the node rejected at admission (e.g. nonce/gas sanity) is also a refusal a gate would make.
  return { reverted: true, error: msg, funds: false };
}

/** Re-simulate one call against committed state pinned by block HASH (EIP-1898; verified in docs/kill-tests/K1.md). */
export async function simulateAt(pool: RpcPool, call: SimCall, blockHash: Hex): Promise<SimOutcome> {
  try {
    await pool.call('eth_call', [
      { from: call.from, ...(call.to ? { to: call.to } : {}), data: call.data, value: call.value, gas: call.gas },
      { blockHash },
    ]);
    return { reverted: false, funds: false };
  } catch (e) {
    const err = e as RpcError;
    if (!err.rpcLevel) return { reverted: null, funds: false, rpcError: err.message };
    return classifyRpcError(err.message, err.rpcCode, err.rpcData);
  }
}

/** Cross-check oracle: debug_traceCall + callTracer at the same pinned block hash. */
export async function simulateAtViaTrace(pool: RpcPool, call: SimCall, blockHash: Hex): Promise<SimOutcome> {
  try {
    const r = await pool.call<{ error?: string; revertReason?: string; output?: string }>('debug_traceCall', [
      { from: call.from, ...(call.to ? { to: call.to } : {}), data: call.data, value: call.value, gas: call.gas },
      { blockHash },
      { tracer: 'callTracer' },
    ]);
    if (r?.error) {
      const msg = r.revertReason ? `${r.error}: ${r.revertReason}` : r.error;
      return { reverted: true, error: msg, revertData: r.output as Hex | undefined, funds: FUNDS_RE.test(msg) };
    }
    return { reverted: false, funds: false };
  } catch (e) {
    const err = e as RpcError;
    if (!err.rpcLevel) return { reverted: null, funds: false, rpcError: err.message };
    return classifyRpcError(err.message, err.rpcCode, err.rpcData);
  }
}

/**
 * Non-diff prestateTracer dependency set at a pinned block hash (K1: non-diff includes READ-ONLY slots,
 * diffMode does not). Used for spot explanations; the headline numbers do not need it.
 */
export async function dependencySetAt(
  pool: RpcPool,
  call: SimCall,
  blockHash: Hex,
): Promise<{ slots: number; accounts: number; raw: Record<string, { storage?: Record<string, string> }> }> {
  const raw = await pool.call<Record<string, { storage?: Record<string, string> }>>('debug_traceCall', [
    { from: call.from, ...(call.to ? { to: call.to } : {}), data: call.data, value: call.value, gas: call.gas },
    { blockHash },
    { tracer: 'prestateTracer' },
  ]);
  let slots = 0;
  for (const a of Object.values(raw ?? {})) slots += Object.keys(a?.storage ?? {}).length;
  return { slots, accounts: Object.keys(raw ?? {}).length, raw: raw ?? {} };
}

// ---------------------------------------------------------------- classification

export interface FailedReplayRow {
  hash: Hex;
  blockNumber: number;
  blockTimestamp: number;
  txIndex: number;
  from: Hex;
  to: Hex | null;
  selector: Hex | null;
  gasLimit: string;
  effectiveGasPrice: string;
  /** gasLimit x effectiveGasPrice: what the failure actually cost (Monad charges the limit) */
  burnWei: string;
  revertsAtN1: boolean | null;
  revertsAtN2: boolean | null;
  revertsAtN3: boolean | null;
  class: ReplayClass;
  reason: string;
  /** the earliest k at which it already reverted (1|2|3), or null */
  knownAtK: 1 | 2 | 3 | null;
  /** sender-funds / reserve-balance revert: excluded from "avoidable" per the PRD */
  funds: boolean;
  /** the sender had an earlier tx in block N, so our N-1 state is stale for this tx */
  selfOrdered: boolean;
  /** true when at least one of the three re-simulations could not be measured */
  incomplete: boolean;
}

export interface SuccessReplayRow {
  hash: Hex;
  blockNumber: number;
  blockTimestamp: number;
  txIndex: number;
  from: Hex;
  to: Hex | null;
  selector: Hex | null;
  gasLimit: string;
  /** '0' for successful sends: reading a receipt per successful tx would cost one RPC call each and the public
   *  archive budget is better spent on re-simulations. The false-block weighting uses gasLimit instead. */
  effectiveGasPrice: string;
  feeWei: string;
  revertsAtN1: boolean | null;
  /** a gate simulating at N-1 would have WRONGLY refused this tx */
  falseBlock: boolean;
  funds: boolean;
  selfOrdered: boolean;
  reason: string;
  /** receipt re-checked on chain for every candidate false block */
  verifiedStatus?: 'success' | 'reverted';
  /** reverted at the sender's own gas limit but clean with headroom: the gate raises the limit, so NOT a false block */
  oogAtOwnLimit?: boolean;
  /** the raw N-1 outcome using the sender's own gas limit, before the gate-mode re-check */
  revertsAtN1OwnLimit?: boolean | null;
}

/** Pure classifier: given the three outcomes and the self-ordering flag, pick the class. Deterministic. */
export function classifyFailed(
  o: { n1: SimOutcome; n2: SimOutcome; n3: SimOutcome; selfOrdered: boolean },
): { class: ReplayClass; reason: string; knownAtK: 1 | 2 | 3 | null; funds: boolean; incomplete: boolean } {
  const { n1, n2, n3, selfOrdered } = o;
  const incomplete = n1.reverted === null || n2.reverted === null || n3.reverted === null;
  const funds = [n1, n2, n3].some((x) => x.reverted === true && x.funds);
  const firstRevert = [n1, n2, n3].find((x) => x.reverted === true);

  if (funds) {
    return {
      class: 'excluded-funds',
      reason: `sender-funds / reserve-balance condition at re-simulation (${firstRevert?.error ?? 'funds'}); excluded from avoidable per the PRD`,
      knownAtK: null,
      funds: true,
      incomplete,
    };
  }
  // Knowable = already doomed three blocks early: a gate would have caught it with a stale simulation.
  if (n3.reverted === true) {
    return { class: 'knowable', reason: `already reverting at N-3 (${n3.error ?? 'reverted'})`, knownAtK: 3, funds: false, incomplete };
  }
  if (n1.reverted === true || n2.reverted === true) {
    const k = n2.reverted === true ? 2 : 1;
    return {
      class: 'latency-sensitive',
      reason: `clean at N-3, reverting at N-${k} (${(k === 2 ? n2 : n1).error ?? 'reverted'}): catchable only by simulating immediately before sending`,
      knownAtK: k as 1 | 2,
      funds: false,
      incomplete,
    };
  }
  if (n1.reverted === null) {
    return { class: 'unavoidable', reason: `could not re-simulate at N-1 (${n1.rpcError ?? 'rpc error'})`, knownAtK: null, funds: false, incomplete: true };
  }
  if (selfOrdered) {
    return {
      class: 'unavoidable',
      reason: 'clean at N-1, but the sender had an earlier tx in block N, so state at N-1 is not what this tx actually saw',
      knownAtK: null,
      funds: false,
      incomplete,
    };
  }
  return {
    class: 'same-block',
    reason: 'clean at N-1, N-2 and N-3: whatever doomed it moved inside block N. No pending feed on Monad, so this is invisible to any client-side gate',
    knownAtK: null,
    funds: false,
    incomplete,
  };
}

// ---------------------------------------------------------------- resumable checkpoint

export interface Checkpoint {
  dir: string;
  file: string;
  /** keys already recorded */
  seen: Set<string>;
  append(key: string, row: unknown): void;
  rows<T>(): T[];
}

/** JSONL checkpoint under .readset/replay/<run>/. Lines are `{"k":<key>,"v":<row>}`; last write of a key wins. */
export function openCheckpoint(dir: string, name: string): Checkpoint {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const seen = new Set<string>();
  const byKey = new Map<string, unknown>();
  let needsNewline = false;
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    // A run killed mid-write leaves a line with no terminating newline; append one before writing again so the
    // torn fragment cannot swallow the next record.
    needsNewline = text.length > 0 && !text.endsWith('\n');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { k: string; v: unknown };
        seen.add(o.k);
        byKey.set(o.k, o.v);
      } catch {
        /* a torn last line from a killed run: ignore it, the key is simply redone */
      }
    }
  }
  return {
    dir,
    file,
    seen,
    append(key, row) {
      appendFileSync(file, (needsNewline ? '\n' : '') + JSON.stringify({ k: key, v: row }) + '\n');
      needsNewline = false;
      seen.add(key);
      byKey.set(key, row);
    },
    rows<T>() {
      return [...byKey.values()] as T[];
    },
  };
}

export function defaultReplayDir(run = 'main'): string {
  return path.resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..', '.readset', 'replay', run);
}

// ---------------------------------------------------------------- block fetch (candidate collection)

interface RawTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  input: Hex;
  value: Hex;
  gas: Hex;
  nonce: Hex;
  transactionIndex: Hex;
}
interface RawBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  transactions: RawTx[];
}

export interface Candidate {
  hash: Hex;
  blockNumber: number;
  blockTimestamp: number;
  txIndex: number;
  from: Hex;
  to: Hex | null;
  selector: Hex | null;
  data: Hex;
  value: Hex;
  gas: Hex;
  /** block hashes of N-1, N-2, N-3 (EIP-1898 pinning) */
  h: [Hex, Hex, Hex];
  selfOrdered: boolean;
  /** present for failed candidates (from the cached index) */
  effectiveGasPrice?: string;
  burnWei?: string;
  gasLimit?: string;
}

export interface BlockHarvest {
  blockNumber: number;
  failed: Candidate[];
  successful: Candidate[];
  /** tx counts in the block, for design weights */
  txs: number;
  successTxs: number;
  failedTxs: number;
}

const selectorOf = (input: string): Hex | null => (input && input.length >= 10 ? (input.slice(0, 10).toLowerCase() as Hex) : null);

/** Failed-tx rows for one block, out of the cached SQD index chunk that contains it. */
export async function failedRowsForBlocks(blocks: number[], cacheDir?: string): Promise<Map<number, FailedTx[]>> {
  const byChunk = new Map<number, number[]>();
  for (const n of blocks) {
    const a = Math.floor(n / DEFAULT_CHUNK) * DEFAULT_CHUNK;
    (byChunk.get(a) ?? byChunk.set(a, []).get(a)!).push(n);
  }
  const out = new Map<number, FailedTx[]>();
  for (const [a, ns] of [...byChunk.entries()].sort((x, y) => x[0] - y[0])) {
    const want = new Set(ns);
    const { rows } = await loadChunk(a, a + DEFAULT_CHUNK - 1, cacheDir ? { cacheDir } : {});
    for (const n of ns) out.set(n, []);
    for (const r of rows) if (want.has(r.blockNumber)) out.get(r.blockNumber)!.push(r);
  }
  return out;
}

/**
 * Harvest one sampled block: 2 RPC calls give the full tx list (with calldata), hash(N-1) (= parentHash) and
 * hash(N-2)/hash(N-3) (from the N-2 header). Failed txs come from the cached index; `successPerBlock` successful
 * txs are chosen uniformly at random inside the block with the run's seed.
 */
export async function harvestBlock(
  pool: RpcPool,
  n: number,
  failedIndexRows: FailedTx[],
  pick: () => number,
  successPerBlock = 1,
): Promise<BlockHarvest> {
  const [blk, prev2] = [
    await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(n), true]),
    await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(n - 2), false]),
  ];
  if (!blk) throw new Error(`block ${n} not found`);
  const h: [Hex, Hex, Hex] = [blk.parentHash, prev2.hash, prev2.parentHash];
  const ts = Number(BigInt(blk.timestamp));
  const failedHashes = new Map(failedIndexRows.map((r) => [r.hash.toLowerCase(), r]));

  // self-ordering: does an earlier tx in this block share the sender?
  const seenSenders = new Set<string>();
  const selfOrdered = new Map<string, boolean>();
  for (const t of blk.transactions) {
    const f = t.from.toLowerCase();
    selfOrdered.set(t.hash.toLowerCase(), seenSenders.has(f));
    seenSenders.add(f);
  }

  const mk = (t: RawTx): Candidate => ({
    hash: t.hash.toLowerCase() as Hex,
    blockNumber: n,
    blockTimestamp: ts,
    txIndex: Number(BigInt(t.transactionIndex)),
    from: t.from.toLowerCase() as Hex,
    to: t.to ? (t.to.toLowerCase() as Hex) : null,
    selector: selectorOf(t.input),
    data: (t.input ?? '0x') as Hex,
    value: (t.value ?? '0x0') as Hex,
    gas: t.gas,
    h,
    selfOrdered: selfOrdered.get(t.hash.toLowerCase()) ?? false,
  });

  const failed: Candidate[] = [];
  const succPool: Candidate[] = [];
  for (const t of blk.transactions) {
    if (BigInt(t.gas) === 0n) continue; // Monad system/staking syscalls: not user sends
    const f = failedHashes.get(t.hash.toLowerCase());
    if (f) {
      failed.push({
        ...mk(t),
        effectiveGasPrice: f.effectiveGasPrice.toString(),
        burnWei: f.burnWei.toString(),
        gasLimit: f.gasLimit.toString(),
      });
    } else {
      succPool.push(mk(t));
    }
  }
  // seeded uniform draw of successful txs inside the block (partial Fisher-Yates)
  const arr = [...succPool];
  const take = Math.min(successPerBlock, arr.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(pick() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return {
    blockNumber: n,
    failed,
    successful: arr.slice(0, take),
    txs: blk.transactions.length,
    successTxs: succPool.length,
    failedTxs: failed.length,
  };
}

// ---------------------------------------------------------------- public API: replayFailed / replaySuccessful

/**
 * Deterministic score in [0,1) for one candidate, derived from its tx hash and the run seed. Used to trim a
 * sample down to a target size: unlike shuffling an array, it does not depend on array order or length, so
 * growing the block sample does not re-draw the candidates that were already replayed.
 */
export function stableScore(hash: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 2; i < hash.length; i++) h = (Math.imul(h ^ hash.charCodeAt(i), 0x01000193) >>> 0);
  return rng(h)();
}

/** Deterministically trim candidates to `want` items, lowest stable score first. */
function trimTo<T extends { hash: Hex; blockNumber: number; txIndex: number }>(items: T[], want: number, seed: number): T[] {
  if (items.length <= want) return items;
  return [...items]
    .sort((a, b) => stableScore(a.hash, seed) - stableScore(b.hash, seed) || (a.hash < b.hash ? -1 : 1))
    .slice(0, want)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex);
}

async function blockHashesFor(pool: RpcPool, n: number): Promise<[Hex, Hex, Hex]> {
  const b1 = await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(n - 1), false]);
  const b3 = await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(n - 3), false]);
  return [b1.hash, b1.parentHash, b3.hash];
}

/** Build a Candidate from a tx hash alone (used by `replayFailed(hashes)` / `replaySuccessful(hashes)`). */
export async function candidateFromHash(pool: RpcPool, hash: Hex): Promise<{ cand: Candidate; status: 0 | 1; feeWei: bigint; effectiveGasPrice: bigint }> {
  const tx = await pool.call<RawTx & { blockNumber: Hex }>('eth_getTransactionByHash', [hash]);
  if (!tx) throw new Error(`tx ${hash} not found on ${pool.urls[0]}`);
  const rc = await pool.call<{ status: Hex; effectiveGasPrice: Hex; gasUsed: Hex }>('eth_getTransactionReceipt', [hash]);
  const n = Number(BigInt(tx.blockNumber));
  const h = await blockHashesFor(pool, n);
  const blk = await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(n), true]);
  let selfOrdered = false;
  for (const t of blk.transactions) {
    if (t.hash.toLowerCase() === hash.toLowerCase()) break;
    if (t.from.toLowerCase() === tx.from.toLowerCase()) selfOrdered = true;
  }
  const ts = Number(BigInt(blk.timestamp));
  const price = BigInt(rc.effectiveGasPrice);
  const gasLimit = BigInt(tx.gas);
  return {
    cand: {
      hash: hash.toLowerCase() as Hex,
      blockNumber: n,
      blockTimestamp: ts,
      txIndex: Number(BigInt(tx.transactionIndex)),
      from: tx.from.toLowerCase() as Hex,
      to: tx.to ? (tx.to.toLowerCase() as Hex) : null,
      selector: selectorOf(tx.input),
      data: (tx.input ?? '0x') as Hex,
      value: (tx.value ?? '0x0') as Hex,
      gas: tx.gas,
      h,
      selfOrdered,
      effectiveGasPrice: price.toString(),
      gasLimit: gasLimit.toString(),
      burnWei: (gasLimit * price).toString(),
    },
    status: Number(BigInt(rc.status)) as 0 | 1,
    feeWei: gasLimit * price,
    effectiveGasPrice: price,
  };
}

const callOf = (c: Candidate): SimCall => ({ from: c.from, to: c.to, data: c.data, value: c.value, gas: c.gas });

/**
 * Out-of-gas at the tx's OWN historical limit is not a gate refusal.
 * Readset's gate simulates with headroom and then CHOOSES the limit from the simulated gas
 * (see packages/core/src/gate/gas.ts), so replaying with the sender's tight limit measures the
 * sender's padding, not the gate. We re-simulate such calls with a generous cap to find out
 * whether the state actually rejects the call.
 */
const OOG_RE = /out of gas|gas required exceeds|exceeds gas limit|intrinsic gas too low/i;
/** Monad's per-tx cap; see docs/lineage/monad-docs. Generous headroom for the gate-mode oracle. */
const GATE_SIM_GAS: Hex = '0x1e84800'; // 32,000,000

const gateCallOf = (c: Candidate): SimCall => ({ ...callOf(c), gas: GATE_SIM_GAS });

/** Replay one failed candidate at N-1, N-2, N-3. */
export async function replayFailedCandidate(pool: RpcPool, c: Candidate): Promise<FailedReplayRow> {
  const n1 = await simulateAt(pool, callOf(c), c.h[0]);
  // short-circuit: if it already reverts at N-1 we still need N-2/N-3 to separate knowable from latency-sensitive
  const n2 = await simulateAt(pool, callOf(c), c.h[1]);
  const n3 = await simulateAt(pool, callOf(c), c.h[2]);
  const cls = classifyFailed({ n1, n2, n3, selfOrdered: c.selfOrdered });
  return {
    hash: c.hash,
    blockNumber: c.blockNumber,
    blockTimestamp: c.blockTimestamp,
    txIndex: c.txIndex,
    from: c.from,
    to: c.to,
    selector: c.selector,
    gasLimit: c.gasLimit ?? BigInt(c.gas).toString(),
    effectiveGasPrice: c.effectiveGasPrice ?? '0',
    burnWei: c.burnWei ?? '0',
    revertsAtN1: n1.reverted,
    revertsAtN2: n2.reverted,
    revertsAtN3: n3.reverted,
    class: cls.class,
    reason: cls.reason,
    knownAtK: cls.knownAtK,
    funds: cls.funds,
    selfOrdered: c.selfOrdered,
    incomplete: cls.incomplete,
  };
}

/** Replay one successful candidate at N-1. A revert here is a FALSE BLOCK. */
export async function replaySuccessfulCandidate(
  pool: RpcPool,
  c: Candidate,
  opts: { verify?: boolean } = {},
): Promise<SuccessReplayRow> {
  const n1 = await simulateAt(pool, callOf(c), c.h[0]);
  // Gate-mode oracle: an out-of-gas at the sender's own limit is re-checked with headroom,
  // because that is what Readset's gate would have done before choosing a limit.
  let oogAtOwnLimit = false;
  let n1Gate = n1;
  if (n1.reverted === true && !n1.funds && OOG_RE.test(n1.error ?? '')) {
    n1Gate = await simulateAt(pool, gateCallOf(c), c.h[0]);
    oogAtOwnLimit = n1Gate.reverted === false;
  }
  const falseBlock = n1Gate.reverted === true && !n1Gate.funds;
  let verifiedStatus: 'success' | 'reverted' | undefined;
  if (n1.reverted === true && opts.verify !== false) {
    // Every candidate false block gets its receipt re-read: we must be sure the tx really succeeded on chain.
    const rc = await pool.call<{ status: Hex } | null>('eth_getTransactionReceipt', [c.hash]);
    verifiedStatus = rc && Number(BigInt(rc.status)) === 1 ? 'success' : 'reverted';
  }
  const reason =
    n1.reverted === null
      ? `could not re-simulate at N-1 (${n1.rpcError ?? 'rpc error'})`
      : n1.reverted === false
        ? 'clean at N-1: the gate would have let it through (correct)'
        : oogAtOwnLimit
          ? `out of gas at the sender's own limit (${c.gasLimit ?? BigInt(c.gas).toString()}) but clean with headroom: the gate raises the limit instead of refusing, so not a false block`
          : n1.funds
            ? `refused at N-1 for sender funds / reserve balance (${n1.error}); excluded from the false-block numerator per the PRD`
            : `FALSE BLOCK: reverts at N-1 (${n1Gate.error ?? n1.error}) although the tx succeeded on chain${c.selfOrdered ? ' (sender had an earlier tx in block N, so N-1 state is stale for it)' : ''}`;
  return {
    hash: c.hash,
    blockNumber: c.blockNumber,
    blockTimestamp: c.blockTimestamp,
    txIndex: c.txIndex,
    from: c.from,
    to: c.to,
    selector: c.selector,
    gasLimit: c.gasLimit ?? BigInt(c.gas).toString(),
    effectiveGasPrice: c.effectiveGasPrice ?? '0',
    feeWei: c.burnWei ?? '0',
    revertsAtN1: n1.reverted,
    falseBlock: falseBlock && verifiedStatus !== 'reverted',
    funds: n1.funds,
    selfOrdered: c.selfOrdered,
    reason,
    verifiedStatus,
    oogAtOwnLimit,
    revertsAtN1OwnLimit: n1.reverted,
  };
}

export interface ReplayApiOptions extends RpcPoolOptions {
  pool?: RpcPool;
  concurrency?: number;
  onRow?: (r: FailedReplayRow | SuccessReplayRow) => void;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k]!, k);
      }
    }),
  );
  return out;
}

/**
 * `replayFailed(hashes)` - per-tx verdict for real Monad mainnet failures.
 * Each row says whether the same call already reverted 1, 2 and 3 blocks earlier, and why.
 */
export async function replayFailed(hashes: Hex[], o: ReplayApiOptions = {}): Promise<FailedReplayRow[]> {
  const pool = o.pool ?? new RpcPool(o);
  return mapLimit(hashes, o.concurrency ?? 6, async (h) => {
    const { cand, status } = await candidateFromHash(pool, h);
    if (status !== 0) throw new Error(`${h} did not fail on chain (receipt status 1): not a revert-burn sample member`);
    const row = await replayFailedCandidate(pool, cand);
    o.onRow?.(row);
    return row;
  });
}

/**
 * `replaySuccessful(hashes)` - would Readset's gate have WRONGLY refused a tx that actually succeeded?
 * Re-simulates each successful send at N-1; a revert is a false block.
 */
export async function replaySuccessful(hashes: Hex[], o: ReplayApiOptions = {}): Promise<SuccessReplayRow[]> {
  const pool = o.pool ?? new RpcPool(o);
  return mapLimit(hashes, o.concurrency ?? 6, async (h) => {
    const { cand, status } = await candidateFromHash(pool, h);
    if (status !== 1) throw new Error(`${h} did not succeed on chain (receipt status 0): not a false-block sample member`);
    const row = await replaySuccessfulCandidate(pool, cand);
    o.onRow?.(row);
    return row;
  });
}

// ---------------------------------------------------------------- the full, resumable benchmark run

export interface RunOptions {
  blocks?: number;
  seed?: number;
  frame?: SampleFrame;
  successPerBlock?: number;
  /** cap the failed sample (0 = no cap) */
  maxFailed?: number;
  concurrency?: number;
  rps?: number;
  urls?: readonly string[];
  dir?: string;
  cacheDir?: string;
  /** stop cleanly after this many ms of wall time (checkpoint keeps everything) */
  budgetMs?: number;
  /** cross-check this many rows against debug_traceCall + callTracer */
  crossCheck?: number;
  onProgress?: (p: { phase: 'harvest' | 'replay-failed' | 'replay-successful' | 'cross-check'; done: number; total: number; note?: string }) => void;
}

export interface RunResult {
  design: {
    frame: SampleFrame;
    frameTimestamps?: { from: number; to: number };
    seed: number;
    blocksRequested: number;
    blocksHarvested: number;
    successPerBlock: number;
    endpoints: readonly string[];
    rps: number;
    oracle: 'eth_call@blockHash';
    startedAt: string;
    finishedAt: string;
    wallMs: number;
    rpcCalls: number;
    truncated: boolean;
  };
  harvest: { blocks: number; txs: number; failedTxs: number; successTxs: number };
  failed: FailedReplayRow[];
  successful: SuccessReplayRow[];
  crossCheck: { n: number; agree: number; disagree: { hash: Hex; ethCall: boolean | null; traceCall: boolean | null }[] };
}

export async function runReplayBenchmark(o: RunOptions = {}): Promise<RunResult> {
  const t0 = Date.now();
  const frame = o.frame ?? FRAME;
  const seed = o.seed ?? DEFAULT_SEED;
  const nBlocks = o.blocks ?? 2000;
  const successPerBlock = o.successPerBlock ?? 1;
  const dir = o.dir ?? defaultReplayDir();
  const budget = o.budgetMs ?? Number.POSITIVE_INFINITY;
  const deadline = t0 + budget;
  const pool = new RpcPool({ urls: o.urls, rps: o.rps });
  const conc = o.concurrency ?? 8;
  let truncated = false;
  const outOfTime = () => Date.now() > deadline;

  const cpBlocks = openCheckpoint(dir, 'blocks');
  const cpFailed = openCheckpoint(dir, 'failed');
  const cpSucc = openCheckpoint(dir, 'successful');
  const cpMeta = openCheckpoint(dir, 'meta');

  // ---- phase 1: harvest sampled blocks
  const blocks = sampleBlocks(nBlocks, seed, frame);
  const todo = blocks.filter((n) => !cpBlocks.seen.has(String(n)));
  if (todo.length) {
    const failedIdx = await failedRowsForBlocks(todo, o.cacheDir);
    let done = 0;
    await mapLimit(todo, conc, async (n) => {
      if (outOfTime()) {
        truncated = true;
        return;
      }
      // per-block seeded picker: seed + block number, so resuming reproduces the same successful draw
      const pick = rng((seed ^ (n * 2654435761)) >>> 0);
      try {
        const hv = await harvestBlock(pool, n, failedIdx.get(n) ?? [], pick, successPerBlock);
        cpBlocks.append(String(n), hv);
      } catch (e) {
        cpBlocks.append(String(n), { blockNumber: n, failed: [], successful: [], txs: 0, successTxs: 0, failedTxs: 0, error: String(e) });
      }
      o.onProgress?.({ phase: 'harvest', done: ++done, total: todo.length });
    });
  }
  const harvests = cpBlocks.rows<BlockHarvest & { error?: string }>().filter((h) => !h.error);

  // ---- phase 2: replay the failed candidates
  let failedCands = harvests.flatMap((h) => h.failed).sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex);
  if (o.maxFailed) failedCands = trimTo(failedCands, o.maxFailed, (seed ^ 0x5eed) >>> 0);
  const fTodo = failedCands.filter((c) => !cpFailed.seen.has(c.hash));
  {
    let done = 0;
    await mapLimit(fTodo, conc, async (c) => {
      if (outOfTime()) {
        truncated = true;
        return;
      }
      try {
        cpFailed.append(c.hash, await replayFailedCandidate(pool, c));
      } catch (e) {
        o.onProgress?.({ phase: 'replay-failed', done, total: fTodo.length, note: `skip ${c.hash}: ${String(e)}` });
      }
      o.onProgress?.({ phase: 'replay-failed', done: ++done, total: fTodo.length });
    });
  }
  const failed = cpFailed.rows<FailedReplayRow>();

  // ---- phase 3: equal-size successful sample, same frame, same design
  const allSucc = harvests.flatMap((h) => h.successful).sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex);
  const want = failedCands.length;
  const succCands = trimTo(allSucc, want, (seed ^ 0xb10c) >>> 0);
  const sTodo = succCands.filter((c) => !cpSucc.seen.has(c.hash));
  {
    let done = 0;
    await mapLimit(sTodo, conc, async (c) => {
      if (outOfTime()) {
        truncated = true;
        return;
      }
      try {
        cpSucc.append(c.hash, await replaySuccessfulCandidate(pool, c));
      } catch (e) {
        o.onProgress?.({ phase: 'replay-successful', done, total: sTodo.length, note: `skip ${c.hash}: ${String(e)}` });
      }
      o.onProgress?.({ phase: 'replay-successful', done: ++done, total: sTodo.length });
    });
  }
  const successful = cpSucc.rows<SuccessReplayRow>();

  // ---- phase 4: oracle cross-check (eth_call vs debug_traceCall + callTracer) on a seeded subsample
  const xN = o.crossCheck ?? 40;
  const inFailed = new Set(failedCands.map((c) => c.hash));
  const inSucc = new Set(succCands.map((c) => c.hash));
  const xc: RunResult['crossCheck'] = { n: 0, agree: 0, disagree: [] };
  if (xN > 0 && failedCands.length) {
    const picks = trimTo(failedCands, xN, (seed ^ 0xc4ec) >>> 0);
    const byHash = new Map(failed.map((r) => [r.hash, r]));
    let done = 0;
    for (const c of picks) {
      if (outOfTime()) {
        truncated = true;
        break;
      }
      const key = `xc:${c.hash}`;
      let rec = cpMeta.seen.has(key) ? (cpMeta.rows<{ hash: Hex; traceCall: boolean | null }>().find((r) => r.hash === c.hash) ?? null) : null;
      if (!rec) {
        const t = await simulateAtViaTrace(pool, callOf(c), c.h[0]);
        rec = { hash: c.hash, traceCall: t.reverted };
        cpMeta.append(key, rec);
      }
      const ec = byHash.get(c.hash)?.revertsAtN1 ?? null;
      xc.n++;
      if (ec === rec.traceCall) xc.agree++;
      else xc.disagree.push({ hash: c.hash, ethCall: ec, traceCall: rec.traceCall });
      o.onProgress?.({ phase: 'cross-check', done: ++done, total: picks.length });
    }
  }

  let frameTimestamps: { from: number; to: number } | undefined;
  try {
    const a = await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(frame.fromBlock), false]);
    const b = await pool.call<RawBlock>('eth_getBlockByNumber', [hexQty(frame.toBlock), false]);
    frameTimestamps = { from: Number(BigInt(a.timestamp)), to: Number(BigInt(b.timestamp)) };
  } catch {
    /* non-fatal: the frame is defined by block numbers, timestamps are decoration */
  }

  const design = {
      frame,
      frameTimestamps,
      seed,
      blocksRequested: nBlocks,
      blocksHarvested: harvests.length,
      successPerBlock,
      endpoints: pool.urls,
      rps: pool.rps,
      oracle: 'eth_call@blockHash' as const,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      wallMs: Date.now() - t0,
      rpcCalls: pool.calls,
      truncated,
  } satisfies RunResult['design'];
  cpMeta.append('design', design);

  return {
    design,
    harvest: {
      blocks: harvests.length,
      txs: harvests.reduce((a, h) => a + h.txs, 0),
      failedTxs: harvests.reduce((a, h) => a + h.failedTxs, 0),
      successTxs: harvests.reduce((a, h) => a + h.successTxs, 0),
    },
    // only the designed sample is reported: a checkpoint can hold rows from a smaller earlier run of the same seed
    failed: failed.filter((r) => inFailed.has(r.hash)),
    successful: successful.filter((r) => inSucc.has(r.hash)),
    crossCheck: xc,
  };
}
