// Burn accounting and the avoidable-at-N-k verdict for a mined, failed Monad transaction.
//
// Everything here is either (a) arithmetic over real receipt fields or (b) a decision table over
// re-simulation outcomes that `failed-tx.ts` collected from real RPC calls. No value is invented:
// if an input is missing the verdict degrades to 'unknown' rather than guessing.
//
// PRD rule honoured here: reserve-balance / insufficient-funds failures are NOT counted as avoidable.

import type { PublicClient } from 'viem';
import type { Explanation, Hex } from '../types.js';

// ---------------------------------------------------------------- burn

export interface BurnFacts {
  /** tx.gas, the gas LIMIT (decimal string). */
  gasLimit: string;
  /** receipt.effectiveGasPrice (decimal string wei). */
  effectiveGasPriceWei: string;
  /** receipt.gasUsed (decimal string). On Monad this is set to the limit at the top call level. */
  receiptGasUsed: string;
  /** What the sender paid: gasLimit x effectiveGasPrice (decimal string wei). */
  burnedWei: string;
  /** receipt.gasUsed == tx.gas, i.e. the receipt agrees that the whole limit was charged. */
  receiptGasUsedEqualsLimit: boolean;
}

/** gasLimit x effectiveGasPrice, with the receipt cross-check. Pure arithmetic over real receipt fields. */
export function burnFacts(args: { gasLimit: bigint; effectiveGasPrice: bigint; receiptGasUsed: bigint }): BurnFacts {
  const { gasLimit, effectiveGasPrice, receiptGasUsed } = args;
  if (gasLimit < 0n || effectiveGasPrice < 0n || receiptGasUsed < 0n) throw new Error('burnFacts: negative input');
  return {
    gasLimit: gasLimit.toString(),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    receiptGasUsed: receiptGasUsed.toString(),
    burnedWei: (gasLimit * effectiveGasPrice).toString(),
    receiptGasUsedEqualsLimit: receiptGasUsed === gasLimit,
  };
}

// ---------------------------------------------------------------- revert decoding

export type RevertKind = 'error-string' | 'panic' | 'custom-error' | 'empty' | 'none';

export interface DecodedRevert {
  kind: RevertKind;
  /** Human text; undefined when there was no revert data at all. */
  reason?: string;
  /** 4-byte selector of the custom error / builtin, when data is at least 4 bytes. */
  selector?: Hex;
  data?: Hex;
}

/** Solidity Panic(uint256) codes, from the Solidity docs. */
export const PANIC_CODES: Record<string, string> = {
  '0x00': 'generic compiler panic',
  '0x01': 'assert(false)',
  '0x11': 'arithmetic overflow/underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'invalid storage byte array encoding',
  '0x31': 'pop() on empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'out of memory / too much memory allocated',
  '0x51': 'call to a zero-initialised internal function',
};

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Decode revert data (Error(string) / Panic(uint256) / custom error) without needing an ABI. */
export function decodeRevert(data?: Hex | null): DecodedRevert {
  if (data === undefined || data === null) return { kind: 'none' };
  const hex = data.toLowerCase();
  if (hex === '0x' || hex === '') return { kind: 'empty', reason: 'reverted without data', data: '0x' };
  if (!/^0x([0-9a-f]{2})+$/.test(hex)) return { kind: 'empty', reason: 'reverted with unparsable data', data: hex as Hex };
  const selector = hex.slice(0, 10) as Hex;
  const body = hex.slice(10);
  if (selector === ERROR_STRING_SELECTOR && body.length >= 128) {
    try {
      const len = Number(BigInt('0x' + body.slice(64, 128)));
      const bytes = body.slice(128, 128 + len * 2);
      if (bytes.length === len * 2) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
        return { kind: 'error-string', reason: s, selector, data: hex as Hex };
      }
    } catch {
      /* fall through to custom-error */
    }
  }
  if (selector === PANIC_SELECTOR && body.length >= 64) {
    const code = BigInt('0x' + body.slice(0, 64));
    const key = `0x${code.toString(16).padStart(2, '0')}`;
    return { kind: 'panic', reason: `Panic(${key})${PANIC_CODES[key] ? `: ${PANIC_CODES[key]}` : ''}`, selector, data: hex as Hex };
  }
  return { kind: 'custom-error', reason: `custom error ${selector}`, selector, data: hex as Hex };
}

// ---------------------------------------------------------------- funds / reserve balance

/**
 * Node-level "the sender cannot pay" failures, which the PRD excludes from "avoidable":
 * insufficient funds for gas x limit + value, and Monad's reserve-balance rule.
 *
 * Deliberately narrow: a contract reverting with "transfer amount exceeds balance" is a real dependency
 * move (someone drained a token balance) and stays eligible for an avoidable verdict.
 */
export const FUNDS_ERROR_RE = /insufficient funds|insufficient balance for transfer|reserve balance|cannot afford|balance too low/i;

export function isFundsFailure(text: string | undefined | null): boolean {
  return !!text && FUNDS_ERROR_RE.test(text);
}

// ---------------------------------------------------------------- re-simulation outcomes

/** Outcome of re-running the exact same call against the END state of block N-k. */
export type ResimOutcome =
  | 'success' // the call returned normally: at that basis the tx was still fine
  | 'revert' // it already reverted there
  | 'funds' // the node refused it for funds / reserve balance (not a dependency race)
  | 'error'; // RPC/infra error or pruned state: no information

export interface ResimAtK {
  /** 1, 2 or 3: basis is the end state of block N-k. */
  k: number;
  block: bigint;
  /** Block hash the basis was pinned to (EIP-1898), so the result is reproducible. */
  blockHash: Hex;
  outcome: ResimOutcome;
  revertData?: Hex;
  revertReason?: string;
  /** Number of storage slots the re-simulated call touched at this basis (non-diff prestateTracer). */
  slotCount?: number;
  /** Set when outcome is 'error' or 'funds'. */
  error?: string;
}

/** Class of the failure, per the PRD's replay taxonomy. */
export type AvoidableClass =
  | 'knowable' // already reverted at N-3: any pre-send simulation would have caught it
  | 'latency-sensitive' // only reverted at N-1 (or N-2): catchable, but only by simulating right before sending
  | 'same-block' // still succeeded at N-1, so only an earlier tx in its own block N could have broken it
  | 'unavoidable' // funds / reserve balance, or a cause we can prove is not a dependency race
  | 'unknown'; // re-simulation gave no usable answer

export interface AvoidableVerdict {
  avoidableClass: AvoidableClass;
  /** The Explanation enum value (shared types.ts). */
  avoidableAt: Explanation['avoidableAt'];
  /** True only for 'knowable' and 'latency-sensitive'. same-block and unavoidable are NOT avoidable. */
  avoidable: boolean;
  /** Plain-language reason, built only from the outcomes we actually observed. */
  rationale: string;
  /** True for same-block: no pending-tx feed exists on Monad, so this was not observable before sending. */
  undetectableWithoutPendingFeed: boolean;
}

const at = (sims: ResimAtK[], k: number) => sims.find((s) => s.k === k);

/**
 * Decision table over the N-1 / N-2 / N-3 re-simulations.
 *
 *   N-1 success                  -> same-block   (only an earlier tx in block N can explain it)
 *   N-1 funds-refused            -> unavoidable  (PRD: reserve-balance reverts are not "avoidable")
 *   N-1 revert & N-3 revert      -> knowable     (avoidableAt N-3)
 *   N-1 revert & N-2 revert      -> latency-sensitive (avoidableAt N-2)
 *   N-1 revert only              -> latency-sensitive (avoidableAt N-1)
 *   N-1 error                    -> unknown
 */
export function classifyResims(sims: ResimAtK[]): AvoidableVerdict {
  const r1 = at(sims, 1);
  const r2 = at(sims, 2);
  const r3 = at(sims, 3);
  const no = { avoidable: false, undetectableWithoutPendingFeed: false };

  if (!r1 || r1.outcome === 'error') {
    return {
      ...no,
      avoidableClass: 'unknown',
      avoidableAt: 'unknown',
      rationale: `Re-simulation at N-1 gave no usable result${r1?.error ? ` (${r1.error})` : ''}, so avoidability is unknown.`,
    };
  }
  if (r1.outcome === 'funds') {
    return {
      ...no,
      avoidableClass: 'unavoidable',
      avoidableAt: 'unavoidable',
      rationale: `The node refused the re-simulation at N-1 for funds / reserve balance (${r1.error ?? 'insufficient funds'}). Per the PRD this is not counted as avoidable.`,
    };
  }
  if (r1.outcome === 'success') {
    return {
      avoidable: false,
      undetectableWithoutPendingFeed: true,
      avoidableClass: 'same-block',
      avoidableAt: 'same-block',
      rationale:
        'The same call still succeeded against the end state of block N-1, so the state it needed was broken by an earlier transaction inside its own block. Monad has no pending-transaction feed, so this was not detectable before sending.',
    };
  }
  // r1.outcome === 'revert'
  if (isFundsFailure(r1.revertReason) || isFundsFailure(r1.error)) {
    return {
      ...no,
      avoidableClass: 'unavoidable',
      avoidableAt: 'unavoidable',
      rationale: `It already failed at N-1, but for funds / reserve balance (${r1.revertReason ?? r1.error}). Per the PRD this is not counted as avoidable.`,
    };
  }
  const why = (r: ResimAtK) => `${r.revertReason ?? 'reverted without a decodable reason'}`;
  if (r3?.outcome === 'revert') {
    return {
      avoidable: true,
      undetectableWithoutPendingFeed: false,
      avoidableClass: 'knowable',
      avoidableAt: 'N-3',
      rationale: `The same call already reverted against the end state of block N-3 (${why(r3)}), three blocks before it was executed: any simulation before sending would have caught it.`,
    };
  }
  if (r2?.outcome === 'revert') {
    return {
      avoidable: true,
      undetectableWithoutPendingFeed: false,
      avoidableClass: 'latency-sensitive',
      avoidableAt: 'N-2',
      rationale: `It succeeded at N-3 but already reverted at N-2 (${why(r2)}): knowable about two blocks (~0.6 s) before execution, so only a simulation shortly before sending would have caught it.`,
    };
  }
  const tail = r2 ? (r2.outcome === 'success' ? 'it still succeeded at N-2' : `the N-2 basis gave no usable result (${r2.error ?? r2.outcome})`) : 'the N-2 basis was not simulated';
  return {
    avoidable: true,
    undetectableWithoutPendingFeed: false,
    avoidableClass: 'latency-sensitive',
    avoidableAt: 'N-1',
    rationale: `It already reverted against the end state of block N-1 (${why(r1)}) while ${tail}: catchable only by simulating immediately before sending.`,
  };
}

// ---------------------------------------------------------------- batch

/** Distribution of classes / avoidableAt values over a set of explanations. */
export function verdictDistribution(
  list: Array<{ avoidableClass?: AvoidableClass; avoidableAt: Explanation['avoidableAt'] }>,
): { total: number; byClass: Record<string, number>; byAvoidableAt: Record<string, number> } {
  const byClass: Record<string, number> = {};
  const byAvoidableAt: Record<string, number> = {};
  for (const e of list) {
    const c = e.avoidableClass ?? 'unknown';
    byClass[c] = (byClass[c] ?? 0) + 1;
    byAvoidableAt[e.avoidableAt] = (byAvoidableAt[e.avoidableAt] ?? 0) + 1;
  }
  return { total: list.length, byClass, byAvoidableAt };
}

/** Sum of burnedWei over explanations, as a decimal string. */
export function totalBurnedWei(list: Array<{ burnedWei: string }>): string {
  return list.reduce((a, e) => a + BigInt(e.burnedWei), 0n).toString();
}

export interface ClassifyBatchOptions {
  /** Parallel explanations in flight (default 2). Each explanation is ~10-16 RPC calls, so keep this low. */
  concurrency?: number;
  /** Minimum gap between starting two explanations, ms (default 150) to stay under ~10 rps on public archives. */
  minIntervalMs?: number;
  /** Writer-scan block cap, forwarded to explainFailedTx (default 4). */
  maxWriterBlocks?: number;
  /** Re-simulate the dependency set at every k (default true) or only at N-1 (cheaper). */
  prestateAtEveryK?: boolean;
  onResult?: (r: BatchItem, index: number) => void;
}

export interface BatchItem {
  txHash: Hex;
  ok: boolean;
  /** Present when ok. Typed loosely to avoid a module cycle; it is a FullExplanation. */
  explanation?: Explanation & { avoidableClass?: AvoidableClass };
  error?: string;
}

export interface BatchResult {
  items: BatchItem[];
  distribution: ReturnType<typeof verdictDistribution>;
  /** Total burn over the explanations that succeeded, decimal wei. */
  burnedWei: string;
  failures: number;
}

/**
 * Explain many failed transactions with a concurrency cap. Order of `items` follows `hashes`.
 * A per-hash failure is captured as `{ok:false, error}` and never aborts the batch.
 */
export async function classifyBatch(client: PublicClient, hashes: Hex[], opts: ClassifyBatchOptions = {}): Promise<BatchResult> {
  // Imported lazily: failed-tx.ts uses this module's pure helpers, so a static import would be a cycle.
  const { explainFailedTx } = await import('./failed-tx.js');
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const gap = Math.max(0, opts.minIntervalMs ?? 150);
  const items: BatchItem[] = new Array(hashes.length);
  let next = 0;
  let lastStart = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= hashes.length) return;
      const wait = lastStart + gap - Date.now();
      lastStart = Date.now() + Math.max(0, wait);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const txHash = hashes[i]!;
      let item: BatchItem;
      try {
        const explanation = await explainFailedTx(client, txHash, {
          maxWriterBlocks: opts.maxWriterBlocks,
          prestateAtEveryK: opts.prestateAtEveryK,
        });
        item = { txHash, ok: true, explanation };
      } catch (e) {
        item = { txHash, ok: false, error: (e as Error).message.split('\n')[0] };
      }
      items[i] = item;
      opts.onResult?.(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hashes.length) }, worker));

  const good = items.filter((i) => i.ok && i.explanation).map((i) => i.explanation!);
  return {
    items,
    distribution: verdictDistribution(good),
    burnedWei: totalBurnedWei(good),
    failures: items.filter((i) => !i.ok).length,
  };
}
