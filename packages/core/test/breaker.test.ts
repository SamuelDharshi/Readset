import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  Breaker,
  DEFAULT_POLICY,
  classifyReceipt,
  countersFromReceipts,
  loadPolicy,
  parsePolicy,
  policyPath,
  savePolicy,
  selectorOf,
  targetKey,
  type TripEvent,
} from '../src/breaker/index.js';
import { ReceiptStore, monadFeePaidWei, recordAttempt, recordOutcome } from '../src/receipt/index.js';
import type { Hex, Policy, Receipt, Verdict } from '../src/types.js';

const CHAIN = 10143;
const WALLET: Hex = '0x00000000000000000000000000000000000a11ce';
const POOL_A: Hex = '0x7a3f00000000000000000000000000000000c21e';
const POOL_B: Hex = '0xb0b000000000000000000000000000000000beef';
const SWAP: Hex = '0x38ed1739';
const GWEI = 10n ** 9n;
/** 0.2 MON, the measured mean burn of a failed mainnet tx (docs/facts.md). */
const BURN_PER_FAIL = monadFeePaidWei(1_800_000n, 110n * GWEI);

/** Uppercases the hex body but not the 0x prefix, as a checksummed address would be. */
const upperHex = (h: Hex) => `0x${h.slice(2).toUpperCase()}`;

const tmpRoots: string[] = [];
function tmpRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `readset-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

interface SeedOpts {
  to?: Hex;
  selector?: Hex;
  verdict?: Verdict;
  /** 'reverted' | 'success' writes an outcome amendment; undefined leaves the attempt unmined. */
  outcome?: 'reverted' | 'success';
  feePaidWei?: string;
  at?: Date;
  nonce?: number;
}

/**
 * Writes one real receipt (and its outcome amendment) through the real store, so every counter in
 * these tests is rebuilt from JSONL this test suite actually produced.
 */
function seed(store: ReceiptStore, opts: SeedOpts = {}): Receipt {
  const to = opts.to ?? POOL_A;
  const selector = opts.selector ?? SWAP;
  const at = opts.at ?? new Date('2026-10-07T12:00:00.000Z');
  const r = recordAttempt(
    {
      chainId: CHAIN,
      tx: { from: WALLET, to, data: `${selector}${(opts.nonce ?? 0).toString(16).padStart(64, '0')}` as Hex, value: 0n, gasLimitChosen: 1_800_000n },
      verdict: opts.verdict ?? (opts.outcome === undefined ? 'refused_doomed' : 'allowed'),
      ...(opts.verdict === 'refused_doomed' || opts.outcome === undefined
        ? { doomed: { reason: 'simulation reverted', revertReason: 'SLIPPAGE' } }
        : {}),
      policy: DEFAULT_POLICY,
      createdAt: at,
    },
    { store },
  );
  if (opts.outcome) {
    return recordOutcome(
      r,
      {
        status: opts.outcome,
        gasUsed: 1_800_000n,
        feePaidWei: opts.feePaidWei ?? (opts.outcome === 'reverted' ? BURN_PER_FAIL : '0'),
        blockNumber: 111_218_900n,
      },
      { store },
    );
  }
  return r;
}

function setup(tag: string, policy: Partial<Policy> = {}, onTrip?: (ev: TripEvent) => void) {
  const root = tmpRoot(tag);
  const saved = savePolicy(parsePolicy({ ...policy }), { root });
  const now = new Date('2026-10-07T12:30:00.000Z');
  // Same clock for the store: amendments are filed by their own date, so a real clock would
  // scatter them into today's file and make these counters depend on the calendar.
  const store = new ReceiptStore({ root, chainId: CHAIN, now: () => now });
  const breaker = new Breaker({
    root,
    chainId: CHAIN,
    receipts: store,
    now: () => now,
    ...(onTrip === undefined ? {} : { onTrip }),
  });
  return { root, store, breaker, policy: saved, now };
}

describe('policy', () => {
  it('defaults match the PRD', () => {
    expect(DEFAULT_POLICY.maxConsecutiveReverts).toBe(5);
    expect(DEFAULT_POLICY.perTarget).toEqual([]);
    expect(DEFAULT_POLICY.failClosed).toBe(true);
    expect(BigInt(DEFAULT_POLICY.maxBurnPerHourWei)).toBeGreaterThan(0n);
  });

  it('round-trips through <root>/policy.json and normalises case', () => {
    const root = tmpRoot('policy');
    expect(loadPolicy({ root })).toEqual(DEFAULT_POLICY);
    savePolicy(
      parsePolicy({ maxConsecutiveReverts: 3, perTarget: [{ to: upperHex(POOL_A), selector: upperHex(SWAP), maxConsecutiveReverts: 2 }] }),
      { root },
    );
    expect(fs.existsSync(policyPath(root))).toBe(true);
    const loaded = loadPolicy({ root });
    expect(loaded.maxConsecutiveReverts).toBe(3);
    expect(loaded.perTarget[0]).toEqual({ to: POOL_A, selector: SWAP, maxConsecutiveReverts: 2 });
  });

  it('rejects nonsense instead of silently defaulting', () => {
    expect(() => parsePolicy({ maxConsecutiveReverts: 0 })).toThrow();
    expect(() => parsePolicy({ maxBurnPerHourWei: 1e18 })).toThrow();
    expect(() => parsePolicy({ perTarget: [{ to: '0xdead' }] })).toThrow();
  });

  it('selector and target keys', () => {
    expect(selectorOf('0x38ed1739deadbeef')).toBe(SWAP);
    expect(selectorOf('0x')).toBeUndefined();
    expect(targetKey(POOL_A, SWAP)).toBe(`${POOL_A}:${SWAP}`);
    expect(targetKey(null)).toBe('create:*');
  });
});

describe('counters rebuilt from a real receipt log', () => {
  it('derives consecutive reverts and hourly burn from the JSONL the store wrote', () => {
    const { root, store, breaker, now } = setup('rebuild', { maxConsecutiveReverts: 100 });
    seed(store, { outcome: 'reverted', nonce: 1 });
    seed(store, { outcome: 'reverted', nonce: 2 });
    seed(store, { outcome: 'success', nonce: 3, at: new Date('2026-10-07T12:00:01.000Z') });
    seed(store, { outcome: 'reverted', nonce: 4, at: new Date('2026-10-07T12:00:02.000Z') });
    seed(store, { verdict: 'refused_doomed', nonce: 5, at: new Date('2026-10-07T12:00:03.000Z') });
    seed(store, { verdict: 'refused_breaker', nonce: 6, at: new Date('2026-10-07T12:00:04.000Z') });

    // The fixture is a real append-only log: receipts plus outcome amendments.
    const file = path.join(root, 'receipts', String(CHAIN), '2026-10-07.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind?: string });
    expect(lines.filter((l) => l.kind === 'amendment')).toHaveLength(4);
    expect(lines.filter((l) => l.kind === undefined)).toHaveLength(6);

    const counters = breaker.rebuild(WALLET).counters;
    // success at #3 reset the run; #4 and #5 are reverts; #6 (refused_breaker) is neutral.
    expect(counters.consecutiveReverts).toBe(2);
    expect(counters.receiptsSeen).toBe(6);
    expect(counters.targetConsecutiveReverts[targetKey(POOL_A, SWAP)]).toBe(2);
    expect(counters.targetConsecutiveReverts[targetKey(POOL_A)]).toBe(2);
    // Only mined reverts cost money: 3 of them.
    expect(counters.burnWei).toBe((BigInt(BURN_PER_FAIL) * 3n).toString(10));
    expect(counters.burnEvents).toHaveLength(3);
    expect(counters.windowTo).toBe(now.toISOString());

    // Counters survive a restart: a fresh Breaker over the same root reads the same numbers,
    // and re-deriving them from the log reproduces them exactly.
    const fresh = new Breaker({ root, chainId: CHAIN, now: () => now });
    expect(fresh.counters(WALLET).consecutiveReverts).toBe(2);
    const pure = countersFromReceipts(store.list({ from: WALLET }), WALLET, { now });
    expect(pure.consecutiveReverts).toBe(counters.consecutiveReverts);
    expect(pure.burnWei).toBe(counters.burnWei);
  });

  it('classifies outcomes, not intentions', () => {
    const { store } = setup('classify');
    expect(classifyReceipt(seed(store, { outcome: 'reverted', nonce: 1 }))).toBe('revert');
    expect(classifyReceipt(seed(store, { outcome: 'success', nonce: 2 }))).toBe('success');
    expect(classifyReceipt(seed(store, { verdict: 'refused_doomed', nonce: 3 }))).toBe('revert');
    expect(classifyReceipt(seed(store, { verdict: 'refused_breaker', nonce: 4 }))).toBe('neutral');
    expect(classifyReceipt(seed(store, { verdict: 'refused_funds', nonce: 5 }))).toBe('neutral');
    expect(classifyReceipt(seed(store, { verdict: 'allowed', nonce: 6 }))).toBe('neutral');
  });

  it('recordResult is idempotent for a receipt id', () => {
    const { store, breaker } = setup('idempotent', { maxConsecutiveReverts: 100 });
    const r = seed(store, { verdict: 'refused_doomed', nonce: 1 });
    breaker.recordResult(r);
    breaker.recordResult(r);
    expect(breaker.counters(WALLET).consecutiveReverts).toBe(1);
  });
});

describe('tripping', () => {
  it('trips at exactly 5 consecutive reverts and not before', () => {
    const trips: TripEvent[] = [];
    const { store, breaker } = setup('five', {}, (ev) => trips.push(ev));
    for (let i = 1; i <= 4; i++) {
      expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
      breaker.recordResult(seed(store, { verdict: 'refused_doomed', nonce: i }));
    }
    expect(breaker.counters(WALLET).consecutiveReverts).toBe(4);
    expect(breaker.state(WALLET).tripped).toBe(false);
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);

    breaker.recordResult(seed(store, { verdict: 'refused_doomed', nonce: 5 }));
    expect(breaker.state(WALLET).tripped).toBe(true);
    const decision = breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/5 consecutive failed sends/);
    // the operator is notified once, not once per blocked send
    breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP });
    expect(trips).toHaveLength(1);
    expect(trips[0]!.scope).toBe('wallet');
    expect(trips[0]!.wallet).toBe(WALLET);
  });

  it('a trip is durable and clears only on an explicit reset', () => {
    const { root, store, breaker, now } = setup('reset');
    for (let i = 1; i <= 5; i++) breaker.recordResult(seed(store, { verdict: 'refused_doomed', nonce: i }));
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(false);

    // persisted where an operator can see it
    const stateFile = path.join(root, 'breaker', `${CHAIN}.json`);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).wallets[WALLET].tripped).toBe(true);

    // a restart does not forgive it, and neither does re-deriving counters from the log
    const restarted = new Breaker({ root, chainId: CHAIN, now: () => now });
    expect(restarted.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(false);
    restarted.rebuild(WALLET);
    expect(restarted.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(false);

    const afterReset = restarted.reset(WALLET);
    expect(afterReset.tripped).toBe(false);
    expect(afterReset.resets).toBe(1);
    expect(afterReset.counters.consecutiveReverts).toBe(0);
    expect(restarted.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
    // and the reset is itself durable
    expect(new Breaker({ root, chainId: CHAIN, now: () => now }).check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
  });

  it('per-target limits isolate targets', () => {
    const trips: TripEvent[] = [];
    const { store, breaker } = setup(
      'per-target',
      { maxConsecutiveReverts: 100, perTarget: [{ to: POOL_A, selector: SWAP, maxConsecutiveReverts: 2 }] },
      (ev) => trips.push(ev),
    );
    breaker.recordResult(seed(store, { to: POOL_A, selector: SWAP, verdict: 'refused_doomed', nonce: 1 }));
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
    breaker.recordResult(seed(store, { to: POOL_A, selector: SWAP, verdict: 'refused_doomed', nonce: 2 }));

    const blockedA = breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP });
    expect(blockedA.allow).toBe(false);
    expect(blockedA.target).toBe(targetKey(POOL_A, SWAP));
    expect(breaker.state(WALLET).tripped).toBe(false); // the wallet is not halted
    expect(breaker.check({ wallet: WALLET, to: POOL_B, data: SWAP }).allow).toBe(true);
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: '0xdeadbeef' }).allow).toBe(true);
    expect(trips.map((t) => t.scope)).toEqual(['target']);

    breaker.reset(WALLET, { target: targetKey(POOL_A, SWAP) });
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
  });

  it('the hourly burn window rolls off by timestamp', () => {
    const root = tmpRoot('burn');
    const limit = (BigInt(BURN_PER_FAIL) * 3n).toString(10);
    savePolicy(parsePolicy({ maxConsecutiveReverts: 100, maxBurnPerHourWei: limit }), { root });
    const store = new ReceiptStore({ root, chainId: CHAIN });
    let now = new Date('2026-10-07T12:00:00.000Z');
    const breaker = new Breaker({ root, chainId: CHAIN, receipts: store, now: () => now });

    // Three failures an hour and a half ago: real money, but outside the window.
    const old = new Date('2026-10-07T10:30:00.000Z');
    for (let i = 1; i <= 3; i++) breaker.recordResult(seed(store, { outcome: 'reverted', at: old, nonce: i }));
    expect(breaker.counters(WALLET).burnWei).toBe('0');
    expect(breaker.counters(WALLET).burnEvents).toEqual([]);
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);

    // The same three failures inside the window trip it.
    for (let i = 4; i <= 6; i++) breaker.recordResult(seed(store, { outcome: 'reverted', at: new Date('2026-10-07T11:50:00.000Z'), nonce: i }));
    expect(breaker.counters(WALLET).burnWei).toBe(limit);
    const blocked = breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toMatch(/wei burned on reverts/);

    // Let the clock run past the window: a rebuild from the log drops the events, and after an
    // explicit reset the breaker allows sends again.
    now = new Date('2026-10-07T13:30:00.000Z');
    expect(breaker.rebuild(WALLET).counters.burnWei).toBe('0');
    expect(breaker.reset(WALLET).tripped).toBe(false);
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP }).allow).toBe(true);
  });

  it('a wallet with no history is allowed and costs no simulation', () => {
    const { breaker } = setup('empty');
    expect(breaker.check({ wallet: WALLET, to: POOL_A, data: SWAP })).toEqual({ allow: true });
    expect(breaker.counters(WALLET).receiptsSeen).toBe(0);
  });
});
