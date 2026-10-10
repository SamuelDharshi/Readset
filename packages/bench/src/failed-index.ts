// Failed-transaction index for Monad MAINNET (chain 143), read-only, no keys required.
//
// Sources
//   sqd : SQD Portal public dataset `monad-mainnet` (https://portal.sqd.dev/datasets/monad-mainnet/stream).
//         Keyless. Streams every tx with status/gas/gasUsed/effectiveGasPrice; no server-side status filter,
//         so failures are filtered client-side. ~0.3 s of chain per ~0.0015 s of wall time per block when healthy.
//   rpc : public Monad RPCs, eth_getBlockByNumber(full) + eth_getBlockReceipts (~170 KB and ~1 s per block,
//         25 rps cap). Only usable for spot checks / cross-validation, not for 8.6M blocks.
//
// Monad charges gas_limit x price, and receipts report gasUsed == gasLimit, so burnWei = gasLimit x effectiveGasPrice.
//
// Cache: <cacheDir>/failed/<source>/<from>-<to>.jsonl.gz, one file per chunk (line 1 = chunk stats, rest = failed rows).
// Chunks are aligned to a fixed block grid (default 12000 blocks ~ 1h) so sample windows and the full run share files.
// Resumable: existing chunk files are never refetched; writes are atomic (tmp + rename).

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Hex = `0x${string}`;
export type FailedSource = 'sqd' | 'rpc';

export interface FailedTx {
  hash: Hex;
  blockNumber: number;
  blockTimestamp: number;
  txIndex: number;
  from: Hex;
  to: Hex | null;
  selector: Hex | null;     // first 4 bytes of calldata, null when calldata is empty
  nonce: number;
  gasLimit: bigint;
  gasUsed: bigint;          // receipt-level; equals gasLimit on Monad
  effectiveGasPrice: bigint; // wei
  burnWei: bigint;          // gasLimit x effectiveGasPrice
  status: 0;
  revertData?: Hex;         // not populated by bulk sources (needs a trace); reserved
}

export interface ChunkStats {
  source: FailedSource;
  fromBlock: number;
  toBlock: number;
  blocks: number;
  timestampFrom: number;
  timestampTo: number;
  totalTxs: number;         // all txs incl. system txs
  systemTxs: number;        // gas == 0 (staking/reward syscalls)
  userTxs: number;
  failedTxs: number;
  failedBurnWei: string;
  gasUsedNeGasLimitFailed: number; // sanity: failed txs where gasUsed != gasLimit (expected 0)
  fetchedAt: string;
}

export interface FetchOptions {
  fromBlock?: number;
  toBlock?: number;
  /** alternative to from/to: last N days/hours ending at endBlock (default: finalized head). */
  window?: { days?: number; hours?: number; endBlock?: number };
  source?: FailedSource;
  cacheDir?: string;        // default <repo>/.readset/cache
  chunkBlocks?: number;     // default 12000
  concurrency?: number;     // default 3 (sqd), rpc is limited per endpoint
  onProgress?: (p: { done: number; total: number; cached: boolean; chunk: string }) => void;
  signal?: AbortSignal;
}

export interface FetchResult { rows: FailedTx[]; chunks: ChunkStats[]; }

export const SQD_URL = 'https://portal.sqd.dev/datasets/monad-mainnet';
export const RPC_URLS = ['https://rpc.monad.xyz', 'https://rpc2.monad.xyz', 'https://rpc-mainnet.monadinfra.com'];
/** K1: the only two free mainnet endpoints that are full archive AND allow debug tracing. */
export const ARCHIVE_RPC_URLS = ['https://rpc2.monad.xyz', 'https://rpc-mainnet.monadinfra.com'];
export const DEFAULT_CHUNK = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hexToNum = (h: string) => Number(BigInt(h));

export function defaultCacheDir(): string {
  // packages/bench/src -> repo root
  return path.resolve(import.meta.dirname ?? process.cwd(), '..', '..', '..', '.readset', 'cache');
}

// ---------------------------------------------------------------- generic helpers

async function retry<T>(fn: () => Promise<T>, label: string, tries = 40): Promise<T> {
  let delay = 1500;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e: any) {
      if (e?.fatal || i >= tries - 1) {
        if (e instanceof RpcError) throw e;
        throw new Error(`${label}: ${e?.message ?? e}`);
      }
      await sleep(delay + Math.random() * 500);
      delay = Math.min(delay * 1.7, 30_000);
    }
  }
}

/** A JSON-RPC `error` object the node returned deliberately (revert, out of gas, pruned state). Not a transport failure. */
export class RpcError extends Error {
  readonly fatal = true;
  constructor(readonly method: string, readonly code: number, readonly rpcMessage: string, readonly data?: unknown) {
    super(`${method}: ${code} ${rpcMessage}`);
    this.name = 'RpcError';
  }
  /** the call ran but ran out of the gas we gave it (so a bigger allowance may change the outcome) */
  get isOutOfGas() { return /out of gas|gas required exceeds|intrinsic gas/i.test(this.rpcMessage); }
  /** the call executed and reverted: this is an answer, not an error */
  get isRevert() { return this.code === 3 || /revert|execution reverted/i.test(this.rpcMessage); }
  /** the endpoint does not have the state for that block any more */
  get isPrunedState() { return /historical state|not found|missing trie node|pruned/i.test(this.rpcMessage); }
}

export async function rpcCall<T = any>(method: string, params: unknown[], url = RPC_URLS[0], tries = 40): Promise<T> {
  return retry(async () => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.error) {
      // Must NOT match node answers that merely contain the word "limit" ("intrinsic gas greater than limit",
      // "gas limit reached"): those are real answers and have to reach the caller, not be retried as throttling.
      if (/rate.?limit|too many|request limit|quota|throttl|\b429\b/i.test(j.error.message ?? '')) throw new Error(j.error.message);
      throw new RpcError(method, j.error.code ?? 0, j.error.message ?? '', j.error.data);
    }
    return j.result as T;
  }, `${method}@${url}`, tries);
}

export async function sqdHead(): Promise<{ head: number; finalized: number }> {
  const r = await retry(async () => {
    const res = await fetch(`${SQD_URL}/finalized-head`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { number: number };
  }, 'sqd finalized-head');
  const h = await retry(async () => {
    const res = await fetch(`${SQD_URL}/head`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { number: number };
  }, 'sqd head');
  return { head: h.number, finalized: r.number };
}

export async function blockTimestamp(n: number): Promise<number> {
  const b = await rpcCall<{ timestamp: Hex }>('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
  return hexToNum(b.timestamp);
}

/** First block whose timestamp >= ts (binary search over the public RPC). */
export async function blockAtTimestamp(ts: number, hi: number): Promise<number> {
  let lo = 0;
  let h = hi;
  while (lo < h) {
    const mid = Math.floor((lo + h) / 2);
    if ((await blockTimestamp(mid)) < ts) lo = mid + 1; else h = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- chunk fetch: SQD

class ChunkAcc {
  rows: FailedTx[] = [];
  totalTxs = 0; systemTxs = 0; failedBurn = 0n; gasMismatch = 0;
  tsFrom = 0; tsTo = 0;
  addBlockHeader(num: number, ts: number) { if (!this.tsFrom) this.tsFrom = ts; this.tsTo = ts; void num; }
  add(blockNumber: number, ts: number, t: {
    hash: Hex; transactionIndex: number; from: Hex; to: Hex | null; selector: Hex | null; nonce: number;
    gas: bigint; gasUsed: bigint; effectiveGasPrice: bigint; status: number;
  }) {
    this.totalTxs++;
    if (t.gas === 0n) { this.systemTxs++; return; }
    if (t.status !== 0) return;
    const burnWei = t.gas * t.effectiveGasPrice;
    if (t.gasUsed !== t.gas) this.gasMismatch++;
    this.failedBurn += burnWei;
    this.rows.push({
      hash: t.hash, blockNumber, blockTimestamp: ts, txIndex: t.transactionIndex, from: t.from, to: t.to,
      selector: t.selector, nonce: t.nonce, gasLimit: t.gas, gasUsed: t.gasUsed,
      effectiveGasPrice: t.effectiveGasPrice, burnWei, status: 0,
    });
  }
}

const SQD_FIELDS = {
  transaction: {
    hash: true, from: true, to: true, sighash: true, gas: true, gasUsed: true,
    effectiveGasPrice: true, status: true, nonce: true, transactionIndex: true,
  },
  block: { number: true, timestamp: true },
};

async function fetchChunkSqd(from: number, to: number, signal?: AbortSignal): Promise<ChunkAcc> {
  const acc = new ChunkAcc();
  let cur = from;
  while (cur <= to) {
    const before = cur;
    await retry(async () => {
      const res = await fetch(`${SQD_URL}/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'evm', fromBlock: cur, toBlock: to, includeAllBlocks: true, fields: SQD_FIELDS, transactions: [{}] }),
        signal: signal ?? AbortSignal.timeout(300_000),
      });
      if (res.status === 204) throw new Error('204: range above SQD head');
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        if (ra > 0) await sleep(ra * 1000);
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok || !res.body) {
        throw Object.assign(new Error(`HTTP ${res.status} ${await res.text()}`), { fatal: res.status === 400 });
      }
      const dec = new TextDecoder();
      let buf = '';
      const handle = (line: string) => {
        if (!line) return;
        const o = JSON.parse(line);
        if (o.error) {
          throw Object.assign(new Error(`${o.error.code}: ${o.error.message}`), { fatal: o.error.code === 'malformed_request' });
        }
        const n: number = o.header.number;
        acc.addBlockHeader(n, o.header.timestamp);
        for (const t of o.transactions ?? []) {
          acc.add(n, o.header.timestamp, {
            hash: t.hash, transactionIndex: t.transactionIndex, from: t.from, to: t.to ?? null,
            selector: t.sighash ?? null, nonce: t.nonce,
            gas: BigInt(t.gas), gasUsed: BigInt(t.gasUsed), effectiveGasPrice: BigInt(t.effectiveGasPrice), status: t.status,
          });
        }
        cur = n + 1; // block fully processed
      };
      for await (const part of res.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(part, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) handle(buf);
    }, `sqd ${from}-${to} @${cur}`);
    if (cur === before && cur <= to) throw new Error(`sqd stalled at ${cur}`);
  }
  return acc;
}

// ---------------------------------------------------------------- chunk fetch: RPC (spot checks)

const rpcNext: number[] = RPC_URLS.map(() => 0);
const RPC_GAP_MS = [45, 60, 60]; // stay well below the 25/15/20 rps public caps

async function paced<T>(call: (url: string) => Promise<T>): Promise<T> {
  // pick the endpoint that is free soonest
  let k = 0;
  for (let i = 1; i < RPC_URLS.length; i++) if (rpcNext[i] < rpcNext[k]) k = i;
  const wait = Math.max(0, rpcNext[k] - Date.now());
  rpcNext[k] = Math.max(Date.now(), rpcNext[k]) + RPC_GAP_MS[k];
  if (wait) await sleep(wait);
  return call(RPC_URLS[k]);
}

async function fetchChunkRpc(from: number, to: number): Promise<ChunkAcc> {
  const acc = new ChunkAcc();
  const nums = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const out = new Map<number, () => void>();
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const n = nums[idx++];
      if (n === undefined) return;
      const hx = '0x' + n.toString(16);
      const [blk, rcs] = await Promise.all([
        paced((u) => rpcCall<any>('eth_getBlockByNumber', [hx, true], u)),
        paced((u) => rpcCall<any[]>('eth_getBlockReceipts', [hx], u)),
      ]);
      out.set(n, () => {
        const ts = hexToNum(blk.timestamp);
        acc.addBlockHeader(n, ts);
        blk.transactions.forEach((tx: any, i: number) => {
          const r = rcs[i];
          if (r.transactionHash !== tx.hash) throw new Error(`receipt/tx mismatch in block ${n}`);
          acc.add(n, ts, {
            hash: tx.hash, transactionIndex: i, from: tx.from.toLowerCase(), to: tx.to ? tx.to.toLowerCase() : null,
            selector: tx.input && tx.input.length >= 10 ? (tx.input.slice(0, 10) as Hex) : null, nonce: hexToNum(tx.nonce),
            gas: BigInt(tx.gas), gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice), status: hexToNum(r.status),
          });
        });
      });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  for (const n of nums) out.get(n)!(); // apply in block order
  return acc;
}

// ---------------------------------------------------------------- cache

const fileFor = (dir: string, source: FailedSource, a: number, b: number) =>
  path.join(dir, 'failed', source, `${a}-${b}.jsonl.gz`);

const ser = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function revive(r: any): FailedTx {
  return { ...r, gasLimit: BigInt(r.gasLimit), gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice), burnWei: BigInt(r.burnWei) };
}

export function readChunk(file: string): { stats: ChunkStats; rows: FailedTx[] } {
  const lines = gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
  return { stats: JSON.parse(lines[0]), rows: lines.slice(1).map((l) => revive(JSON.parse(l))) };
}

function writeChunk(file: string, stats: ChunkStats, rows: FailedTx[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = [JSON.stringify(stats), ...rows.map((r) => JSON.stringify(r, ser))].join('\n') + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, gzipSync(body));
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- public API

/** Resolve options to a concrete block range. */
export async function resolveRange(o: FetchOptions): Promise<{ fromBlock: number; toBlock: number }> {
  if (o.fromBlock !== undefined && o.toBlock !== undefined) return { fromBlock: o.fromBlock, toBlock: o.toBlock };
  if (!o.window) throw new Error('fetchFailedTxs: pass {fromBlock,toBlock} or {window}');
  const end = o.window.endBlock ?? (await sqdHead()).finalized;
  const seconds = (o.window.days ?? 0) * 86400 + (o.window.hours ?? 0) * 3600;
  const endTs = await blockTimestamp(end);
  const start = await blockAtTimestamp(endTs - seconds, end);
  return { fromBlock: start, toBlock: end };
}

/** Plan grid-aligned chunks covering [from,to]. */
export function planChunks(from: number, to: number, chunk = DEFAULT_CHUNK): [number, number][] {
  const out: [number, number][] = [];
  for (let a = from; a <= to; ) {
    const gridEnd = (Math.floor(a / chunk) + 1) * chunk - 1;
    const b = Math.min(gridEnd, to);
    out.push([a, b]);
    a = b + 1;
  }
  return out;
}

/** Fetch (or load from cache) one chunk. */
export async function loadChunk(a: number, b: number, o: FetchOptions = {}): Promise<{ stats: ChunkStats; rows: FailedTx[]; cached: boolean }> {
  const source = o.source ?? 'sqd';
  const dir = o.cacheDir ?? defaultCacheDir();
  const file = fileFor(dir, source, a, b);
  if (existsSync(file)) return { ...readChunk(file), cached: true };
  const acc = source === 'sqd' ? await fetchChunkSqd(a, b, o.signal) : await fetchChunkRpc(a, b);
  const stats: ChunkStats = {
    source, fromBlock: a, toBlock: b, blocks: b - a + 1, timestampFrom: acc.tsFrom, timestampTo: acc.tsTo,
    totalTxs: acc.totalTxs, systemTxs: acc.systemTxs, userTxs: acc.totalTxs - acc.systemTxs,
    failedTxs: acc.rows.length, failedBurnWei: acc.failedBurn.toString(),
    gasUsedNeGasLimitFailed: acc.gasMismatch, fetchedAt: new Date().toISOString(),
  };
  writeChunk(file, stats, acc.rows);
  return { stats, rows: acc.rows, cached: false };
}

/** Stream chunks in block order as they complete (bounded memory; use for the full 30-day run). */
export async function* iterateFailedTxs(o: FetchOptions): AsyncGenerator<{ stats: ChunkStats; rows: FailedTx[]; cached: boolean }> {
  const { fromBlock, toBlock } = await resolveRange(o);
  const plan = planChunks(fromBlock, toBlock, o.chunkBlocks ?? DEFAULT_CHUNK);
  const conc = o.concurrency ?? 3;
  const inflight = new Map<number, Promise<{ stats: ChunkStats; rows: FailedTx[]; cached: boolean }>>();
  let next = 0, done = 0;
  const launch = () => {
    while (next < plan.length && inflight.size < conc) {
      const i = next++;
      inflight.set(i, loadChunk(plan[i][0], plan[i][1], o));
    }
  };
  launch();
  for (let i = 0; i < plan.length; i++) {
    const r = await inflight.get(i)!;
    inflight.delete(i);
    launch();
    done++;
    o.onProgress?.({ done, total: plan.length, cached: r.cached, chunk: `${plan[i][0]}-${plan[i][1]}` });
    yield r;
  }
}

export async function fetchFailedTxs(o: FetchOptions): Promise<FetchResult> {
  const rows: FailedTx[] = [];
  const chunks: ChunkStats[] = [];
  for await (const c of iterateFailedTxs(o)) { rows.push(...c.rows); chunks.push(c.stats); }
  return { rows, chunks };
}

// ---------------------------------------------------------------- paced archive pool (traces / re-simulation)

/**
 * Round-robins a fixed set of endpoints with a minimum gap between calls to each, so the combined rate stays
 * under `rps`. A deliberate JSON-RPC answer (revert / out of gas) is returned to the caller immediately; a
 * transport failure, a 429 storm or pruned state fails over to the next endpoint. K1 measured ~19-40 of 40
 * burst calls failing on monadinfra, so failover matters more than raw throughput here.
 */
export class ArchivePacer {
  private next: number[];
  private readonly gapMs: number;
  readonly calls: Record<string, number> = {};
  readonly failovers: Record<string, number> = {};
  constructor(readonly urls: string[] = ARCHIVE_RPC_URLS, rps = 8) {
    this.next = urls.map(() => 0);
    this.gapMs = (1000 * urls.length) / rps; // per-endpoint gap; urls in parallel => ~rps combined
    for (const u of urls) { this.calls[u] = 0; this.failovers[u] = 0; }
  }
  private async slot(): Promise<number> {
    let k = 0;
    for (let i = 1; i < this.urls.length; i++) if (this.next[i] < this.next[k]) k = i;
    const wait = Math.max(0, this.next[k] - Date.now());
    this.next[k] = Math.max(Date.now(), this.next[k]) + this.gapMs;
    if (wait) await sleep(wait);
    return k;
  }
  /** Run `method` on the pool. Throws RpcError for a deliberate node answer; throws after every endpoint failed. */
  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < this.urls.length; attempt++) {
      const k = await this.slot();
      const url = this.urls[k];
      this.calls[url]++;
      try {
        return await rpcCall<T>(method, params, url, 4);
      } catch (e) {
        if (e instanceof RpcError && !e.isPrunedState) throw e; // a real answer: revert / out of gas
        this.failovers[url]++;
        this.next[k] = Date.now() + 2000; // cool this endpoint down
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(`${method}: all endpoints failed`);
  }
}

/** Top-level callTracer facts for a mined transaction. Monad reports gasUsed == gasLimit here too, so only
 *  `error` / `output` are informative; the real consumed gas has to be re-simulated. */
export interface FailureTrace {
  hash: Hex;
  /** callTracer `error` for the top-level call, e.g. "out of gas", "execution reverted" */
  error: string | null;
  outOfGas: boolean;
  revertOutput: Hex | null;
}

export async function traceFailure(hash: Hex, p: ArchivePacer): Promise<FailureTrace> {
  const t = await p.call<any>('debug_traceTransaction', [hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } }]);
  const error: string | null = typeof t?.error === 'string' ? t.error : null;
  const out = typeof t?.output === 'string' && t.output !== '0x' ? (t.output as Hex) : null;
  return { hash, error, outOfGas: /out of gas/i.test(error ?? ''), revertOutput: out };
}

export interface ResimGas {
  /** 'estimate' = eth_estimateGas answered; 'bisect' = tx reverts at the parent block, so gas-to-revert was
   *  bisected with eth_call; 'unavailable' = neither worked (state pruned, endpoint refused, non-monotonic). */
  mode: 'estimate' | 'bisect' | 'unavailable';
  gas: bigint | null;
  /** what the same tx does when replayed against the PARENT block's state */
  atParent: 'success' | 'revert' | 'out-of-gas-at-limit' | 'unknown';
  revertAtParent?: string;
  rpcCalls: number;
  note?: string;
}

/**
 * Re-simulated gas for one transaction at its parent block.
 *
 * Monad charges (and reports) the full gas limit, so the receipt and the trace cannot tell us how much gas the
 * transaction actually needed. Two paths:
 *   - the tx succeeds against the parent state -> `eth_estimateGas` gives the number directly;
 *   - the tx reverts there -> estimateGas refuses, so bisect the gas allowance with `eth_call` for the smallest
 *     allowance that does NOT come back "out of gas". That is the gas consumed up to the revert, which is what a
 *     wallet's estimator would have charged for. Monad returns code -32003 "out of gas" for a starved call and a
 *     revert otherwise, so the predicate is observable.
 */
export async function resimGas(
  tx: { from: Hex; to: Hex | null; input: Hex; value: Hex; gasLimit: bigint },
  parentBlock: number,
  p: ArchivePacer,
  ceiling = 30_000_000n,
): Promise<ResimGas> {
  const blockTag = '0x' + parentBlock.toString(16);
  const base = { from: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value };
  let n = 0;
  const hi0 = tx.gasLimit > ceiling ? ceiling : tx.gasLimit;

  try {
    n++;
    const g = await p.call<Hex>('eth_estimateGas', [{ ...base, gas: '0x' + hi0.toString(16) }, blockTag]);
    return { mode: 'estimate', gas: BigInt(g), atParent: 'success', rpcCalls: n };
  } catch (e) {
    if (!(e instanceof RpcError)) return { mode: 'unavailable', gas: null, atParent: 'unknown', rpcCalls: n, note: (e as Error).message };
    if (!e.isRevert && !e.isOutOfGas) return { mode: 'unavailable', gas: null, atParent: 'unknown', rpcCalls: n, note: e.message };
  }

  // Bisect: predicate(g) = "the call did not run out of gas with allowance g".
  const probe = async (g: bigint): Promise<{ enough: boolean; revert?: string }> => {
    n++;
    try { await p.call<Hex>('eth_call', [{ ...base, gas: '0x' + g.toString(16) }, blockTag]); return { enough: true }; }
    catch (e) {
      if (e instanceof RpcError && e.isOutOfGas) return { enough: false };
      if (e instanceof RpcError) return { enough: true, revert: e.rpcMessage };
      throw e;
    }
  };

  const atLimit = await probe(hi0);
  if (!atLimit.enough) {
    // Even the tx's own limit was not enough against the parent state: a genuinely under-funded tx, not padded.
    return { mode: 'bisect', gas: null, atParent: 'out-of-gas-at-limit', rpcCalls: n, note: 'ran out of gas at its own limit' };
  }
  // 1% tolerance: ~7 probes instead of ~18, and the 2x proxy does not need more precision. `hi` stays an
  // upper bound on the gas consumed, so the reported gasLimit/resim ratio is a slight UNDER-estimate.
  let lo = 20_999n, hi = hi0; // lo known-insufficient, hi known-sufficient
  while (hi - lo > hi / 100n && hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const r = await probe(mid);
    if (r.enough) hi = mid; else lo = mid;
  }
  return { mode: 'bisect', gas: hi, atParent: 'revert', revertAtParent: atLimit.revert, rpcCalls: n };
}

// ---------------------------------------------------------------- analysis helpers

export const WEI_PER_MON = 10n ** 18n;
export const weiToMon = (w: bigint | string): number => {
  const x = BigInt(w);
  return Number(x / 10n ** 12n) / 1e6; // 1e-6 MON resolution, safe for totals
};

export interface FailureRun {
  from: Hex; startNonce: number; failures: number; burnWei: bigint;
  firstBlock: number; lastBlock: number; to: Hex | null; selector: Hex | null;
  /** burn after the first `breaker` failures (what a breaker of that size would have prevented) */
  burnAfterBreakerWei: bigint;
}

/**
 * Detects runs of consecutive failed nonces per sender. Because every mined tx consumes a nonce, failed rows with
 * contiguous nonces imply no success in between. Feed rows in (blockNumber, txIndex) order; call finish() at the end.
 * Runs are truncated at the edges of whatever data was fed (sample windows give lower bounds).
 */
export class RunTracker {
  private open = new Map<string, FailureRun & { n: number }>();
  readonly runs: FailureRun[] = [];
  constructor(private minRun = 10, private breaker = 5) {}
  private close(s: FailureRun & { n: number }) {
    if (s.failures >= this.minRun) { const { n: _n, ...r } = s; this.runs.push(r); }
  }
  feed(r: FailedTx) {
    const cur = this.open.get(r.from);
    if (cur && r.nonce === cur.n + 1) {
      cur.n = r.nonce; cur.failures++; cur.burnWei += r.burnWei; cur.lastBlock = r.blockNumber;
      if (cur.failures > this.breaker) cur.burnAfterBreakerWei += r.burnWei;
      return;
    }
    if (cur) this.close(cur);
    this.open.set(r.from, {
      from: r.from, startNonce: r.nonce, n: r.nonce, failures: 1, burnWei: r.burnWei, firstBlock: r.blockNumber,
      lastBlock: r.blockNumber, to: r.to, selector: r.selector, burnAfterBreakerWei: 0n,
    });
  }
  finish(): FailureRun[] {
    for (const s of this.open.values()) this.close(s);
    this.open.clear();
    return this.runs;
  }
}
