// Breaker state: counters derived from the receipt store, plus a durable trip flag.
//
// Counters are always derivable from receipts, so state survives a restart and an operator can
// audit every number back to the JSONL line that produced it. The trip flag is the one piece that
// is NOT derived: once tripped, only an explicit reset() clears it.
//
// Persisted to <root>/breaker/<chainId>.json as { version, chainId, updatedAt, wallets: {...} }.

import fs from 'node:fs';
import path from 'node:path';
import type { ChainId, Hex, Policy, Receipt } from '../types.js';
import { ReceiptStore, defaultRoot } from '../receipt/store.js';
import { matchingTargets, selectorOf, targetKeysFor, type TargetKey } from './policy.js';

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
/** How many receipt ids are remembered so a replayed recordResult cannot double-count. */
export const PROCESSED_MEMORY = 256;

export type ResultKind = 'revert' | 'success' | 'neutral';

/**
 * Outcome-based classification. A mined outcome wins; with no outcome, only a gate refusal for a
 * reverting simulation counts as a failure. Verdicts the breaker itself caused (`refused_breaker`)
 * and refusals that are not about state (`refused_funds`, `refused_policy`) are neutral, so the
 * breaker can never feed itself.
 */
export function classifyReceipt(r: Receipt): ResultKind {
  if (r.outcome?.status === 'reverted') return 'revert';
  if (r.outcome?.status === 'success') return 'success';
  return r.verdict === 'refused_doomed' ? 'revert' : 'neutral';
}

export interface BurnEvent {
  /** The attempt's `createdAt`: on 300 ms blocks the outcome follows within a block or two. */
  at: string;
  wei: string;
  keys: TargetKey[];
  receiptId: string;
}

export interface BreakerCounters {
  wallet: Hex;
  consecutiveReverts: number;
  targetConsecutiveReverts: Record<TargetKey, number>;
  /** Wasted fees (reverted outcomes) inside the rolling window. */
  burnWei: string;
  targetBurnWei: Record<TargetKey, string>;
  burnEvents: BurnEvent[];
  windowMs: number;
  windowFrom: string;
  windowTo: string;
  receiptsSeen: number;
  lastReceiptId?: string;
  lastReceiptAt?: string;
  rebuiltAt?: string;
  processed: string[];
}

export interface TargetTrip {
  tripped: true;
  reason: string;
  trippedAt: string;
}

export interface TripState {
  version: 1;
  chainId: ChainId;
  wallet: Hex;
  tripped: boolean;
  reason?: string;
  trippedAt?: string;
  /** Per-(to, selector) trips: one bad target does not halt the others. */
  targets: Record<TargetKey, TargetTrip>;
  counters: BreakerCounters;
  resetAt?: string;
  resets: number;
}

export interface BreakerFile {
  version: 1;
  chainId: ChainId;
  updatedAt: string;
  wallets: Record<string, TripState>;
}

export interface TripEvent {
  chainId: ChainId;
  wallet: Hex;
  scope: 'wallet' | 'target';
  target?: TargetKey;
  reason: string;
  at: string;
  counters: BreakerCounters;
}

export interface Violation {
  scope: 'wallet' | 'target';
  target?: TargetKey;
  reason: string;
}

export function emptyCounters(wallet: Hex, windowMs = DEFAULT_WINDOW_MS, now = new Date()): BreakerCounters {
  return {
    wallet: wallet.toLowerCase() as Hex,
    consecutiveReverts: 0,
    targetConsecutiveReverts: {},
    burnWei: '0',
    targetBurnWei: {},
    burnEvents: [],
    windowMs,
    windowFrom: new Date(now.getTime() - windowMs).toISOString(),
    windowTo: now.toISOString(),
    receiptsSeen: 0,
    processed: [],
  };
}

/** Drops burn events older than the window and recomputes the sums. Mutates and returns. */
export function pruneWindow(c: BreakerCounters, now = new Date()): BreakerCounters {
  const from = new Date(now.getTime() - c.windowMs).toISOString();
  c.windowFrom = from;
  c.windowTo = now.toISOString();
  c.burnEvents = c.burnEvents.filter((e) => e.at >= from);
  let total = 0n;
  const perTarget: Record<TargetKey, bigint> = {};
  for (const e of c.burnEvents) {
    const wei = BigInt(e.wei);
    total += wei;
    for (const k of e.keys) perTarget[k] = (perTarget[k] ?? 0n) + wei;
  }
  c.burnWei = total.toString(10);
  c.targetBurnWei = Object.fromEntries(Object.entries(perTarget).map(([k, v]) => [k, v.toString(10)]));
  return c;
}

/** Folds one receipt into counters. Idempotent per receipt id. Mutates and returns. */
export function applyReceipt(c: BreakerCounters, r: Receipt, now = new Date()): BreakerCounters {
  if (r.tx.from.toLowerCase() !== c.wallet) return c;
  if (c.processed.includes(r.id)) return c;
  const kind = classifyReceipt(r);
  const keys = targetKeysFor(r.tx.to, selectorOf(r.tx.data));
  if (kind === 'revert') {
    c.consecutiveReverts += 1;
    for (const k of keys) c.targetConsecutiveReverts[k] = (c.targetConsecutiveReverts[k] ?? 0) + 1;
    if (r.outcome?.status === 'reverted' && r.outcome.feePaidWei && BigInt(r.outcome.feePaidWei) > 0n) {
      c.burnEvents.push({ at: r.createdAt, wei: BigInt(r.outcome.feePaidWei).toString(10), keys, receiptId: r.id });
    }
  } else if (kind === 'success') {
    c.consecutiveReverts = 0;
    for (const k of keys) delete c.targetConsecutiveReverts[k];
  }
  c.receiptsSeen += 1;
  c.lastReceiptId = r.id;
  c.lastReceiptAt = r.createdAt;
  c.processed.push(r.id);
  if (c.processed.length > PROCESSED_MEMORY) c.processed.splice(0, c.processed.length - PROCESSED_MEMORY);
  return pruneWindow(c, now);
}

/** Rebuilds counters for a wallet from the receipt log. Pure given the receipts. */
export function countersFromReceipts(
  receipts: Receipt[],
  wallet: Hex,
  opts: { windowMs?: number; now?: Date } = {},
): BreakerCounters {
  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const c = emptyCounters(wallet, windowMs, now);
  const ordered = [...receipts].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
  );
  for (const r of ordered) applyReceipt(c, r, now);
  c.rebuiltAt = now.toISOString();
  return pruneWindow(c, now);
}

/** Which policy limits the current counters break. Pure; does not trip anything. */
export function evaluateCounters(c: BreakerCounters, policy: Policy): Violation[] {
  const out: Violation[] = [];
  if (c.consecutiveReverts >= policy.maxConsecutiveReverts) {
    out.push({
      scope: 'wallet',
      reason: `${c.consecutiveReverts} consecutive failed sends from ${c.wallet} (limit ${policy.maxConsecutiveReverts})`,
    });
  }
  const burnLimit = BigInt(policy.maxBurnPerHourWei);
  if (burnLimit > 0n && BigInt(c.burnWei) >= burnLimit) {
    out.push({
      scope: 'wallet',
      reason: `${c.burnWei} wei burned on reverts since ${c.windowFrom} (limit ${policy.maxBurnPerHourWei} per ${c.windowMs} ms)`,
    });
  }
  for (const entry of policy.perTarget) {
    for (const key of entry.selector === undefined
      ? [`${entry.to.toLowerCase()}:*`]
      : [`${entry.to.toLowerCase()}:${entry.selector.toLowerCase()}`]) {
      if (entry.maxConsecutiveReverts !== undefined) {
        const n = c.targetConsecutiveReverts[key] ?? 0;
        if (n >= entry.maxConsecutiveReverts) {
          out.push({
            scope: 'target',
            target: key,
            reason: `${n} consecutive failed sends to ${key} (limit ${entry.maxConsecutiveReverts})`,
          });
        }
      }
      if (entry.maxBurnPerHourWei !== undefined) {
        const limit = BigInt(entry.maxBurnPerHourWei);
        const burned = BigInt(c.targetBurnWei[key] ?? '0');
        if (limit > 0n && burned >= limit) {
          out.push({
            scope: 'target',
            target: key,
            reason: `${burned.toString(10)} wei burned on reverts to ${key} since ${c.windowFrom} (limit ${entry.maxBurnPerHourWei})`,
          });
        }
      }
    }
  }
  return out;
}

/** Trips that apply to one send: the wallet trip, plus a trip on any key this send belongs to. */
export function blockingTrip(
  state: TripState,
  policy: Policy,
  to: Hex | null | undefined,
  selector?: Hex | null,
): { reason: string; target?: TargetKey } | undefined {
  if (state.tripped) return { reason: state.reason ?? 'breaker tripped' };
  const keys = new Set<TargetKey>(matchingTargets(policy, to, selector).map((m) => m.key));
  for (const k of targetKeysFor(to, selector)) if (state.targets[k]) keys.add(k);
  for (const k of keys) {
    const t = state.targets[k];
    if (t) return { reason: t.reason, target: k };
  }
  return undefined;
}

export interface BreakerStateOptions {
  root?: string;
  chainId: ChainId;
  receipts?: ReceiptStore;
  windowMs?: number;
  now?: () => Date;
  /** Operator notification. Fired once per transition into a tripped state. */
  onTrip?: (ev: TripEvent) => void;
}

export class BreakerStateStore {
  readonly root: string;
  readonly chainId: ChainId;
  readonly receipts: ReceiptStore;
  readonly windowMs: number;
  private readonly now: () => Date;
  private readonly onTrip?: (ev: TripEvent) => void;

  constructor(opts: BreakerStateOptions) {
    this.root = path.resolve(opts.root ?? defaultRoot());
    this.chainId = opts.chainId;
    this.receipts = opts.receipts ?? new ReceiptStore({ root: this.root, chainId: opts.chainId });
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? (() => new Date());
    this.onTrip = opts.onTrip;
  }

  get file(): string {
    return path.join(this.root, 'breaker', `${this.chainId}.json`);
  }

  load(): BreakerFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as BreakerFile;
      if (parsed && typeof parsed === 'object' && parsed.wallets) return parsed;
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
    return { version: 1, chainId: this.chainId, updatedAt: this.now().toISOString(), wallets: {} };
  }

  save(f: BreakerFile): BreakerFile {
    f.updatedAt = this.now().toISOString();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Write-then-rename: a reader never sees a half-written state file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
    return f;
  }

  /** Counters derived from the receipt log, with the trip flags of `prev` carried over. */
  private freshState(wallet: Hex, prev?: TripState): TripState {
    const key = wallet.toLowerCase() as Hex;
    const counters = countersFromReceipts(this.receipts.list({ chainId: this.chainId, from: key }), key, {
      windowMs: this.windowMs,
      now: this.now(),
    });
    return {
      version: 1,
      chainId: this.chainId,
      wallet: key,
      tripped: prev?.tripped ?? false,
      ...(prev?.reason === undefined ? {} : { reason: prev.reason }),
      ...(prev?.trippedAt === undefined ? {} : { trippedAt: prev.trippedAt }),
      targets: prev?.targets ?? {},
      counters,
      ...(prev?.resetAt === undefined ? {} : { resetAt: prev.resetAt }),
      resets: prev?.resets ?? 0,
    };
  }

  /** The wallet's entry in `f`, created from the receipt log (and inserted) if absent. */
  private ensure(f: BreakerFile, wallet: Hex): TripState {
    const key = wallet.toLowerCase() as Hex;
    let s = f.wallets[key];
    if (!s) {
      s = this.freshState(key);
      f.wallets[key] = s;
    }
    s.counters.windowMs = this.windowMs;
    pruneWindow(s.counters, this.now());
    return s;
  }

  /** Current state for a wallet, deriving counters from receipts the first time it is seen. */
  state(wallet: Hex): TripState {
    const f = this.load();
    const s = this.ensure(f, wallet);
    this.save(f);
    return s;
  }

  /**
   * Recomputes counters for a wallet from the receipt log and persists them. The trip flag and any
   * target trips are preserved: a trip clears only through reset().
   */
  rebuild(wallet: Hex): TripState {
    const key = wallet.toLowerCase() as Hex;
    const f = this.load();
    const next = this.freshState(key, f.wallets[key]);
    f.wallets[key] = next;
    this.save(f);
    return next;
  }

  /** Folds one receipt into the wallet's counters and persists. Idempotent per receipt id. */
  ingest(receipt: Receipt): TripState {
    const f = this.load();
    const s = this.ensure(f, receipt.tx.from);
    applyReceipt(s.counters, receipt, this.now());
    this.save(f);
    return s;
  }

  /** Marks a trip and notifies the operator. An already-tripped scope is left alone. */
  trip(wallet: Hex, v: Violation): TripState {
    const at = this.now().toISOString();
    const f = this.load();
    const s = this.ensure(f, wallet);
    let fired: TripEvent | undefined;
    if (v.scope === 'wallet') {
      if (!s.tripped) {
        s.tripped = true;
        s.reason = v.reason;
        s.trippedAt = at;
        fired = { chainId: this.chainId, wallet: s.wallet, scope: 'wallet', reason: v.reason, at, counters: s.counters };
      }
    } else if (v.target && !s.targets[v.target]) {
      s.targets[v.target] = { tripped: true, reason: v.reason, trippedAt: at };
      fired = {
        chainId: this.chainId,
        wallet: s.wallet,
        scope: 'target',
        target: v.target,
        reason: v.reason,
        at,
        counters: s.counters,
      };
    }
    this.save(f);
    if (fired && this.onTrip) this.onTrip(fired);
    return s;
  }

  /**
   * Clears a trip. This is the only way one clears. The consecutive-revert counters that caused it
   * are zeroed so history cannot immediately re-trip; burn events are NOT forgiven by default,
   * because the money was really spent — they roll off by time. Pass `clearBurnWindow` to forgive
   * them explicitly.
   */
  reset(wallet: Hex, opts: { target?: TargetKey; clearBurnWindow?: boolean } = {}): TripState {
    const at = this.now().toISOString();
    const f = this.load();
    const s = this.ensure(f, wallet);
    const target = opts.target;
    if (target) {
      delete s.targets[target];
      delete s.counters.targetConsecutiveReverts[target];
      if (opts.clearBurnWindow) s.counters.burnEvents = s.counters.burnEvents.filter((e) => !e.keys.includes(target));
    } else {
      s.tripped = false;
      delete s.reason;
      delete s.trippedAt;
      s.targets = {};
      s.counters.consecutiveReverts = 0;
      s.counters.targetConsecutiveReverts = {};
      if (opts.clearBurnWindow) s.counters.burnEvents = [];
    }
    s.resetAt = at;
    s.resets = (s.resets ?? 0) + 1;
    pruneWindow(s.counters, this.now());
    this.save(f);
    return s;
  }
}
