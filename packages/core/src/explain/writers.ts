// "Who moved my slot": attribute a storage-slot movement to the transaction that last wrote it.
//
// Method (all from real RPC output, nothing inferred):
//   debug_traceBlockByNumber with prestateTracer + diffMode:true returns one {txHash, result:{pre,post}}
//   entry per transaction, in block order. diffMode lists exactly the slots each tx CHANGED, with both
//   values (kill test K1), at ~0.22-0.35 MB and 0.13-2.7 s per mainnet block.
//
// Search order is "nearest write backwards in time":
//   block N, only the transactions ordered BEFORE the failed one -> block N-1 -> N-2 -> ... until every
//   slot is attributed or `maxBlocks` blocks have been traced. The LAST write before the failed tx wins.
//
// Cost: exactly one debug_traceBlockByNumber per candidate block, independent of how many slots are
// queried (one pass builds the whole block's write map), plus one eth_getTransactionByHash per distinct
// writer to recover its sender. Default cap: 4 blocks => <= 4 block traces (~1.4 MB) per explanation.

import type { PublicClient } from 'viem';
import type { Hex } from '../types.js';
import { normalizeAddress, normalizeSlot, parsePrestate, slotKey, toHexQty, withBackoff, type PrestateDiff } from '../trace/index.js';

/** Minimal shape of core's SlotLabeler, so a caller can pass one without a compiled project. */
export interface SlotLabelerLike {
  label(key: string): string;
}

export interface SlotRef {
  address: Hex;
  slot: Hex;
}

export interface WriterHit {
  address: Hex;
  slot: Hex;
  /** Label from the supplied labeller, when one resolved it; otherwise undefined (raw slot is kept). */
  label?: string;
  writerTx: Hex;
  writerSender: Hex;
  writerBlock: bigint;
  /** Position of the writer in its block (index into the block's transaction list). */
  writerTxIndex: number;
  /** Values the writer itself changed the slot between (diffMode pre -> post). */
  from: Hex;
  to: Hex;
  /** true when the writer is an earlier transaction inside the failed transaction's own block. */
  sameBlock: boolean;
}

export interface WriterScanOptions {
  /** Block containing the failed transaction (N). */
  failedBlock: bigint;
  /** Index of the failed transaction inside block N; only earlier transactions count as writers. */
  failedTxIndex: number;
  /** Hash of the failed tx, used to locate its own entry in the block trace (more robust than the index). */
  failedTxHash?: Hex;
  /** How many blocks to trace at most, counting N itself (default 4 => N, N-1, N-2, N-3). */
  maxBlocks?: number;
  /** Optional slot labeller (needs the contract's solc layout; mainnet contracts usually have none). */
  labeler?: SlotLabelerLike;
  /** Milliseconds to wait between block traces (default 120 => under ~8 rps). */
  minIntervalMs?: number;
  /**
   * Confirm each attribution against the writer's OWN diffMode trace before reporting it
   * (default true, one extra trace per attributed slot).
   *
   * This is not redundant. A block-level diff has been observed attributing a slot write to a
   * transaction whose own transaction-level diff does not show that write, and naming an
   * innocent transaction as the cause is the worst output this tool could produce. A hit that
   * fails confirmation is demoted to `unattributed` rather than reported.
   */
  verifyWriters?: boolean;
}

export interface WriterScanResult {
  hits: WriterHit[];
  /** Slots that no traced block attributed. */
  unattributed: SlotRef[];
  /** Blocks actually traced, highest first. */
  blocksScanned: bigint[];
  /** debug_traceBlockByNumber calls made. */
  blockTraces: number;
  /** True when the cap was reached while slots were still unattributed. */
  capped: boolean;
  errors: Array<{ block: string; error: string }>;
  /** Attributions dropped because the writer's own trace did not confirm the write. */
  rejected: Array<{ address: Hex; slot: Hex; writerTx: Hex; reason: string }>;
}

type Raw = (a: { method: string; params?: unknown[] }) => Promise<any>;

const key = (address: string, slot: string) => slotKey(address, slot);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BlockWrite {
  txHash: Hex;
  txIndex: number;
  from: Hex;
  to: Hex;
}

/** One entry of debug_traceBlockByNumber with prestateTracer+diffMode. */
interface BlockTraceEntry {
  txHash?: Hex;
  result?: PrestateDiff;
}

/**
 * Trace one block in diffMode and return, per slot key, the LAST write at a transaction index below
 * `beforeIndex` (Infinity = whole block). Pure over the trace output.
 */
export function lastWritesInBlock(entries: BlockTraceEntry[], beforeIndex = Number.POSITIVE_INFINITY): Map<string, BlockWrite> {
  const out = new Map<string, BlockWrite>();
  entries.forEach((entry, txIndex) => {
    if (txIndex >= beforeIndex) return;
    const raw = entry?.result;
    if (!raw || typeof raw !== 'object') return;
    const parsed = parsePrestate({ pre: raw.pre ?? {}, post: raw.post ?? {} }, { diffMode: true });
    for (const s of parsed.slots) {
      if (!s.written) continue;
      out.set(key(s.address, s.slot), {
        txHash: (entry.txHash ?? '0x') as Hex,
        txIndex,
        from: s.pre,
        to: s.post ?? (`0x${'0'.repeat(64)}` as Hex),
      });
    }
  });
  return out;
}

async function traceBlockDiff(client: PublicClient, block: bigint): Promise<BlockTraceEntry[]> {
  const raw = client.request as unknown as Raw;
  const r = await withBackoff(() =>
    raw({
      method: 'debug_traceBlockByNumber',
      params: [toHexQty(block), { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }],
    }),
  );
  if (!Array.isArray(r)) throw new Error('debug_traceBlockByNumber did not return an array');
  return r as BlockTraceEntry[];
}

/** Does this transaction's own diffMode trace show it writing (address, slot)? */
async function writerConfirms(
  client: PublicClient,
  txHash: Hex,
  address: Hex,
  slot: Hex,
): Promise<boolean | undefined> {
  const raw = client.request as unknown as Raw;
  try {
    const t = await withBackoff(() =>
      raw({
        method: 'debug_traceTransaction',
        params: [txHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }],
      }),
    );
    const post = (t?.post ?? {}) as Record<string, { storage?: Record<string, string> }>;
    const want = BigInt(slot);
    for (const [addr, acc] of Object.entries(post)) {
      if (normalizeAddress(addr) !== address) continue;
      for (const k of Object.keys(acc?.storage ?? {})) if (BigInt(k) === want) return true;
    }
    return false;
  } catch {
    // Could not check: do not reject on our own failure to verify.
    return undefined;
  }
}

/**
 * Find the transaction that last wrote each of `slots` before the failed transaction executed.
 * Bounded: at most `maxBlocks` block traces regardless of the number of slots.
 */
export async function findSlotWriters(client: PublicClient, slots: SlotRef[], opts: WriterScanOptions): Promise<WriterScanResult> {
  const maxBlocks = Math.max(1, opts.maxBlocks ?? 4);
  const gap = Math.max(0, opts.minIntervalMs ?? 120);
  const pending = new Map<string, SlotRef>();
  for (const s of slots) pending.set(key(s.address, s.slot), { address: normalizeAddress(s.address), slot: normalizeSlot(s.slot) });

  const hits: WriterHit[] = [];
  const blocksScanned: bigint[] = [];
  const errors: Array<{ block: string; error: string }> = [];
  const rejected: WriterScanResult['rejected'] = [];
  const senders = new Map<Hex, Hex>();
  const raw = client.request as unknown as Raw;
  let blockTraces = 0;

  const senderOf = async (txHash: Hex): Promise<Hex> => {
    const cached = senders.get(txHash);
    if (cached) return cached;
    const tx = await withBackoff(() => raw({ method: 'eth_getTransactionByHash', params: [txHash] }));
    const from = normalizeAddress(tx?.from ?? '0x0000000000000000000000000000000000000000');
    senders.set(txHash, from);
    return from;
  };

  for (let i = 0; i < maxBlocks && pending.size > 0; i++) {
    const block = opts.failedBlock - BigInt(i);
    if (block < 0n) break;
    if (i > 0 && gap) await sleep(gap);
    let entries: BlockTraceEntry[];
    try {
      entries = await traceBlockDiff(client, block);
      blockTraces++;
    } catch (e) {
      errors.push({ block: block.toString(), error: (e as Error).message.split('\n')[0] });
      continue;
    }
    blocksScanned.push(block);

    let before = Number.POSITIVE_INFINITY;
    if (i === 0) {
      // Only transactions ordered before the failed one can have broken it.
      const own = opts.failedTxHash ? entries.findIndex((e) => e.txHash?.toLowerCase() === opts.failedTxHash!.toLowerCase()) : -1;
      before = own >= 0 ? own : opts.failedTxIndex;
    }
    const writes = lastWritesInBlock(entries, before);
    for (const [k, ref] of [...pending.entries()]) {
      const w = writes.get(k);
      if (!w) continue;
      const writerTx = w.txHash;
      if (!/^0x[0-9a-fA-F]{64}$/.test(writerTx)) {
        // No tx hash in the trace entry: we will not guess which transaction it was.
        errors.push({ block: block.toString(), error: `trace entry ${w.txIndex} has no txHash; slot ${k} left unattributed` });
        continue;
      }
      const confirmed =
        opts.verifyWriters === false
          ? undefined
          : await writerConfirms(client, writerTx.toLowerCase() as Hex, ref.address, ref.slot);
      if (confirmed === false) {
        rejected.push({
          address: ref.address,
          slot: ref.slot,
          writerTx: writerTx.toLowerCase() as Hex,
          reason: "the block-level diff attributed this write, but the writer's own trace does not show it",
        });
        pending.delete(k);
        continue;
      }
      if (gap) await sleep(gap);

      const label = opts.labeler?.label(k);
      hits.push({
        address: ref.address,
        slot: ref.slot,
        label: label && !/^unresolved@|^0x[0-9a-f]{4}…/.test(label) ? label : undefined,
        writerTx: writerTx.toLowerCase() as Hex,
        writerSender: await senderOf(writerTx.toLowerCase() as Hex),
        writerBlock: block,
        writerTxIndex: w.txIndex,
        from: w.from,
        to: w.to,
        sameBlock: i === 0,
      });
      pending.delete(k);
    }
  }

  hits.sort((a, b) => (a.address === b.address ? a.slot.localeCompare(b.slot) : a.address.localeCompare(b.address)));
  const unattributed = [...pending.values()].sort((a, b) => (a.address === b.address ? a.slot.localeCompare(b.slot) : a.address.localeCompare(b.address)));
  return {
    hits,
    unattributed,
    blocksScanned,
    blockTraces,
    capped: pending.size > 0,
    errors,
    rejected,
  };
}
