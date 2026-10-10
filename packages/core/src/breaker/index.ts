// Outcome-based circuit breaker.
//
// Call `checkBreaker` BEFORE any simulation: a tripped breaker halts the send without spending an
// RPC round trip (PRD "How it works": a tripped breaker halts before any simulation). Feed every
// receipt back through `recordResult` so counters follow outcomes, not intentions.

import type { ChainId, Hex, Policy, Receipt } from '../types.js';
import { ReceiptStore } from '../receipt/store.js';
import { loadPolicy, selectorOf, type TargetKey } from './policy.js';
import {
  BreakerStateStore,
  blockingTrip,
  evaluateCounters,
  type BreakerCounters,
  type TripEvent,
  type TripState,
  type Violation,
} from './state.js';

export * from './policy.js';
export * from './state.js';

export interface BreakerOptions {
  /** Base directory; default `READSET_HOME` or `<cwd>/.readset`. */
  root?: string;
  chainId?: ChainId;
  /** Policy in force; default `<root>/policy.json`, else DEFAULT_POLICY. */
  policy?: Policy;
  receipts?: ReceiptStore;
  /** Burn window, ms; default one hour. */
  windowMs?: number;
  now?: () => Date;
  /** Operator notification, fired once per transition into a tripped state. */
  onTrip?: (ev: TripEvent) => void;
}

export interface BreakerContext {
  chainId?: ChainId;
  /** The sending wallet. Consecutive-revert counters are per wallet. */
  wallet: Hex;
  to?: Hex | null;
  /** Calldata, used only for its 4-byte selector. */
  data?: Hex;
  /** Explicit selector, when calldata is not at hand. */
  selector?: Hex;
}

export interface BreakerDecision {
  allow: boolean;
  reason?: string;
  /** Set when a per-(to, selector) trip, not the wallet trip, is what blocked the send. */
  target?: TargetKey;
}

export class Breaker {
  readonly chainId: ChainId;
  readonly policy: Policy;
  readonly states: BreakerStateStore;

  constructor(opts: BreakerOptions & { chainId: ChainId }) {
    this.chainId = opts.chainId;
    this.policy = opts.policy ?? loadPolicy({ root: opts.root });
    this.states = new BreakerStateStore({
      chainId: opts.chainId,
      ...(opts.root === undefined ? {} : { root: opts.root }),
      ...(opts.receipts === undefined ? {} : { receipts: opts.receipts }),
      ...(opts.windowMs === undefined ? {} : { windowMs: opts.windowMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.onTrip === undefined ? {} : { onTrip: opts.onTrip }),
    });
  }

  /** Should this send happen at all? Call before simulating. */
  check(ctx: BreakerContext): BreakerDecision {
    const selector = ctx.selector ?? selectorOf(ctx.data);
    let state = this.states.state(ctx.wallet);
    const first = blockingTrip(state, this.policy, ctx.to, selector);
    if (first) return refuse(first);
    // Counters may already be over a limit (e.g. rebuilt from receipts after a restart): trip now.
    for (const v of evaluateCounters(state.counters, this.policy)) state = this.states.trip(ctx.wallet, v);
    const second = blockingTrip(state, this.policy, ctx.to, selector);
    return second ? refuse(second) : { allow: true };
  }

  /** Folds a receipt into the counters and trips whatever it broke. */
  recordResult(receipt: Receipt): TripState {
    let state = this.states.ingest(receipt);
    for (const v of this.violations(state.counters)) state = this.states.trip(receipt.tx.from, v);
    return state;
  }

  violations(counters: BreakerCounters): Violation[] {
    return evaluateCounters(counters, this.policy);
  }

  state(wallet: Hex): TripState {
    return this.states.state(wallet);
  }

  counters(wallet: Hex): BreakerCounters {
    return this.states.state(wallet).counters;
  }

  /** Re-derives counters from the receipt log. Trip flags survive; only reset() clears them. */
  rebuild(wallet: Hex): TripState {
    return this.states.rebuild(wallet);
  }

  /** The only way a trip clears. */
  reset(wallet: Hex, opts: { target?: TargetKey; clearBurnWindow?: boolean } = {}): TripState {
    return this.states.reset(wallet, opts);
  }
}

function refuse(t: { reason: string; target?: TargetKey }): BreakerDecision {
  return { allow: false, reason: t.reason, ...(t.target === undefined ? {} : { target: t.target }) };
}

function breakerFor(ctx: BreakerContext, opts: BreakerOptions): Breaker {
  const chainId = ctx.chainId ?? opts.chainId;
  if (chainId === undefined) throw new Error('checkBreaker needs a chainId (on the context or the options)');
  return new Breaker({ ...opts, chainId });
}

/**
 * One-shot check, reading policy and state from disk. Returns `{ allow: false, reason }` when the
 * breaker is tripped for this wallet or for this (to, selector).
 */
export function checkBreaker(ctx: BreakerContext, opts: BreakerOptions = {}): BreakerDecision {
  return breakerFor(ctx, opts).check(ctx);
}

/** One-shot counter update from a receipt. */
export function recordResult(receipt: Receipt, opts: BreakerOptions = {}): TripState {
  return breakerFor({ wallet: receipt.tx.from, chainId: receipt.chainId }, opts).recordResult(receipt);
}

/** One-shot operator reset. */
export function resetBreaker(
  wallet: Hex,
  opts: BreakerOptions & { chainId: ChainId; target?: TargetKey; clearBurnWindow?: boolean },
): TripState {
  const { target, clearBurnWindow, ...rest } = opts;
  return new Breaker(rest).reset(wallet, {
    ...(target === undefined ? {} : { target }),
    ...(clearBurnWindow === undefined ? {} : { clearBurnWindow }),
  });
}
