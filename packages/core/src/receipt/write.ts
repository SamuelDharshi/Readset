// Building and writing dependency receipts: one record per send attempt, allowed or blocked.

import type { ChainId, DependencySet, DoomedTx, Hex, Policy, Receipt, Verdict } from '../types.js';
import { DEFAULT_POLICY } from '../breaker/policy.js';
import { assertNoSecrets, policyHash, receiptId } from './hash.js';
import { ReceiptStore, type ReceiptStoreOptions } from './store.js';

export type Decimalish = bigint | number | string;

function dec(v: Decimalish, field: string): string {
  if (typeof v === 'bigint') return v.toString(10);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`${field} must be an integer, got ${v}`);
    return BigInt(v).toString(10);
  }
  const s = v.trim();
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) throw new Error(`${field} must be a decimal or 0x integer, got "${v}"`);
  return BigInt(s).toString(10);
}

const lower = <T extends string>(v: T): T => v.toLowerCase() as T;

export interface AttemptInput {
  chainId: ChainId;
  tx: {
    from: Hex;
    to: Hex | null;
    data?: Hex;
    value?: Decimalish;
    /** Gas LIMIT the gate chose. On Monad this is what gets charged. */
    gasLimitChosen?: Decimalish;
  };
  verdict: Verdict;
  doomed?: DoomedTx;
  dependencySet?: DependencySet;
  /** Policy in force; its hash is stored. Pass `policyHash` instead if the hash is already known. */
  policy?: Policy;
  policyHash?: string;
  /** Hash of the broadcast tx, when it is already known. Otherwise amend later. */
  txHash?: Hex;
  /** Override the clock (tests, replays). */
  createdAt?: Date | string;
}

export interface OutcomeInput {
  status: 'success' | 'reverted';
  gasUsed: Decimalish;
  /** What the sender actually paid: on Monad gasLimit x effectiveGasPrice (docs/facts.md #1a, #10). */
  feePaidWei: Decimalish;
  blockNumber: Decimalish;
}

/** Monad charges the gas limit, not gas used, so the fee for any mined tx is limit x price. */
export function monadFeePaidWei(gasLimit: Decimalish, effectiveGasPrice: Decimalish): string {
  return (BigInt(dec(gasLimit, 'gasLimit')) * BigInt(dec(effectiveGasPrice, 'effectiveGasPrice'))).toString(10);
}

/** Pure: the receipt a given attempt produces, including its deterministic id. Writes nothing. */
export function buildReceipt(input: AttemptInput): Receipt {
  if (input.policy !== undefined && input.policyHash !== undefined && policyHash(input.policy) !== input.policyHash) {
    throw new Error('policy and policyHash disagree');
  }
  const createdAt =
    input.createdAt === undefined
      ? new Date().toISOString()
      : typeof input.createdAt === 'string'
        ? new Date(input.createdAt).toISOString()
        : input.createdAt.toISOString();
  if (createdAt === 'Invalid Date' || Number.isNaN(new Date(createdAt).getTime())) {
    throw new Error(`invalid createdAt: ${String(input.createdAt)}`);
  }
  const core: Omit<Receipt, 'id'> = {
    version: 1,
    createdAt,
    chainId: input.chainId,
    tx: {
      from: lower(input.tx.from),
      to: input.tx.to === null ? null : lower(input.tx.to),
      data: lower(input.tx.data ?? ('0x' as Hex)),
      value: dec(input.tx.value ?? 0n, 'value'),
      ...(input.tx.gasLimitChosen === undefined ? {} : { gasLimitChosen: dec(input.tx.gasLimitChosen, 'gasLimitChosen') }),
    },
    verdict: input.verdict,
    ...(input.doomed === undefined ? {} : { doomed: input.doomed }),
    ...(input.dependencySet === undefined ? {} : { dependencySet: input.dependencySet }),
    policyHash: input.policyHash ?? policyHash(input.policy ?? DEFAULT_POLICY),
    ...(input.txHash === undefined ? {} : { txHash: lower(input.txHash) }),
  };
  assertNoSecrets(core);
  return { ...core, id: receiptId(core) };
}

export interface WriteOptions extends ReceiptStoreOptions {
  store?: ReceiptStore;
}

function storeOf(opts: WriteOptions = {}): ReceiptStore {
  return opts.store ?? new ReceiptStore(opts);
}

/** Writes one receipt for a send attempt (allowed or blocked) and returns it. */
export function recordAttempt(input: AttemptInput, opts: WriteOptions = {}): Receipt {
  return storeOf(opts).put(buildReceipt(input));
}

/**
 * Records what the chain did with an attempt, as an appended amendment. The receipt's id is
 * unchanged: it commits to the decision, not to the outcome.
 */
export function recordOutcome(idOrReceipt: string | Receipt, outcome: OutcomeInput, opts: WriteOptions = {}): Receipt {
  const id = typeof idOrReceipt === 'string' ? idOrReceipt : idOrReceipt.id;
  if (outcome.status !== 'success' && outcome.status !== 'reverted') {
    throw new Error(`outcome.status must be 'success' or 'reverted', got "${String(outcome.status)}"`);
  }
  return storeOf(opts).attachOutcome(id, {
    status: outcome.status,
    gasUsed: dec(outcome.gasUsed, 'gasUsed'),
    feePaidWei: dec(outcome.feePaidWei, 'feePaidWei'),
    blockNumber: dec(outcome.blockNumber, 'blockNumber'),
  });
}

/** Records the hash of a broadcast tx against an already-written attempt. */
export function recordSent(idOrReceipt: string | Receipt, txHash: Hex, opts: WriteOptions = {}): Receipt {
  const id = typeof idOrReceipt === 'string' ? idOrReceipt : idOrReceipt.id;
  return storeOf(opts).attachTxHash(id, txHash);
}
