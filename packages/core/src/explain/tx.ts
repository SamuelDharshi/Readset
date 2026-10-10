// Standalone entry points over the existing explain internals. These wrap code that already
// runs inside explainFailedTx; they exist so a caller can ask one cheap question (what did this
// cost?) or one targeted question (would it have reverted k blocks ago?) without paying for a
// full forensic run.

import type { PublicClient } from 'viem';
import type { Hex } from '../types.js';
import { withBackoff } from '../trace/index.js';
import { burnFacts, decodeRevert, type DecodedRevert } from './avoidable.js';

type Raw = (args: { method: string; params: unknown[] }) => Promise<any>;

export interface TxBurn {
  hash: Hex;
  /** 1 = succeeded, 0 = reverted. A succeeded transaction has nothing to explain. */
  status: 0 | 1;
  blockNumber: bigint;
  blockHash: Hex;
  txIndex: number;
  from: Hex;
  to: Hex | null;
  /** First 4 bytes of calldata, or null for a plain transfer / deploy. */
  selector: Hex | null;
  nonce: number;
  gasLimit: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** gasLimit x effectiveGasPrice. Monad charges the LIMIT, so this is what was actually paid. */
  burnedWei: bigint;
  burnedMon: number;
  /** receipt.gasUsed == tx.gas: the receipt itself agreeing the whole limit was charged. */
  receiptGasUsedEqualsLimit: boolean;
}

/**
 * What a transaction cost and whether it failed, from one tx + one receipt.
 *
 * `burnedMon` is a convenience for display only; anything that must be exact should use
 * `burnedWei`, because a float cannot hold wei precisely.
 */
export async function getTxBurn(client: PublicClient, hash: Hex): Promise<TxBurn> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`getTxBurn: not a transaction hash: ${hash}`);
  const raw = client.request as unknown as Raw;
  const req = <T>(method: string, params: unknown[]) =>
    withBackoff(() => raw({ method, params })) as Promise<T>;

  const key = hash.toLowerCase() as Hex;
  const tx = await req<any>('eth_getTransactionByHash', [key]);
  if (!tx) throw new Error(`transaction not found: ${key}`);
  const rc = await req<any>('eth_getTransactionReceipt', [key]);
  if (!rc) throw new Error(`receipt not found (transaction may still be pending): ${key}`);

  const gasLimit = BigInt(tx.gas);
  const effectiveGasPrice = BigInt(rc.effectiveGasPrice ?? tx.gasPrice ?? 0);
  const gasUsed = BigInt(rc.gasUsed ?? 0);
  const facts = burnFacts({ gasLimit, effectiveGasPrice, receiptGasUsed: gasUsed });
  const data = (tx.input ?? '0x') as string;

  return {
    hash: key,
    status: Number(BigInt(rc.status)) === 1 ? 1 : 0,
    blockNumber: BigInt(rc.blockNumber),
    blockHash: (rc.blockHash as string).toLowerCase() as Hex,
    txIndex: Number(BigInt(rc.transactionIndex ?? 0)),
    from: (tx.from as string).toLowerCase() as Hex,
    to: tx.to ? ((tx.to as string).toLowerCase() as Hex) : null,
    selector: data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : null,
    nonce: Number(BigInt(tx.nonce ?? 0)),
    gasLimit,
    gasUsed,
    effectiveGasPrice,
    burnedWei: BigInt(facts.burnedWei),
    burnedMon: Number(facts.burnedWei) / 1e18,
    receiptGasUsedEqualsLimit: facts.receiptGasUsedEqualsLimit,
  };
}

export interface ReplayResult {
  k: number;
  block: bigint;
  blockHash: Hex;
  /** true = it reverted against that state, false = it would have gone through. */
  reverted: boolean;
  revert: DecodedRevert;
  /** The node's own error text, when it gave one. */
  error?: string;
}

/**
 * Re-simulate a transaction against the committed state `k` blocks before the one it failed in.
 *
 * Pinned by block HASH (EIP-1898), not by number: a number can be re-pointed by a reorg, and a
 * forensic answer has to name the exact state it was computed against.
 */
export async function replayAt(client: PublicClient, hash: Hex, k: number): Promise<ReplayResult> {
  if (!Number.isInteger(k) || k < 1) throw new Error(`replayAt: k must be a positive integer, got ${k}`);
  const raw = client.request as unknown as Raw;
  const req = <T>(method: string, params: unknown[]) =>
    withBackoff(() => raw({ method, params })) as Promise<T>;

  const key = hash.toLowerCase() as Hex;
  const tx = await req<any>('eth_getTransactionByHash', [key]);
  if (!tx) throw new Error(`transaction not found: ${key}`);
  const at = BigInt(tx.blockNumber) - BigInt(k);
  if (at < 0n) throw new Error(`replayAt: block ${tx.blockNumber} has no N-${k}`);

  const header = await req<any>('eth_getBlockByNumber', [`0x${at.toString(16)}`, false]);
  if (!header?.hash) throw new Error(`block ${at} not found on this endpoint`);
  const blockHash = (header.hash as string).toLowerCase() as Hex;

  const call: Record<string, unknown> = {
    from: tx.from,
    data: tx.input ?? '0x',
    value: tx.value ?? '0x0',
    gas: tx.gas,
  };
  if (tx.to) call.to = tx.to;

  try {
    await req('eth_call', [call, { blockHash }]);
    return { k, block: at, blockHash, reverted: false, revert: { kind: 'none' } };
  } catch (e) {
    const err = e as { message?: string; data?: string; cause?: { data?: string } };
    const data = (err.data ?? err.cause?.data) as string | undefined;
    const message = err.message ?? String(e);
    return {
      k,
      block: at,
      blockHash,
      reverted: true,
      // decodeRevert reads the revert DATA; the node's message is kept separately below.
      revert: decodeRevert(data as Hex | undefined),
      error: message.split('\n')[0] ?? message,
    };
  }
}
