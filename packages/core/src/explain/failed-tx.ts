// "Why your bot lost": explain one mined, FAILED Monad transaction.
//
// What it does, in order, using only real RPC data:
//  1. eth_getTransactionByHash + eth_getTransactionReceipt. Refuses anything that did not fail
//     (status 0x0) and records the burn: gasLimit x effectiveGasPrice (Monad charges the limit).
//  2. debug_traceTransaction (prestateTracer, non-diff) for the dependency set and the slot VALUES the
//     transaction actually saw at its position in block N, and callTracer for its revert data.
//  3. Re-simulates the exact same call (same from/to/data/value/gas) with debug_traceCall against the
//     END state of blocks N-1, N-2 and N-3, pinned by block HASH (EIP-1898) so the basis is exact and
//     reproducible even across reorg-free re-runs. Non-diff prestateTracer, because kill test K1 showed
//     diffMode omits read-only slots. eth_call at the same pinned basis gives the success/revert verdict.
//  4. Builds a per-slot value timeline [N-3, N-2, N-1, executed], filling gaps with eth_getStorageAt at
//     the same pinned hashes (capped), and calls a slot "moved" when two adjacent known values differ.
//  5. Attributes each moved slot to the transaction that last wrote it (writers.ts, diffMode block traces).
//  6. Classifies: knowable / latency-sensitive / same-block / unavoidable / unknown (avoidable.ts).
//
// Honesty rules baked in:
//  - If the re-simulation SUCCEEDS at N-1, the verdict is 'same-block' and the explanation states that it
//    was undetectable before sending, because Monad has no pending-transaction feed. No avoidability claim.
//  - A moved slot is only listed in `movedSlots` (the shared Explanation shape, which requires a writer)
//    when a real writer transaction was found. Everything else goes to `unattributedMovements` with the
//    scanned window, so a missing writer is visible rather than invented.
//  - Reserve-balance / insufficient-funds failures are never called avoidable (PRD).
//  - Slot labels come from core's labeller only when the caller supplies one (it needs the contract's solc
//    storage layout); otherwise the raw slot is reported unlabelled.
//
// Cost per explanation (default options): 2 block-header reads + 2 tx traces + 3 eth_call + 3 traceCall
// prestate + <= 4 debug_traceBlockByNumber (diffMode, ~0.3 MB each) + a few eth_getStorageAt
// = ~15-20 RPC calls, dominated by the block traces. Use `maxWriterBlocks` / `prestateAtEveryK` to shrink.

import type { PublicClient } from 'viem';
import type { Explanation, Hex, SlotDependency } from '../types.js';
import { normalizeAddress, normalizeSlot, parsePrestate, slotKey, toHexQty, withBackoff, type CallFrame } from '../trace/index.js';
import {
  burnFacts,
  classifyResims,
  decodeRevert,
  isFundsFailure,
  type AvoidableClass,
  type BurnFacts,
  type DecodedRevert,
  type ResimAtK,
  type ResimOutcome,
} from './avoidable.js';
import { findSlotWriters, type SlotLabelerLike, type WriterScanResult } from './writers.js';

// ---------------------------------------------------------------- public shapes

export type BasisName = 'N-3' | 'N-2' | 'N-1' | 'executed';

export interface SlotTimeline {
  address: Hex;
  slot: Hex;
  label?: string;
  /** Value at each basis we could establish; a basis is absent when neither the trace nor a read gave it. */
  values: Partial<Record<BasisName, Hex>>;
  /** Earliest known value in the timeline. */
  from: Hex;
  /** Value the transaction actually executed against (or the latest known basis). */
  to: Hex;
  /** Bases where this slot appeared in the dependency set (as opposed to being read to fill a gap). */
  inDependencySetAt: BasisName[];
}

export interface Movement extends SlotTimeline {
  /** Where the value last changed, as a basis pair, e.g. 'N-1 -> executed'. */
  changedBetween: string;
  /**
   * True for Monad's system account 0x...1000 (no code, protocol-written staking/fee accounting that moves
   * every block). Such a movement is never the user-visible cause, so it is ranked last and never quoted
   * in the rationale. It is NOT dropped: the raw row stays visible.
   */
  systemAccount: boolean;
}

export interface AttributedMovement extends Movement {
  writerTx: Hex;
  writerSender: Hex;
  writerBlock: bigint;
  writerTxIndex: number;
  /** The writer is an earlier transaction in the failed transaction's own block. */
  sameBlock: boolean;
}

export interface ResimDetail extends ResimAtK {
  /** Dependency set the call WOULD have seen at this basis (non-diff prestateTracer, so read-only slots included). */
  slots: SlotDependency[];
}

/** Superset of the shared `Explanation`: same fields, plus the evidence behind the verdict. */
export interface FullExplanation extends Explanation {
  chainId: number;
  from: Hex;
  to: Hex | null;
  nonce: number;
  txIndex: number;
  /** Hash of block N, for reproducibility. */
  failedBlockHash: Hex;
  burn: BurnFacts;
  /** burnedWei === gasLimit x effectiveGasPrice, checked against the receipt. */
  burnEqualsLimitTimesPrice: boolean;
  /** Revert data/reason from the real execution (debug_traceTransaction callTracer). */
  executedRevert: DecodedRevert;
  avoidableClass: AvoidableClass;
  avoidable: boolean;
  rationale: string;
  undetectableWithoutPendingFeed: boolean;
  /** The N-1 / N-2 / N-3 re-simulations, in that order. */
  resims: ResimDetail[];
  /** Dependency set the transaction actually executed against. coverage is 'full' per K1 (non-diff tracer). */
  executedSlots: SlotDependency[];
  coverage: 'full' | 'written-only';
  /** Moved slots WITH a writer: same rows as `movedSlots`, plus the value timeline and the writer's index. */
  attributedMovements: AttributedMovement[];
  /** Moved slots with no writer found inside the scanned window. */
  unattributedMovements: Movement[];
  writerScan: {
    blocksScanned: string[];
    blockTraces: number;
    capped: boolean;
    errors: Array<{ block: string; error: string }>;
    /** Attributions dropped because the named transaction's own trace did not confirm the write. */
    rejected: Array<{ address: Hex; slot: Hex; writerTx: Hex; reason: string }>;
  };
  /** Non-fatal caveats (pruned state, capped reads, missing labels...). Sorted, so the result is stable. */
  notes: string[];
}

export interface ExplainOptions {
  /** Writer-scan cap in blocks, counting N (default 4 => N, N-1, N-2, N-3). */
  maxWriterBlocks?: number;
  /** Re-simulate the dependency set at all three bases (default true) or only at N-1. */
  prestateAtEveryK?: boolean;
  /** Cap on eth_getStorageAt gap-fill reads (default 64). */
  maxStorageReads?: number;
  /** Optional slot labeller (core's buildSlotLabeler); only resolves when the layout is known. */
  labeler?: SlotLabelerLike;
  /** Explain a transaction that did NOT fail (default false: such a call throws). */
  allowSuccess?: boolean;
  /** Milliseconds between heavy calls (default 120, under ~8 rps). */
  minIntervalMs?: number;
}

// ---------------------------------------------------------------- rpc helpers

type Raw = (a: { method: string; params?: unknown[] }) => Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASES: BasisName[] = ['N-3', 'N-2', 'N-1', 'executed'];

/**
 * Monad system accounts seen in real traces: 0x...1000 holds no code but a large balance and protocol-written
 * storage (staking / fee accounting) that moves in most blocks. Movements there are mechanical, not causes.
 */
export const MONAD_SYSTEM_ACCOUNTS: Hex[] = ['0x0000000000000000000000000000000000001000'];

const isSystemAccount = (a: Hex) => MONAD_SYSTEM_ACCOUNTS.includes(normalizeAddress(a));

/** Most explanatory first: real contracts before system accounts, slots the tx read at execution first. */
/** Stable, deduped slot list: one entry per (address, slot), ordered. */
function dedupeSlots(list: SlotDependency[]): SlotDependency[] {
  const by = new Map<string, SlotDependency>();
  for (const s of list) {
    const k = `${s.address.toLowerCase()}:${s.slot.toLowerCase()}`;
    if (!by.has(k)) by.set(k, s);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

export function rankMovements<T extends Movement>(movements: T[]): T[] {
  const score = (m: Movement) => (m.systemAccount ? 2 : 0) + (m.inDependencySetAt.includes('executed') ? 0 : 1);
  return [...movements].sort(
    (a, b) => score(a) - score(b) || a.address.localeCompare(b.address) || a.slot.localeCompare(b.slot),
  );
}

function errLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0]!.slice(0, 300);
}

/** Pull the JSON-RPC error data (revert payload) out of a viem/fetch error chain. */
function rpcErrorData(e: unknown): { message: string; data?: Hex; code?: number } {
  let message = errLine(e);
  let data: Hex | undefined;
  let code: number | undefined;
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++, cur = cur.cause) {
    if (typeof cur.code === 'number' && code === undefined) code = cur.code;
    if (typeof cur.data === 'string' && /^0x[0-9a-fA-F]*$/.test(cur.data) && data === undefined) data = cur.data as Hex;
    if (typeof cur.details === 'string' && cur.details) message = cur.details.split('\n')[0]!;
    // viem wraps revert payloads in `cause.data` or `cause.cause.data`
    if (cur.data && typeof cur.data === 'object' && typeof cur.data.data === 'string' && data === undefined) data = cur.data.data as Hex;
  }
  return { message, data, code };
}

const REVERT_RE = /execution reverted|revert|invalid opcode|out of gas|stack|invalid jump/i;

// ---------------------------------------------------------------- main

/**
 * Explain any failed Monad transaction: which dependency moved, who moved it, and whether it was
 * knowable before sending. Needs an archive endpoint with debug_* (mainnet: rpc2.monad.xyz or
 * rpc-mainnet.monadinfra.com; see docs/kill-tests/K1.md).
 */
export async function explainFailedTx(client: PublicClient, txHash: Hex, opts: ExplainOptions = {}): Promise<FullExplanation> {
  const raw = client.request as unknown as Raw;
  const gap = Math.max(0, opts.minIntervalMs ?? 120);
  const notes: string[] = [];
  const req = <T>(method: string, params: unknown[]) => withBackoff(() => raw({ method, params })) as Promise<T>;

  // --- 1. transaction + receipt ---------------------------------------------------------------
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error(`explainFailedTx: not a transaction hash: ${txHash}`);
  const hash = txHash.toLowerCase() as Hex;
  const [tx, receipt] = await Promise.all([
    req<any>('eth_getTransactionByHash', [hash]),
    req<any>('eth_getTransactionReceipt', [hash]),
  ]);
  if (!tx) throw new Error(`explainFailedTx: transaction ${hash} not found on this endpoint`);
  if (!receipt) throw new Error(`explainFailedTx: transaction ${hash} is not mined yet (no receipt)`);
  const failed = BigInt(receipt.status ?? '0x1') === 0n;
  if (!failed && !opts.allowSuccess) {
    throw new Error(`explainFailedTx: ${hash} succeeded (receipt status ${receipt.status}); this explains failures only`);
  }
  if (!failed) notes.push('This transaction SUCCEEDED; it is being explained only because allowSuccess was set.');

  const N = BigInt(tx.blockNumber);
  const txIndex = Number(BigInt(tx.transactionIndex ?? receipt.transactionIndex ?? '0x0'));
  const gasLimit = BigInt(tx.gas);
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? '0x0');
  const burn = burnFacts({ gasLimit, effectiveGasPrice, receiptGasUsed: BigInt(receipt.gasUsed ?? '0x0') });
  if (!burn.receiptGasUsedEqualsLimit) {
    notes.push(`Receipt gasUsed (${burn.receiptGasUsed}) differs from the gas limit (${burn.gasLimit}); burnedWei still uses the limit, as Monad charges the limit.`);
  }

  const call = {
    from: normalizeAddress(tx.from),
    to: tx.to ? normalizeAddress(tx.to) : null,
    data: (tx.input ?? '0x') as Hex,
    value: (tx.value ?? '0x0') as Hex,
    gas: tx.gas as Hex,
  };
  const callObject: Record<string, string> = { from: call.from, data: call.data, value: call.value, gas: call.gas };
  if (call.to) callObject.to = call.to;

  // --- 2. what it actually executed against ---------------------------------------------------
  const execPrestate = await req<any>('debug_traceTransaction', [hash, { tracer: 'prestateTracer' }]);
  const execParsed = parsePrestate(execPrestate, { diffMode: false });
  await sleep(gap);
  let executedRevert: DecodedRevert = { kind: 'none' };
  try {
    const tree = await req<CallFrame>('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    const deepest = deepestError(tree);
    executedRevert = decodeRevert((deepest?.output ?? tree?.output) as Hex | undefined);
    if (executedRevert.kind === 'none' && (tree?.error || deepest?.error)) {
      executedRevert = { kind: 'empty', reason: deepest?.error ?? tree?.error };
    }
    if (deepest?.revertReason && !executedRevert.reason) executedRevert.reason = deepest.revertReason;
  } catch (e) {
    notes.push(`callTracer on the failed transaction failed (${errLine(e)}); the executed revert reason is unknown.`);
  }

  // --- 3. pinned bases and re-simulation ------------------------------------------------------
  const failedBlockHeader = await req<any>('eth_getBlockByNumber', [toHexQty(N), false]);
  const bases: Array<{ k: number; block: bigint; blockHash: Hex }> = [];
  for (const k of [1, 2, 3]) {
    const b = N - BigInt(k);
    if (b < 0n) break;
    const header = await req<any>('eth_getBlockByNumber', [toHexQty(b), false]);
    if (!header?.hash) {
      notes.push(`Block ${b} header unavailable; the N-${k} basis was skipped.`);
      continue;
    }
    bases.push({ k, block: b, blockHash: header.hash as Hex });
  }

  const resims: ResimDetail[] = [];
  for (const basis of bases) {
    const selector = { blockHash: basis.blockHash };
    let outcome: ResimOutcome = 'error';
    let revertData: Hex | undefined;
    let revertReason: string | undefined;
    let error: string | undefined;
    try {
      await req<Hex>('eth_call', [callObject, selector]);
      outcome = 'success';
    } catch (e) {
      const info = rpcErrorData(e);
      if (isFundsFailure(info.message)) {
        outcome = 'funds';
        error = info.message;
      } else if (info.code === 3 || REVERT_RE.test(info.message) || info.data) {
        outcome = 'revert';
        revertData = info.data;
        const dec = decodeRevert(info.data);
        revertReason = dec.reason ?? info.message;
      } else {
        outcome = 'error';
        error = info.message;
      }
    }
    let slots: SlotDependency[] = [];
    const wantPrestate = opts.prestateAtEveryK !== false || basis.k === 1;
    if (wantPrestate && outcome !== 'error') {
      await sleep(gap);
      try {
        const ps = await req<any>('debug_traceCall', [callObject, selector, { tracer: 'prestateTracer' }]);
        slots = parsePrestate(ps, { diffMode: false }).slots.map((s) => ({
          address: s.address,
          slot: s.slot,
          valueSeen: s.pre,
          readOnly: true, // non-diff prestate cannot tell reads from writes; see DependencySet.coverage
        }));
      } catch (e) {
        notes.push(`prestateTracer at N-${basis.k} failed (${errLine(e)}); that basis contributes no dependency set.`);
      }
    }
    resims.push({ ...basis, outcome, revertData, revertReason, error, slotCount: slots.length, slots });
    await sleep(gap);
  }
  resims.sort((a, b) => a.k - b.k);

  const verdict = classifyResims(resims);

  // --- 4. value timeline per slot --------------------------------------------------------------
  const timelines = new Map<string, SlotTimeline>();
  const put = (address: Hex, slot: Hex, basis: BasisName, value: Hex, fromDepSet: boolean) => {
    const k = slotKey(address, slot);
    let t = timelines.get(k);
    if (!t) {
      t = { address: normalizeAddress(address), slot: normalizeSlot(slot), values: {}, from: value, to: value, inDependencySetAt: [] };
      timelines.set(k, t);
    }
    if (t.values[basis] === undefined) t.values[basis] = normalizeSlot(value);
    if (fromDepSet && !t.inDependencySetAt.includes(basis)) t.inDependencySetAt.push(basis);
  };
  for (const s of execParsed.slots) put(s.address, s.slot, 'executed', s.pre, true);
  for (const r of resims) {
    const basis = `N-${r.k}` as BasisName;
    for (const s of r.slots) put(s.address, s.slot, basis, s.valueSeen, true);
  }

  // Fill gaps with eth_getStorageAt at the same pinned hashes (capped; the 'executed' basis is mid-block
  // and cannot be read this way, so it is left unknown when the trace did not report it).
  const maxReads = Math.max(0, opts.maxStorageReads ?? 64);
  let reads = 0;
  let readCapped = false;
  for (const t of [...timelines.values()].sort((a, b) => slotKey(a.address, a.slot).localeCompare(slotKey(b.address, b.slot)))) {
    for (const basis of bases) {
      const name = `N-${basis.k}` as BasisName;
      if (t.values[name] !== undefined) continue;
      if (reads >= maxReads) {
        readCapped = true;
        continue;
      }
      reads++;
      try {
        const v = await req<Hex>('eth_getStorageAt', [t.address, t.slot, { blockHash: basis.blockHash }]);
        if (typeof v === 'string') t.values[name] = normalizeSlot(v);
      } catch (e) {
        notes.push(`eth_getStorageAt(${t.address}, ${t.slot}) at N-${basis.k} failed (${errLine(e)}).`);
      }
    }
  }
  if (readCapped) notes.push(`Gap-filling reads hit the cap of ${maxReads}; some slots have an incomplete timeline and may be missing from the moved list.`);

  // Movements: adjacent known values differ AND the net value changed.
  let churnedBackSlots = 0;
  const movements: Movement[] = [];
  for (const t of timelines.values()) {
    const known = BASES.filter((b) => t.values[b] !== undefined);
    if (known.length < 2) continue;
    let changedBetween = '';
    for (let i = 1; i < known.length; i++) {
      const a = t.values[known[i - 1]!]!;
      const b = t.values[known[i]!]!;
      if (BigInt(a) !== BigInt(b)) changedBetween = `${known[i - 1]} -> ${known[i]}`;
    }
    if (!changedBetween) continue;
    const from = t.values[known[0]!]!;
    const to = t.values[known[known.length - 1]!]!;
    // A slot that moved and moved back (A -> B -> A) is NET unchanged, and Monad's conflict
    // check compares committed VALUES (docs/lineage/monad-execution-verification.md), so it
    // cannot be why this transaction failed. Reporting it would name an innocent writer.
    // This is the same value-based rule that retired Hotslot's ReentrancyGuard claim.
    if (BigInt(from) === BigInt(to)) {
      churnedBackSlots++;
      continue;
    }
    const label = opts.labeler?.label(slotKey(t.address, t.slot));
    movements.push({
      ...t,
      label: label && !/^unresolved@/.test(label) && !label.includes('…:0x') ? label : undefined,
      from,
      to,
      changedBetween,
      systemAccount: isSystemAccount(t.address),
      inDependencySetAt: BASES.filter((b) => t.inDependencySetAt.includes(b)),
    });
  }
  if (churnedBackSlots > 0) {
    notes.push(
      `${churnedBackSlots} slot(s) changed and changed back to their original value across the ` +
        `window; they are excluded because Monad compares committed values, so a net-unchanged ` +
        `slot cannot invalidate this transaction.`,
    );
  }
  const ranked = rankMovements(movements);
  movements.length = 0;
  movements.push(...ranked);

  // --- 5. writers ------------------------------------------------------------------------------
  let scan: WriterScanResult = { hits: [], unattributed: [], blocksScanned: [], blockTraces: 0, capped: movements.length > 0, errors: [], rejected: [] };
  if (movements.length > 0) {
    await sleep(gap);
    scan = await findSlotWriters(
      client,
      movements.map((m) => ({ address: m.address, slot: m.slot })),
      {
        failedBlock: N,
        failedTxIndex: txIndex,
        failedTxHash: hash,
        maxBlocks: opts.maxWriterBlocks ?? 4,
        labeler: opts.labeler,
        minIntervalMs: gap,
      },
    );
  }
  const hitByKey = new Map(scan.hits.map((h) => [slotKey(h.address, h.slot), h]));
  const movedSlots: Explanation['movedSlots'] = [];
  const attributed: AttributedMovement[] = [];
  const unattributedMovements: Movement[] = [];
  for (const m of movements) {
    const h = hitByKey.get(slotKey(m.address, m.slot));
    if (!h) {
      unattributedMovements.push(m);
      continue;
    }
    const label = m.label ?? h.label;
    attributed.push({ ...m, label, writerTx: h.writerTx, writerSender: h.writerSender, writerBlock: h.writerBlock, writerTxIndex: h.writerTxIndex, sameBlock: h.sameBlock });
    movedSlots.push({ address: m.address, slot: m.slot, label, from: m.from, to: m.to, writerTx: h.writerTx, writerSender: h.writerSender, writerBlock: h.writerBlock });
  }
  if (unattributedMovements.length > 0) {
    notes.push(
      `${unattributedMovements.length} moved slot(s) had no writer inside the scanned window (${scan.blocksScanned.length} block(s): ${scan.blocksScanned.map(String).join(', ') || 'none'}); they are listed in unattributedMovements, not claimed.`,
    );
  }
  const sysRows = movements.filter((m) => m.systemAccount).length;
  if (sysRows > 0) {
    notes.push(
      `${sysRows} moved slot(s) belong to Monad's system account ${MONAD_SYSTEM_ACCOUNTS[0]} (protocol staking/fee accounting, moves nearly every block); they are flagged systemAccount, ranked last and never quoted as the cause.`,
    );
  }
  if (!opts.labeler) notes.push('No storage layout was supplied, so slots are reported raw (labelling needs the contract source/layout).');
  for (const e of scan.errors) notes.push(`Writer scan on block ${e.block}: ${e.error}`);
  if (scan.rejected.length > 0) {
    notes.push(
      `${scan.rejected.length} attribution(s) were dropped because the named transaction's own ` +
        `trace did not confirm the write; those slots are reported as unattributed rather than ` +
        `blaming a transaction we cannot verify.`,
    );
  }

  if (movements.length === 0) {
    notes.push(
      `No dependency slot changed between the N-${bases.length ? bases[bases.length - 1]!.k : 1} basis and execution, so whatever broke this transaction moved before the scanned window.`,
    );
  }

  let rationale = verdict.rationale;
  if (verdict.avoidableClass === 'same-block') {
    const sb = rankMovements(attributed.filter((a) => a.sameBlock && !a.systemAccount));
    if (sb.length > 0) {
      const w = sb[0]!;
      rationale += ` Transaction ${w.writerTx} (sender ${w.writerSender}, index ${w.writerTxIndex} of block ${w.writerBlock}) wrote ${w.label ?? w.slot} on ${w.address} from ${w.from} to ${w.to} before this one ran.`;
    }
  }

  notes.sort();

  return {
    txHash: hash,
    failedBlock: N,
    movedSlots,
    avoidableAt: verdict.avoidableAt,
    burnedWei: burn.burnedWei,
    gasLimit: burn.gasLimit,
    chainId: Number(BigInt(tx.chainId ?? '0x0')) || client.chain?.id || 0,
    from: call.from,
    to: call.to,
    nonce: Number(BigInt(tx.nonce ?? '0x0')),
    txIndex,
    failedBlockHash: (failedBlockHeader?.hash ?? receipt.blockHash) as Hex,
    burn,
    burnEqualsLimitTimesPrice: burn.burnedWei === (gasLimit * effectiveGasPrice).toString(),
    executedRevert,
    avoidableClass: verdict.avoidableClass,
    avoidable: verdict.avoidable,
    rationale,
    undetectableWithoutPendingFeed: verdict.undetectableWithoutPendingFeed,
    resims,
    // Sorted and deduped: the node's prestateTracer has been observed returning the same
    // accessed slots in a different order (and occasionally a slightly different set) for the
    // same mined transaction, so ordering here is ours, not the node's.
    executedSlots: dedupeSlots(
      execParsed.slots.map((s) => ({ address: s.address, slot: s.slot, valueSeen: s.pre, readOnly: true })),
    ),
    coverage: 'full',
    attributedMovements: attributed,
    unattributedMovements,
    writerScan: {
      blocksScanned: scan.blocksScanned.map(String),
      blockTraces: scan.blockTraces,
      capped: scan.capped,
      errors: scan.errors,
      rejected: scan.rejected.map((r) => ({ ...r })),
    },
    notes,
  };
}

/** Deepest frame in a callTracer tree that carries an error, i.e. the frame that actually reverted. */
export function deepestError(frame: CallFrame | undefined): CallFrame | undefined {
  if (!frame) return undefined;
  let best: CallFrame | undefined = frame.error ? frame : undefined;
  for (const c of frame.calls ?? []) {
    const d = deepestError(c);
    if (d) best = d;
  }
  return best;
}

/** JSON-safe view of an explanation (bigint -> decimal string), for receipts, pages and snapshots. */
export function explanationToJson(e: FullExplanation): unknown {
  return JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** One-line summary for a CLI or the "Why your bot lost" page header. */
export function summarize(e: FullExplanation): string {
  const mon = (Number(BigInt(e.burnedWei) / 10n ** 12n) / 1e6).toFixed(6);
  const moved = e.movedSlots.length + e.unattributedMovements.length;
  return `${e.txHash} failed in block ${e.failedBlock}, burned ${mon} MON (gas limit ${e.gasLimit}); ${moved} dependency slot(s) moved; verdict ${e.avoidableClass} (${e.avoidableAt}).`;
}
