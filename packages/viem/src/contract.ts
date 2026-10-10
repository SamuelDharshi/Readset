/**
 * The @readset/core surface this package programs against.
 *
 * Another agent owns the real implementations (`gate`, `recordAttempt`, `checkBreaker`,
 * receipt store, `explain`) in packages/core. Those exports did not exist yet when this
 * package was written, so this file declares the *contract* only: narrow structural types
 * named exactly after the core functions. `core-bridge.ts` binds to them at runtime when
 * they appear and otherwise uses the clearly-marked temporary stand-in in `fallback.ts`.
 *
 * TODO(core): when @readset/core exports gate/recordAttempt/checkBreaker/receipt store,
 * delete `fallback.ts` and import these types from core instead of re-declaring them.
 */
import type { PublicClient } from 'viem';
import type {
  DependencySet,
  DoomedTx,
  Hex,
  Policy,
  Receipt,
  TxRequest,
  Verdict,
  Explanation,
} from '@readset/core';

export type { DependencySet, DoomedTx, Hex, Policy, Receipt, TxRequest, Verdict, Explanation };

/** Input to `gate()`. */
export interface GateInput {
  tx: TxRequest;
  policy: Policy;
  client: PublicClient;
}

/** What `gate()` decided. `gasLimit` is the limit to put on the send when allowed. */
export interface GateOutcome {
  verdict: Verdict;
  reason?: string;
  doomed?: DoomedTx;
  dependencySet?: DependencySet;
  gasLimit?: bigint;
}

/** What `checkBreaker()` reports. */
export interface BreakerStatus {
  tripped: boolean;
  reason?: string;
  consecutiveReverts: number;
  burnLastHourWei: string;
  limits: { maxConsecutiveReverts: number; maxBurnPerHourWei: string };
}

/** The outcome of a send, attached to a receipt once mined. */
export interface Outcome {
  status: 'success' | 'reverted';
  gasUsed: string;
  feePaidWei: string;
  blockNumber: string;
}

export interface CoreBindings {
  /** true when every binding came from @readset/core (no stand-in in use). */
  native: boolean;
  /** names taken from @readset/core; the rest came from the stand-in. */
  from: Record<string, 'core' | 'fallback'>;
  gate(input: GateInput): Promise<GateOutcome>;
  /**
   * `wallet` and the (to, selector) pair are required by core's breaker: trip state is
   * per-wallet, and `policy.perTarget` limits are per (to, selector).
   */
  checkBreaker(input: {
    policy: Policy;
    chainId: number;
    wallet: Hex;
    to?: Hex | null;
    selector?: Hex;
    data?: Hex;
  }): Promise<BreakerStatus>;
  recordAttempt(input: {
    tx: TxRequest;
    verdict: Verdict;
    policy: Policy;
    doomed?: DoomedTx;
    dependencySet?: DependencySet;
    gasLimitChosen?: bigint;
    txHash?: Hex;
  }): Promise<Receipt>;
  /** Attach the mined outcome to an existing receipt. */
  recordOutcome(input: { receiptId: string; txHash: Hex; outcome: Outcome }): Promise<Receipt | undefined>;
  /** Most recent receipts, newest first. */
  recentReceipts(input: { limit?: number; chainId?: number }): Promise<Receipt[]>;
  loadPolicy(): Promise<Policy>;
  savePolicy(policy: Policy): Promise<Policy>;
  /** Present only when @readset/core exports `explain`. */
  explain?: (input: { txHash: Hex; client: PublicClient }) => Promise<Explanation>;
}
