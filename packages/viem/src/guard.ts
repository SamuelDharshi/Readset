import { createPublicClient, http, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem';
import type {
  BreakerStatus,
  DependencySet,
  DoomedTx,
  Hex,
  Outcome,
  Policy,
  Receipt,
  TxRequest,
  Verdict,
} from './contract.js';
import { loadCoreBindings } from './core-bridge.js';
import { DoomedTxError } from './errors.js';

/** The verdict for one candidate transaction, plus the receipt written for it. */
export interface GuardDecision {
  allowed: boolean;
  verdict: Verdict;
  reason?: string;
  /** Gas LIMIT chosen for the send. Monad charges gas_limit x price, so this is what you pay. */
  gasLimit?: bigint;
  doomed?: DoomedTx;
  dependencySet?: DependencySet;
  breaker: BreakerStatus;
  receipt: Receipt;
  /** Which of gate/receipts/breaker came from @readset/core vs the temporary stand-in. */
  source: Record<string, 'core' | 'fallback'>;
}

export interface GuardOptions {
  tx: TxRequest;
  publicClient: PublicClient;
  policy?: Policy;
  /** Write a dependency receipt for this decision (default true). */
  record?: boolean;
}

/** Breaker -> gate -> receipt, without signing anything. Never throws on a refusal. */
export async function guard(opts: GuardOptions): Promise<GuardDecision> {
  const core = await loadCoreBindings();
  const policy = opts.policy ?? (await core.loadPolicy());
  const tx = opts.tx;

  const breaker = await core.checkBreaker({
    policy,
    chainId: tx.chainId,
    wallet: tx.from,
    to: tx.to,
    data: tx.data,
  });

  const outcome = breaker.tripped
    ? { verdict: 'refused_breaker' as Verdict, reason: breaker.reason ?? 'circuit breaker tripped' }
    : await core.gate({ tx, policy, client: opts.publicClient });

  const receipt = await core.recordAttempt({
    tx,
    verdict: outcome.verdict,
    policy,
    doomed: outcome.doomed,
    dependencySet: outcome.dependencySet,
    gasLimitChosen: outcome.gasLimit,
  });

  return {
    allowed: outcome.verdict === 'allowed',
    verdict: outcome.verdict,
    reason: outcome.reason,
    gasLimit: outcome.gasLimit,
    doomed: outcome.doomed,
    dependencySet: outcome.dependencySet,
    breaker,
    receipt,
    source: core.from,
  };
}

/** Turn a refusal into the typed error the guarded client throws. */
export function refusalError(d: GuardDecision): DoomedTxError {
  return new DoomedTxError({
    verdict: d.verdict as Exclude<Verdict, 'allowed'>,
    reason: d.reason ?? d.verdict,
    revertReason: d.doomed?.revertReason,
    revertData: d.doomed?.revertData,
    receiptId: d.receipt.id,
    dependencySet: d.dependencySet,
    doomed: d.doomed,
    chainId: d.receipt.chainId,
  });
}

/**
 * Watch a sent transaction and attach its outcome (status, gasUsed, fee paid) to the receipt.
 * `feePaidWei` is `gasUsed x effectiveGasPrice` as the chain reports it; on Monad a reverted
 * top-level call reports `gasUsed == gasLimit`, so this is the real amount burned.
 */
export async function attachOutcome(args: {
  publicClient: PublicClient;
  receiptId: string;
  txHash: Hex;
}): Promise<Receipt | undefined> {
  const core = await loadCoreBindings();
  const r = await args.publicClient.waitForTransactionReceipt({ hash: args.txHash });
  const outcome: Outcome = {
    status: r.status === 'success' ? 'success' : 'reverted',
    gasUsed: String(r.gasUsed),
    feePaidWei: String(r.gasUsed * (r.effectiveGasPrice ?? 0n)),
    blockNumber: String(r.blockNumber),
  };
  return core.recordOutcome({ receiptId: args.receiptId, txHash: args.txHash, outcome });
}

export function publicClientFor(walletClient: WalletClient<Transport, Chain | undefined>): PublicClient {
  if (!walletClient.chain) {
    throw new Error(
      'createGuardedWalletClient needs `publicClient` when the wallet client has no chain configured.',
    );
  }
  return createPublicClient({
    chain: walletClient.chain,
    transport: http(walletClient.chain.rpcUrls.default.http[0]),
  }) as PublicClient;
}
