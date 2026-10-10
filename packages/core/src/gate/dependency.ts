// The Gate, step 2: capture what the simulated transaction actually depended on.
//
// Kill test K1 (docs/kill-tests/K1.md) settled how this has to be built:
//
//   "prestateTracer lists read-only slots -- PASS **only in non-diff mode**. diffMode:true omits them."
//
// So the dependency set comes from the NON-DIFF `prestateTracer` output (every touched account/slot with
// its pre value), and a second, diffMode trace of the same call tells us which of those slots the tx
// WRITES. readOnly = in the non-diff set, not in the diff write set. That is one extra trace, and it is
// the only honest way to get the read/write split: a diff trace alone cannot see a pure read.
//
// K1 also found that block overrides are rejected (`eth_call`) or silently ignored (`debug_traceCall`) on
// Monad, so `TimeDependence.confirmedByResim` is deliberately left undefined here. See the note on
// `timeDependenceFromCode` and docs/gate.md.
import { keccak256, type PublicClient } from 'viem';
import type {
  AccountDependency,
  DependencySet,
  Hex,
  SimulationResult,
  SlotDependency,
  TimeDependence,
  TxRequest,
} from '../types.js';
import {
  calleeAddresses,
  normalizeAddress,
  parsePrestate,
  slotKey,
  walkCallTree,
  type CallFrame,
  type RawPrestate,
} from '../trace/index.js';
import type { SlotLabeler } from '../label/index.js';
import {
  callObjectOf,
  createGateRpc,
  errorText,
  GateInfraError,
  isExecutionError,
  simulate,
  type GateRpc,
  type PinnedBlock,
  type SimulateOptions,
} from './simulate.js';

// ---------------------------------------------------------------- bytecode scan (time dependence)

export const TIMESTAMP_OPCODE = 0x42;
export const NUMBER_OPCODE = 0x43;

export interface CodeScan {
  timestamp: boolean;
  number: boolean;
  /** Bytes of code scanned (0 for an EOA). */
  size: number;
}

/**
 * Scan runtime bytecode for TIMESTAMP (0x42) / NUMBER (0x43) executed as opcodes, skipping PUSH1..PUSH32
 * immediates so that a 0x42 byte inside pushed data is not mistaken for the opcode.
 *
 * Heuristic, by design (PRD "Honest limits": time dependence is a heuristic). It over-reports: the trailing
 * solc metadata and any unreachable code are scanned too, and PUSH0 (0x5f) carries no immediate so the
 * walk stays aligned only for well-formed legacy bytecode. Monad exposes no struct logs, so the opcodes a
 * call really executed are invisible; this is a scan of what the code COULD do.
 */
export function scanBytecode(code: Hex | undefined): CodeScan {
  const out: CodeScan = { timestamp: false, number: false, size: 0 };
  if (!code || code.length <= 2) return out;
  const body = code.slice(2);
  out.size = body.length >> 1;
  for (let i = 0; i + 1 < body.length; ) {
    const op = parseInt(body.slice(i, i + 2), 16);
    if (Number.isNaN(op)) break;
    if (op === TIMESTAMP_OPCODE) out.timestamp = true;
    else if (op === NUMBER_OPCODE) out.number = true;
    if (op >= 0x60 && op <= 0x7f) i += 2 + (op - 0x5f) * 2; // PUSH1..PUSH32 immediate
    else i += 2;
    if (out.timestamp && out.number) break;
  }
  return out;
}

/** Pure part of the time-dependence check: scan the code of every address in the call tree. */
export function timeDependenceFromCode(codes: Array<{ address: Hex; code: Hex | undefined }>): TimeDependence {
  const contracts: Hex[] = [];
  let timestamp = false;
  let num = false;
  for (const { address, code } of codes) {
    const s = scanBytecode(code);
    if (s.timestamp || s.number) {
      contracts.push(normalizeAddress(address));
      timestamp = timestamp || s.timestamp;
      num = num || s.number;
    }
  }
  const opcodes: TimeDependence['opcodes'] = [];
  if (timestamp) opcodes.push('TIMESTAMP');
  if (num) opcodes.push('NUMBER');
  // confirmedByResim stays undefined: confirming the flag needs the same call re-run with the block shifted
  // +1, and K1 proved Monad's RPC rejects `eth_call` block overrides (-32602) and silently ignores
  // `debug_traceCall` blockOverrides. That differential needs a local fork, which the Gate does not run.
  return { flagged: contracts.length > 0, contracts: contracts.sort(), opcodes };
}

// ---------------------------------------------------------------- dependency set

export interface BuildDependencySetOptions extends SimulateOptions {
  /** Reuse the simulation the Gate already ran (avoids a second eth_call/estimateGas pair). */
  simulation?: SimulationResult;
  /** Optional solc-layout labeller; its labels are attached to matching slots. */
  labeller?: SlotLabeler;
  /** Skip the callTracer + eth_getCode scan (time.flagged then reports false with no contracts). */
  skipTimeDependence?: boolean;
}

async function tracePrestate(
  rpc: GateRpc,
  tx: TxRequest,
  blockHash: Hex,
  diffMode: boolean,
): Promise<RawPrestate> {
  const cfg = diffMode
    ? { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }
    : { tracer: 'prestateTracer' };
  const r = await rpc.request<Record<string, unknown>>('debug_traceCall', [callObjectOf(tx), { blockHash }, cfg]);
  if (!r || typeof r !== 'object') throw new GateInfraError('debug_traceCall returned an empty prestate', []);
  return (diffMode ? { pre: (r as any).pre ?? {}, post: (r as any).post ?? {} } : r) as RawPrestate;
}

/**
 * Build the dependency set for `tx` as of `pinnedBlock` (addressed by hash throughout, so every trace and
 * every balance read sees one state).
 *
 * Coverage:
 *  - 'full'         - the non-diff prestate trace succeeded, so read-only slots are included.
 *  - 'written-only' - the non-diff trace was refused by the endpoint and only the diffMode trace survived,
 *                     so this lists the slots the tx writes and nothing it merely read (K1 fallback).
 */
export async function buildDependencySet(
  client: PublicClient,
  tx: TxRequest,
  pinnedBlock: PinnedBlock,
  opts: BuildDependencySetOptions = {},
): Promise<DependencySet> {
  const rpc = opts.rpc ?? createGateRpc(client, opts);
  const at = pinnedBlock.hash;
  const simulation = opts.simulation ?? (await simulate(client, tx, at, { ...opts, rpc, pinnedBlock }));

  // (1) non-diff: the full read set, including slots the tx only read (K1).
  let full: RawPrestate | undefined;
  let fullError: string | undefined;
  try {
    full = await tracePrestate(rpc, tx, at, false);
  } catch (e) {
    if (isExecutionError(e)) throw e;
    fullError = errorText(e).split(' | ')[0];
  }

  // (2) diffMode: which of those slots the tx actually changes.
  let diff: RawPrestate | undefined;
  try {
    diff = await tracePrestate(rpc, tx, at, true);
  } catch (e) {
    if (isExecutionError(e)) throw e;
    if (!full) {
      throw new GateInfraError(
        `neither prestate trace succeeded (non-diff: ${fullError ?? 'n/a'}; diff: ${errorText(e).split(' | ')[0]})`,
        [],
      );
    }
  }
  if (!full && !diff) throw new GateInfraError(`prestate tracing unavailable: ${fullError ?? 'unknown'}`, []);

  const parsedFull = full ? parsePrestate(full, { diffMode: false }) : undefined;
  const parsedDiff = diff ? parsePrestate(diff, { diffMode: true }) : undefined;
  const coverage: DependencySet['coverage'] = parsedFull ? 'full' : 'written-only';

  const written = new Set<string>();
  for (const s of parsedDiff?.slots ?? []) if (s.written) written.add(slotKey(s.address, s.slot));

  // Slots: the non-diff read set is the base. Union in anything diffMode reported that non-diff missed
  // (never observed on Monad, but a missing slot would be a silent hole in a receipt).
  const byKey = new Map<string, SlotDependency>();
  for (const s of parsedFull?.slots ?? []) {
    const key = slotKey(s.address, s.slot);
    byKey.set(key, { address: s.address, slot: s.slot, valueSeen: s.pre, readOnly: !written.has(key) });
  }
  for (const s of parsedDiff?.slots ?? []) {
    const key = slotKey(s.address, s.slot);
    if (!byKey.has(key)) {
      byKey.set(key, { address: s.address, slot: s.slot, valueSeen: s.pre, readOnly: !s.written });
    }
  }
  const slots = [...byKey.values()].sort((a, b) =>
    a.address === b.address ? (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0) : a.address < b.address ? -1 : 1,
  );
  if (opts.labeller) {
    for (const s of slots) {
      const l = opts.labeller.label(slotKey(s.address, s.slot));
      if (l && !l.startsWith('unresolved@')) s.label = l;
    }
  }

  // Accounts: the sender's balance and nonce read straight from the pinned block (authoritative), plus
  // every other account the trace touched, with the values the tracer reported.
  const sender = normalizeAddress(tx.from);
  const [balHex, nonceHex] = await Promise.all([
    rpc.request<Hex>('eth_getBalance', [sender, { blockHash: at }]),
    rpc.request<Hex>('eth_getTransactionCount', [sender, { blockHash: at }]),
  ]);
  const accounts: AccountDependency[] = [
    { address: sender, balance: BigInt(balHex), nonce: Number(BigInt(nonceHex)) },
  ];
  for (const a of parsedFull?.accounts ?? parsedDiff?.accounts ?? []) {
    if (a.address === sender || !a.pre) continue;
    const entry: AccountDependency = {
      address: a.address,
      balance: a.pre.balance ?? 0n,
      nonce: a.pre.nonce ?? 0,
    };
    if (a.pre.code && a.pre.code !== '0x') entry.codeHash = keccak256(a.pre.code);
    accounts.push(entry);
  }

  // Time/block dependence: callTracer tree -> every callee's code -> opcode scan.
  let time: TimeDependence = { flagged: false, contracts: [], opcodes: [] };
  if (!opts.skipTimeDependence) {
    try {
      const tree = await rpc.request<CallFrame>('debug_traceCall', [callObjectOf(tx), { blockHash: at }, { tracer: 'callTracer' }]);
      // walkCallTree is used for the CREATE case: a created contract has no `to`, so its code is not
      // fetchable from the pinned block and is reported via the frame itself.
      const created = new Set<string>();
      for (const { frame } of walkCallTree(tree)) {
        if (/^CREATE/i.test(frame.type) && frame.to) created.add(normalizeAddress(frame.to));
      }
      const addrs = calleeAddresses(tree);
      const codes = await Promise.all(
        addrs.map(async (address) => ({
          address,
          code: created.has(address)
            ? undefined // not yet deployed at the pinned block; nothing to scan
            : await rpc.request<Hex>('eth_getCode', [address, { blockHash: at }]),
        })),
      );
      time = timeDependenceFromCode(codes);
    } catch (e) {
      if (isExecutionError(e)) throw e;
      // Leave `flagged: false` with no contracts rather than guess; the caller sees coverage/time as-is.
      time = { flagged: false, contracts: [], opcodes: [] };
    }
  }

  return { simulation, slots, accounts, time, coverage };
}
