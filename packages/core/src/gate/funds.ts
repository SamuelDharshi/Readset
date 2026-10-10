// The Gate, step 3: can the sender actually pay for this transaction?
//
// On Monad the answer is not "gas used x price". From docs.monad.xyz, Gas Pricing (quoted in
// docs/facts.md #1a, VERIFIED): "The gas charged for a transaction is the **gas limit** set in the
// transaction, rather than the gas used in the course of execution", with `fee = gas limit x price per gas`
// and `price_per_gas = min(base_price_per_gas + priority_price_per_gas, max_price_per_gas)`.
// So the worst case a sender must be able to cover is `gas_limit x max_fee_per_gas + value`, in full,
// whether the transaction succeeds or reverts (docs/facts.md #10: confirmed on 12 real mainnet failures,
// where the sender's balance fell by exactly gasLimit x effectiveGasPrice).
import type { PublicClient } from 'viem';
import type { Hex, TxRequest } from '../types.js';
import { createGateRpc, type FailoverOptions, type GateRpc, type PinnedBlock } from './simulate.js';
import { normalizeAddress } from '../trace/index.js';

/**
 * `user_reserve_balance`, 10 MON per EOA.
 *
 * Source: docs.monad.xyz/developer-essentials/reserve-balance, condensed in
 * docs/lineage/monad-docs/reserve-balance.md:
 *   - "`user_reserve_balance` = 10 MON" per EOA;
 *   - "consensus can safely include a series of transactions whose running gas spend stays below
 *      user_reserve_balance, without knowing the latest state";
 *   - execution reverts when an EIP-7702-delegated account's balance "dips below" 10 MON after a tx
 *     (it both decreases AND ends below); non-senders must keep their starting balance or the reserve,
 *     whichever is lower;
 *   - exception: "emptying transactions" (the first tx in k blocks from an undelegated account) bypass the
 *     constraint, so an undelegated account can spend its whole balance about once per 1.2 s.
 */
export const RESERVE_BALANCE_WEI = 10n * 10n ** 18n;

/** EIP-7702 delegation designator prefix: code of a delegated EOA is 0xef0100 ++ 20-byte address. */
export const DELEGATION_PREFIX = '0xef0100';

export interface FundsCheck {
  /** false only when a documented rule says this send cannot be paid for. */
  ok: boolean;
  sender: Hex;
  /** Sender balance at the pinned block. */
  balance: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  /** gasLimit x maxFeePerGas: what Monad charges, not an estimate of gas used. */
  maxFeeWei: bigint;
  value: bigint;
  /** maxFeeWei + value. */
  requiredWei: bigint;
  /** balance - requiredWei (negative when short). */
  shortfallWei: bigint;
  reserveBalanceWei: bigint;
  /** Sender is an EIP-7702-delegated account (code starts with 0xef0100), so the reserve rule is a hard revert. */
  delegated: boolean;
  /**
   * The worst-case spend would leave the sender below the 10 MON reserve. For a delegated sender this makes
   * `ok` false (execution reverts). For an undelegated sender it is a warning only, because the documented
   * "emptying transaction" exception lets it spend its whole balance about once per k blocks.
   */
  reserveRisk: boolean;
  /** Human reason; set whenever ok is false or reserveRisk is true. */
  reason?: string;
}

export interface CheckFundsOptions extends FailoverOptions {
  rpc?: GateRpc;
  /** Read the balance/code at this block (by hash) instead of 'latest'. */
  pinnedBlock?: PinnedBlock;
}

/**
 * Check the sender can cover `gasLimit x maxFeePerGas + tx.value` at the pinned block, and report the
 * Monad reserve-balance consequence.
 *
 * Deliberately NOT refused for an undelegated sender that dips under the reserve: the docs' emptying-tx
 * exception makes that legal, and refusing it would block the normal "spend the wallet" case. It is
 * surfaced as `reserveRisk` with a reason instead.
 */
export async function checkFunds(
  client: PublicClient,
  tx: TxRequest,
  gasLimit: bigint,
  maxFeePerGas: bigint,
  opts: CheckFundsOptions = {},
): Promise<FundsCheck> {
  if (gasLimit <= 0n) throw new Error('checkFunds: gasLimit must be positive');
  if (maxFeePerGas < 0n) throw new Error('checkFunds: maxFeePerGas must not be negative');
  const rpc = opts.rpc ?? createGateRpc(client, opts);
  const at: string | { blockHash: Hex } = opts.pinnedBlock ? { blockHash: opts.pinnedBlock.hash } : 'latest';
  const sender = normalizeAddress(tx.from);

  const [balHex, code] = await Promise.all([
    rpc.request<Hex>('eth_getBalance', [sender, at]),
    rpc.request<Hex>('eth_getCode', [sender, at]),
  ]);
  const balance = BigInt(balHex);
  const value = tx.value ?? 0n;
  const maxFeeWei = gasLimit * maxFeePerGas;
  const requiredWei = maxFeeWei + value;
  const shortfallWei = balance - requiredWei;
  const delegated = (code ?? '0x').toLowerCase().startsWith(DELEGATION_PREFIX);
  const remaining = balance - requiredWei;
  const reserveRisk = remaining < RESERVE_BALANCE_WEI && requiredWei > 0n;

  const mon = (w: bigint) => `${Number(w) / 1e18} MON`;

  if (shortfallWei < 0n) {
    return {
      ok: false,
      sender,
      balance,
      gasLimit,
      maxFeePerGas,
      maxFeeWei,
      value,
      requiredWei,
      shortfallWei,
      reserveBalanceWei: RESERVE_BALANCE_WEI,
      delegated,
      reserveRisk,
      reason:
        `sender ${sender} holds ${mon(balance)} but this send can cost ${mon(requiredWei)} ` +
        `(gas limit ${gasLimit} x ${maxFeePerGas} wei = ${mon(maxFeeWei)}, plus value ${mon(value)}); ` +
        `short by ${mon(-shortfallWei)}. Monad charges the gas limit, not gas used.`,
    };
  }

  if (delegated && reserveRisk) {
    return {
      ok: false,
      sender,
      balance,
      gasLimit,
      maxFeePerGas,
      maxFeeWei,
      value,
      requiredWei,
      shortfallWei,
      reserveBalanceWei: RESERVE_BALANCE_WEI,
      delegated,
      reserveRisk,
      reason:
        `sender ${sender} is an EIP-7702-delegated account and this send would leave ${mon(remaining)}, ` +
        `below the ${mon(RESERVE_BALANCE_WEI)} user_reserve_balance; Monad reverts execution when a ` +
        `delegated account's balance decreases and ends below the reserve ` +
        `(docs.monad.xyz/developer-essentials/reserve-balance).`,
    };
  }

  return {
    ok: true,
    sender,
    balance,
    gasLimit,
    maxFeePerGas,
    maxFeeWei,
    value,
    requiredWei,
    shortfallWei,
    reserveBalanceWei: RESERVE_BALANCE_WEI,
    delegated,
    reserveRisk,
    reason: reserveRisk
      ? `this send would leave ${mon(remaining)}, below the ${mon(RESERVE_BALANCE_WEI)} user_reserve_balance: ` +
        `consensus may exclude it unless it qualifies as an "emptying transaction" (first tx in k blocks ` +
        `from an undelegated account) (docs.monad.xyz/developer-essentials/reserve-balance).`
      : undefined,
  };
}
