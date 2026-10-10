// The plugin's decision path. It is deliberately thin: every rule lives in @readset/core, so the
// MetaMask plugin, the viem wrapper and the MCP server all refuse for the same reasons and write
// the same receipts. The K3 spike under ../spike carried its own copy of the gate; this does not.

import {
  checkBreaker,
  gate,
  loadPolicy,
  recordAttempt,
  recordResult,
  recordSent,
  type Policy,
  type Receipt,
  type TxRequest,
} from '@readset/core';
import type { PublicClient } from 'viem';

export interface DecideInput {
  client: PublicClient;
  tx: TxRequest;
  /** Omit to load .readset/policy.json. */
  policy?: Policy;
}

export interface Decision {
  allowed: boolean;
  verdict: Receipt['verdict'];
  reason?: string;
  /** Gas LIMIT to submit. On Monad this is what gets charged, so it is chosen, never left to the host. */
  gasLimit?: bigint;
  receipt: Receipt;
}

/**
 * Breaker, then gate, then receipt — in that order.
 *
 * The breaker runs first and without any RPC call, so a tripped breaker halts the send before we
 * spend a simulation on it (PRD: "a tripped breaker halts before any simulation").
 */
export async function decide(input: DecideInput): Promise<Decision> {
  const policy = input.policy ?? loadPolicy();
  const tx = input.tx;

  const breaker = checkBreaker(
    { wallet: tx.from, chainId: tx.chainId, to: tx.to, ...(tx.data === undefined ? {} : { data: tx.data }) },
    { policy },
  );

  if (!breaker.allow) {
    const receipt = recordAttempt({
      chainId: tx.chainId,
      tx: { from: tx.from, to: tx.to, ...(tx.data === undefined ? {} : { data: tx.data }) },
      verdict: 'refused_breaker',
      policy,
    });
    return {
      allowed: false,
      verdict: 'refused_breaker',
      reason: breaker.reason ?? 'circuit breaker tripped',
      receipt,
    };
  }

  const g = await gate({ client: input.client, tx, policy });
  const reason = g.doomed?.revertReason ?? g.doomed?.reason ?? g.funds?.reason;

  const receipt = recordAttempt({
    chainId: tx.chainId,
    tx: {
      from: tx.from,
      to: tx.to,
      ...(tx.data === undefined ? {} : { data: tx.data }),
      ...(tx.value === undefined ? {} : { value: tx.value.toString() }),
      ...(g.gasLimitChosen === undefined ? {} : { gasLimitChosen: g.gasLimitChosen.toString() }),
    },
    verdict: g.verdict,
    policy,
    ...(g.doomed === undefined ? {} : { doomed: g.doomed }),
    ...(g.dependencySet === undefined ? {} : { dependencySet: g.dependencySet }),
  });

  // Feed the decision back so consecutive-revert counters follow outcomes, not intentions.
  recordResult(receipt, { policy });

  return {
    allowed: g.verdict === 'allowed',
    verdict: g.verdict,
    ...(reason === undefined ? {} : { reason }),
    ...(g.gasLimitChosen === undefined ? {} : { gasLimit: g.gasLimitChosen }),
    receipt,
  };
}

/** Records the hash of a tx the host actually broadcast, against the receipt we already wrote. */
export function attachHash(receipt: Receipt, txHash: `0x${string}`): Receipt {
  return recordSent(receipt, txHash);
}
