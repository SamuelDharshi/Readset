// Tracing helpers over Monad's debug_* RPCs: prestateTracer (+ diffMode) and callTracer.
// Ported and generalised from the Hotslot collector. No state is fabricated: everything here is a pure
// transform of real tracer output, or a thin RPC wrapper with backoff.
import { pad, type PublicClient } from 'viem';
import type { Hex } from '../types.js';

// ---------------------------------------------------------------- errors / rpc plumbing

export class TracingUnsupportedError extends Error {
  constructor(public readonly method: string, detail: string) {
    super(
      `RPC endpoint does not support ${method} (${detail}). Use an endpoint that does ` +
        `(https://testnet-rpc.monad.xyz, https://rpc.monad.xyz or the monadinfra.com endpoints; ` +
        `Ankr and rpc1.monad.xyz/Alchemy block debug_*), via READSET_RPC_URL.`,
    );
    this.name = 'TracingUnsupportedError';
  }
}

type Raw = (a: { method: string; params?: unknown[] }) => Promise<unknown>;
export const toHexQty = (n: bigint): Hex => `0x${n.toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE = /rate.?limit|limit reached|too many requests|429|capacity|throttl|exceeded|timeout|timed out|fetch failed|ECONNRESET/i;
const DENIED = /not allowed|not available|not enabled|not supported|unsupported|disabled|upgrade|paid plan|method not found|does not exist|forbidden/i;

function errText(e: unknown): { msg: string; code?: number } {
  let msg = e instanceof Error ? e.message : String(e);
  let code: number | undefined;
  let cur: any = e;
  for (let i = 0; i < 6 && cur; i++, cur = cur.cause) {
    if (typeof cur.code === 'number' && code === undefined) code = cur.code;
    if (typeof cur.status === 'number' && cur.status === 429) msg += ' 429';
    if (typeof cur.details === 'string' && cur.details) msg = cur.details + ' ' + msg;
  }
  return { msg, code };
}

/** Retry rate-limit / transient errors with exponential backoff; denied/unsupported errors are not retried. */
export async function withBackoff<T>(fn: () => Promise<T>, tries = 7): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const { msg, code } = errText(e);
      const retry = (code === -32005 || code === -32011 || RATE.test(msg)) && !DENIED.test(msg);
      if (!retry || i >= tries - 1) throw e;
      await sleep(Math.min(8000, 400 * 2 ** i) + Math.random() * 250);
    }
  }
}

async function traceRpc(client: PublicClient, method: string, params: unknown[]): Promise<any> {
  const raw = client.request as unknown as Raw;
  try {
    const r = await withBackoff(() => raw({ method, params }));
    if (!r || typeof r !== 'object') throw new Error(`${method}: empty trace result`);
    return r;
  } catch (e) {
    const { msg, code } = errText(e);
    if (code === -32601 || code === -32053 || DENIED.test(msg)) throw new TracingUnsupportedError(method, msg.split('\n')[0]!);
    throw e;
  }
}

// ---------------------------------------------------------------- normalisation

/** 0x1..0x1ff: EVM precompiles plus Monad's 0x100 reserve-balance precompile. */
export function isPrecompile(addr: string): boolean {
  const a = addr.toLowerCase();
  return /^0x0{37}[0-9a-f]{3}$/.test(a) && BigInt(a) > 0n && BigInt(a) < 0x200n;
}

/** 32-byte lowercase slot key (0x + 64 hex). Tracers may strip leading zeros. */
export function normalizeSlot(s: string): Hex {
  return pad(s as Hex, { size: 32 }).toLowerCase() as Hex;
}

export function normalizeAddress(a: string): Hex {
  return a.toLowerCase() as Hex;
}

/** Pseudo-slot naming an account's balance/nonce/code record (as opposed to a storage slot). */
export const ACCOUNT_SLOT = 'account' as const;

export function accountKey(address: string): string {
  return `${normalizeAddress(address)}:${ACCOUNT_SLOT}`;
}

export function slotKey(address: string, slot: string): string {
  return `${normalizeAddress(address)}:${normalizeSlot(slot)}`;
}

/** Inverse of accountKey/slotKey. `slot` is 'account' for account pseudo-keys. */
export function splitKey(key: string): { address: Hex; slot: Hex | typeof ACCOUNT_SLOT } {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`malformed slot key: ${key}`);
  const slot = key.slice(i + 1);
  return { address: normalizeAddress(key.slice(0, i)), slot: slot === ACCOUNT_SLOT ? ACCOUNT_SLOT : normalizeSlot(slot) };
}

const isZero = (v: string | undefined): boolean => v === undefined || /^0x0*$/.test(v);
const sameValue = (a: string | undefined, b: string | undefined) =>
  isZero(a) ? isZero(b) : !isZero(b) && BigInt(a!) === BigInt(b!);
const ZERO32: Hex = `0x${'0'.repeat(64)}`;

// ---------------------------------------------------------------- prestateTracer parsing

export interface PrestateAccount {
  balance?: string;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
}
export type PrestateMap = Record<string, PrestateAccount>;
export interface PrestateDiff {
  pre: PrestateMap;
  post: PrestateMap;
}
/** Raw prestateTracer output: a PrestateMap, or {pre, post} in diffMode. */
export type RawPrestate = PrestateMap | PrestateDiff;

export interface ParsedAccount {
  address: Hex;
  /** Values before execution (undefined when the account did not exist / was not reported). */
  pre?: { balance?: bigint; nonce?: number; code?: Hex };
  /** diffMode only: post-execution values; unchanged fields are omitted by the tracer. */
  post?: { balance?: bigint; nonce?: number; code?: Hex };
  /** diffMode: balance, nonce or code changed (or account created/removed). Non-diff: false. */
  changed: boolean;
}

export interface ParsedSlot {
  address: Hex;
  slot: Hex;
  /** Value before execution (32 bytes; zero for slots created by the tx). */
  pre: Hex;
  /** diffMode only: post value. A slot deleted by the tx has post = zero. */
  post?: Hex;
  /** diffMode: value changed. Non-diff mode: false (unknown; use diff output to learn writes). */
  written: boolean;
}

export interface ParsedPrestate {
  diffMode: boolean;
  accounts: ParsedAccount[]; // sorted by address
  slots: ParsedSlot[];       // sorted by (address, slot)
}

const big = (v: string | undefined) => (v === undefined ? undefined : BigInt(v));

function lowerMap(m: PrestateMap | undefined): PrestateMap {
  return Object.fromEntries(Object.entries(m ?? {}).map(([a, v]) => [normalizeAddress(a), v]));
}

export function isDiffResult(r: RawPrestate): r is PrestateDiff {
  const o = r as Record<string, unknown>;
  return typeof o === 'object' && o !== null && ('pre' in o || 'post' in o) && !('balance' in o);
}

/**
 * Pure parse of prestateTracer output into account/slot facts.
 *  - diffMode: only changed state is reported (pre/post); read-only slots are NOT included (see DependencySet.coverage).
 *  - full mode: every touched account/slot with its pre value.
 * Precompiles are dropped unless `excludePrecompiles: false`; `exclude` drops addresses (e.g. coinbase).
 */
export function parsePrestate(
  raw: RawPrestate,
  opts: { diffMode?: boolean; excludePrecompiles?: boolean; exclude?: Iterable<string> } = {},
): ParsedPrestate {
  const diffMode = opts.diffMode ?? isDiffResult(raw);
  const dropPre = opts.excludePrecompiles ?? true;
  const exclude = new Set([...(opts.exclude ?? [])].map((a) => a.toLowerCase()));
  const skip = (a: string) => exclude.has(a) || (dropPre && isPrecompile(a));

  const pre = lowerMap(diffMode ? (raw as PrestateDiff).pre : (raw as PrestateMap));
  const post = diffMode ? lowerMap((raw as PrestateDiff).post) : {};
  const addrs = [...new Set([...Object.keys(pre), ...Object.keys(post)])].filter((a) => !skip(a)).sort() as Hex[];

  const accounts: ParsedAccount[] = [];
  const slots: ParsedSlot[] = [];
  for (const a of addrs) {
    const p = pre[a];
    const q = post[a];
    let changed = false;
    if (diffMode) {
      if (q) {
        const nonceCh = q.nonce !== undefined && q.nonce !== (p?.nonce ?? 0);
        const balCh = q.balance !== undefined && !sameValue(q.balance, p?.balance);
        const codeCh = q.code !== undefined && !sameValue(q.code, p?.code);
        changed = nonceCh || balCh || codeCh || !p;
      } else if (p && p.code && !isZero(p.code)) {
        changed = true; // contract removed
      }
    }
    accounts.push({
      address: a,
      pre: p ? { balance: big(p.balance), nonce: p.nonce, code: p.code as Hex | undefined } : undefined,
      post: q ? { balance: big(q.balance), nonce: q.nonce, code: q.code as Hex | undefined } : undefined,
      changed,
    });

    const pk = new Map(Object.entries(p?.storage ?? {}).map(([k, v]) => [normalizeSlot(k), normalizeSlot(v)]));
    const qk = new Map(Object.entries(q?.storage ?? {}).map(([k, v]) => [normalizeSlot(k), normalizeSlot(v)]));
    for (const k of new Set([...pk.keys(), ...qk.keys()])) {
      const before = pk.get(k) ?? ZERO32;
      if (!diffMode) {
        slots.push({ address: a, slot: k, pre: before, written: false });
        continue;
      }
      // diffMode: present in pre but absent from post = deleted (net write to zero)
      const after = qk.has(k) ? qk.get(k)! : ZERO32;
      slots.push({ address: a, slot: k, pre: before, post: after, written: !sameValue(before, after) });
    }
  }
  slots.sort((x, y) =>
    x.address === y.address ? (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0) : x.address < y.address ? -1 : 1,
  );
  return { diffMode, accounts, slots };
}

/**
 * Convert a diff (+ optional full prestate) to read/write key sets (`addr:slot` / `addr:account`).
 * Written keys are also reads.
 */
export function accessFromPrestate(
  diff: PrestateDiff,
  accessed: PrestateMap | undefined,
  exclude: Set<string> = new Set(),
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const d = parsePrestate(diff, { diffMode: true, exclude });
  for (const a of d.accounts) {
    if (a.changed) writes.add(accountKey(a.address));
    if (a.pre) reads.add(accountKey(a.address));
  }
  for (const s of d.slots) {
    reads.add(slotKey(s.address, s.slot));
    if (s.written) writes.add(slotKey(s.address, s.slot));
  }
  if (accessed) {
    const f = parsePrestate(accessed, { diffMode: false, exclude });
    for (const a of f.accounts) reads.add(accountKey(a.address));
    for (const s of f.slots) reads.add(slotKey(s.address, s.slot));
  }
  for (const w of writes) reads.add(w);
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

// ---------------------------------------------------------------- RPC wrappers

/** Block selector: number, tag, or 32-byte block hash (sent as EIP-1898 {blockHash}). */
export type BlockSelector = bigint | 'latest' | 'earliest' | 'pending' | 'safe' | 'finalized' | Hex;

export function encodeBlockSelector(b: BlockSelector): string | { blockHash: Hex } {
  if (typeof b === 'bigint') return toHexQty(b);
  if (/^0x[0-9a-fA-F]{64}$/.test(b)) return { blockHash: b as Hex };
  return b;
}

export interface TraceTx {
  from: Hex;
  to?: Hex | null;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
}

function callObject(tx: TraceTx): Record<string, string> {
  const c: Record<string, string> = { from: tx.from };
  if (tx.to) c.to = tx.to;
  if (tx.data && tx.data !== '0x') c.data = tx.data;
  if (tx.value !== undefined) c.value = toHexQty(tx.value);
  if (tx.gas !== undefined) c.gas = toHexQty(tx.gas);
  return c;
}

const prestateCfg = (diffMode: boolean) =>
  diffMode ? { tracer: 'prestateTracer', tracerConfig: { diffMode: true } } : { tracer: 'prestateTracer' };

function finishPrestate(r: any, diffMode: boolean): { raw: RawPrestate; parsed: ParsedPrestate } {
  const raw: RawPrestate = diffMode ? { pre: r.pre ?? {}, post: r.post ?? {} } : r;
  return { raw, parsed: parsePrestate(raw, { diffMode }) };
}

/**
 * debug_traceCall with prestateTracer against the state at `block`.
 * diffMode=false (default): every touched account/slot with its pre value (full read set).
 * diffMode=true: only changed state (pre/post); read-only slots are omitted by the node.
 */
export async function traceCallPrestate(
  client: PublicClient,
  tx: TraceTx,
  block: BlockSelector,
  opts: { diffMode?: boolean } = {},
): Promise<{ raw: RawPrestate; parsed: ParsedPrestate }> {
  const diffMode = opts.diffMode ?? false;
  const r = await traceRpc(client, 'debug_traceCall', [callObject(tx), encodeBlockSelector(block), prestateCfg(diffMode)]);
  return finishPrestate(r, diffMode);
}

/** debug_traceTransaction with prestateTracer for a mined tx (per-tx sequential semantics). */
export async function traceTxPrestate(
  client: PublicClient,
  hash: Hex,
  opts: { diffMode?: boolean } = {},
): Promise<{ raw: RawPrestate; parsed: ParsedPrestate }> {
  const diffMode = opts.diffMode ?? false;
  const r = await traceRpc(client, 'debug_traceTransaction', [hash, prestateCfg(diffMode)]);
  return finishPrestate(r, diffMode);
}

// ---------------------------------------------------------------- callTracer

export interface CallFrame {
  type: string; // CALL | STATICCALL | DELEGATECALL | CREATE | CREATE2 | CALLCODE | SELFDESTRUCT
  from: Hex;
  to?: Hex;
  input?: Hex;
  output?: Hex;
  value?: Hex;
  gas?: Hex;
  gasUsed?: Hex;
  error?: string;
  revertReason?: string;
  calls?: CallFrame[];
}

export interface WalkedCall {
  frame: CallFrame;
  depth: number;
  /** index path from the root: [] root, [0] first child, [0,2] its third child */
  path: number[];
  parent?: CallFrame;
}

/** Depth-first pre-order walk of a callTracer tree. Return false from `visit` to skip that frame's children. */
export function walkCallTree(root: CallFrame, visit?: (c: WalkedCall) => void | boolean): WalkedCall[] {
  const out: WalkedCall[] = [];
  const go = (frame: CallFrame, depth: number, path: number[], parent?: CallFrame) => {
    const w: WalkedCall = { frame, depth, path, parent };
    out.push(w);
    if (visit?.(w) === false) return;
    (frame.calls ?? []).forEach((c, i) => go(c, depth + 1, [...path, i], frame));
  };
  go(root, 0, []);
  return out;
}

/** Unique lowercase callee addresses in a call tree. */
export function calleeAddresses(root: CallFrame): Hex[] {
  const s = new Set<Hex>();
  for (const { frame } of walkCallTree(root)) if (frame.to) s.add(normalizeAddress(frame.to));
  return [...s].sort();
}

/** debug_traceCall with callTracer against the state at `block`. */
export async function traceCallTree(client: PublicClient, tx: TraceTx, block: BlockSelector): Promise<CallFrame> {
  return (await traceRpc(client, 'debug_traceCall', [callObject(tx), encodeBlockSelector(block), { tracer: 'callTracer' }])) as CallFrame;
}

/** debug_traceTransaction with callTracer. */
export async function traceTxCallTree(client: PublicClient, hash: Hex): Promise<CallFrame> {
  return (await traceRpc(client, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }])) as CallFrame;
}
