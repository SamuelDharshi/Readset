// The engine's pure logic, tested WITHOUT a network.
//
// Everything here runs against either hand-stated inputs or `fixtures/failed-tx.json`, which is
// a real failed Monad mainnet transaction recorded once (tx, receipt, both prestate traces, the
// call tree and the target's bytecode). Recorded, not invented: the point of a fixture is that
// the bytes came off the chain.
//
// This file must never touch the network, so CI and a demo stay green when an RPC is slow.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PublicClient } from 'viem';
import {
  burnFacts,
  classifyResims,
  decodeRevert,
  emptyCounters,
  evaluateCounters,
  getTxBurn,
  parsePolicy,
  parsePrestate,
  scanBytecode,
  type Hex,
  type ResimAtK,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'failed-tx.json'), 'utf8'),
) as {
  hash: Hex;
  recordedAt: string;
  tx: Record<string, string>;
  receipt: Record<string, string>;
  prestate: Record<string, { storage?: Record<string, string> }>;
  prestateDiff: { pre: Record<string, unknown>; post: Record<string, unknown> };
  callTree: Record<string, unknown>;
  code: Hex;
};

/** A client that answers only from the fixture. Any unexpected call is a test failure. */
function recordedClient(): PublicClient {
  const answers: Record<string, unknown> = {
    eth_getTransactionByHash: FIXTURE.tx,
    eth_getTransactionReceipt: FIXTURE.receipt,
  };
  return {
    request: async ({ method }: { method: string }) => {
      if (!(method in answers)) throw new Error(`offline test tried to call ${method}`);
      return answers[method];
    },
  } as unknown as PublicClient;
}

describe('burn arithmetic (Monad charges the gas LIMIT)', () => {
  it('burn is gasLimit x price, not gasUsed x price', () => {
    const f = burnFacts({
      gasLimit: 300_000n,
      effectiveGasPrice: 102_000_000_000n,
      receiptGasUsed: 21_000n,
    });
    expect(f.burnedWei).toBe((300_000n * 102_000_000_000n).toString());
    expect(f.receiptGasUsedEqualsLimit).toBe(false);
  });

  it('the recorded receipt agrees the whole limit was charged', () => {
    const gasLimit = BigInt(FIXTURE.tx.gas!);
    const f = burnFacts({
      gasLimit,
      effectiveGasPrice: BigInt(FIXTURE.receipt.effectiveGasPrice!),
      receiptGasUsed: BigInt(FIXTURE.receipt.gasUsed!),
    });
    expect(f.receiptGasUsedEqualsLimit).toBe(true);
    expect(BigInt(f.burnedWei)).toBeGreaterThan(0n);
  });

  it('rejects negative input rather than producing a nonsense figure', () => {
    expect(() => burnFacts({ gasLimit: -1n, effectiveGasPrice: 1n, receiptGasUsed: 0n })).toThrow();
  });

  it('getTxBurn reads a recorded tx + receipt with no other RPC call', async () => {
    const b = await getTxBurn(recordedClient(), FIXTURE.hash);
    expect(b.status).toBe(0);
    expect(b.hash).toBe(FIXTURE.hash.toLowerCase());
    expect(b.gasLimit).toBe(BigInt(FIXTURE.tx.gas!));
    expect(b.burnedWei).toBe(b.gasLimit * b.effectiveGasPrice);
    expect(b.receiptGasUsedEqualsLimit).toBe(true);
    expect(b.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(b.from).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('getTxBurn refuses a string that is not a transaction hash', async () => {
    await expect(getTxBurn(recordedClient(), '0xdeadbeef' as Hex)).rejects.toThrow(/not a transaction hash/);
  });
});

describe('classify (which failures a gate could have caught)', () => {
  const at = (k: number, outcome: 'revert' | 'success' | 'funds'): ResimAtK => ({
    k,
    block: BigInt(1_000_000 - k),
    blockHash: `0x${k.toString().repeat(64).slice(0, 64)}` as Hex,
    outcome,
  });

  it('still reverting at N-3 is knowable', () => {
    const v = classifyResims([at(1, 'revert'), at(2, 'revert'), at(3, 'revert')]);
    expect(v.avoidableClass).toBe('knowable');
    expect(v.avoidable).toBe(true);
  });

  it('reverting only at N-1 is latency-sensitive, not knowable', () => {
    const v = classifyResims([at(1, 'revert'), at(2, 'success'), at(3, 'success')]);
    expect(v.avoidableClass).toBe('latency-sensitive');
  });

  it('clean at N-1 means the break came from inside its own block', () => {
    const v = classifyResims([at(1, 'success'), at(2, 'success'), at(3, 'success')]);
    expect(v.avoidableClass).toBe('same-block');
    expect(v.undetectableWithoutPendingFeed).toBe(true);
    expect(v.avoidable).toBe(false);
  });

  it('a funds/reserve refusal is never counted as avoidable', () => {
    // The engine answers 'unavoidable' here: from its point of view there was nothing to
    // avoid. The replay benchmark calls the same bucket 'excluded-funds'. Neither name is
    // changed — instead the PUBLIC surface normalises to 'excluded-funds' so that
    // "unavoidable" means exactly one thing to a reader: a same-block race.
    // That mapping lives in apps/web/lib/verdict.ts and is covered by test/verdict.test.ts.
    const v = classifyResims([at(1, 'funds'), at(2, 'funds'), at(3, 'funds')]);
    expect(v.avoidable).toBe(false);
    expect(v.avoidableClass).toBe('unavoidable');
    expect(v.rationale).toMatch(/funds|reserve/i);
  });
});

describe('revert decoding', () => {
  it('decodes Error(string)', () => {
    // abi.encodeWithSignature("Error(string)", "nope")
    const data =
      '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      '6e6f706500000000000000000000000000000000000000000000000000000000';
    const d = decodeRevert(data as Hex);
    expect(d.kind).toBe('error-string');
    expect(d.reason).toBe('nope');
  });

  it('decodes Panic(uint256) 0x11 as arithmetic overflow', () => {
    const data =
      '0x4e487b71' + '0000000000000000000000000000000000000000000000000000000000000011';
    const d = decodeRevert(data as Hex);
    expect(d.kind).toBe('panic');
    expect(d.reason?.toLowerCase()).toMatch(/overflow|arithmetic/);
  });

  it('keeps an unknown custom-error selector instead of guessing a meaning', () => {
    const d = decodeRevert('0xdeadbeef' as Hex);
    expect(d.kind).toBe('custom-error');
    expect(d.data?.startsWith('0xdeadbeef')).toBe(true);
  });

  it('empty revert data is reported as empty, not as success', () => {
    expect(decodeRevert('0x' as Hex).kind).toBe('empty');
    expect(decodeRevert(undefined).kind).toBe('none');
  });
});

describe('bytecode scan for time dependence', () => {
  it('finds TIMESTAMP and NUMBER as real opcodes', () => {
    // 0x42 TIMESTAMP, 0x43 NUMBER
    const r = scanBytecode('0x4243' as Hex);
    expect(r.timestamp).toBe(true);
    expect(r.number).toBe(true);
    expect(r.size).toBe(2);
  });

  it('does NOT flag 0x42 that is PUSH data rather than an opcode', () => {
    // PUSH1 0x42 — the 0x42 is an immediate, not an instruction.
    const r = scanBytecode('0x6042' as Hex);
    expect(r.timestamp).toBe(false);
  });

  it('skips a long PUSH32 immediate without tripping on bytes inside it', () => {
    const r = scanBytecode(('0x7f' + '42'.repeat(32) + '00') as Hex);
    expect(r.timestamp).toBe(false);
  });

  it('handles empty and malformed input without throwing', () => {
    expect(scanBytecode('0x' as Hex).timestamp).toBe(false);
    expect(scanBytecode('0x' as Hex).size).toBe(0);
    expect(scanBytecode(undefined).timestamp).toBe(false);
    expect(scanBytecode('0x60' as Hex).timestamp).toBe(false); // truncated PUSH
  });

  it('scans the recorded contract bytecode', () => {
    const r = scanBytecode(FIXTURE.code);
    expect(r.size).toBeGreaterThan(0);
    expect(typeof r.timestamp).toBe('boolean');
  });
});

describe('prestate parsing from the recorded traces', () => {
  it('non-diff mode yields the READ-ONLY footprint (K1: diff mode omits it)', () => {
    const parsed = parsePrestate(FIXTURE.prestate, { diffMode: false });
    expect(parsed.slots.length).toBeGreaterThan(0);
    for (const s of parsed.slots) {
      expect(s.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(s.slot).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('a REVERTED transaction has no net storage writes at all', () => {
    // This is the whole reason the engine has to look elsewhere for a cause: a failed
    // transaction changes no storage, so its own diff can never explain why it failed.
    // (Its sender's nonce and balance still change, which is account state, not storage.)
    const parsed = parsePrestate(FIXTURE.prestateDiff, { diffMode: true });
    expect(parsed.slots.filter((s) => s.written)).toEqual([]);
  });

  it('the diff footprint is a subset of the non-diff one', () => {
    const all = new Set(
      parsePrestate(FIXTURE.prestate, { diffMode: false }).slots.map((s) => `${s.address}:${s.slot}`),
    );
    const diff = parsePrestate(FIXTURE.prestateDiff, { diffMode: true }).slots;
    const missing = diff.filter((s) => !all.has(`${s.address}:${s.slot}`));
    expect(missing).toEqual([]);
  });
});

describe('breaker policy', () => {
  const W = '0x00000000000000000000000000000000000000aa' as Hex;

  it('does not halt below the threshold', () => {
    const p = parsePolicy({ maxConsecutiveReverts: 5 });
    const c = { ...emptyCounters(W), consecutiveReverts: 4 };
    expect(evaluateCounters(c, p)).toEqual([]);
  });

  it('halts at exactly the threshold, and says why', () => {
    const p = parsePolicy({ maxConsecutiveReverts: 5 });
    const c = { ...emptyCounters(W), consecutiveReverts: 5 };
    const v = evaluateCounters(c, p);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]!.reason).toMatch(/5 consecutive/);
  });

  it('halts on the hourly burn cap independently of the revert count', () => {
    const p = parsePolicy({ maxConsecutiveReverts: 100, maxBurnPerHourWei: '1000' });
    const c = { ...emptyCounters(W), consecutiveReverts: 1, burnWei: '1001' };
    expect(evaluateCounters(c, p).length).toBeGreaterThan(0);
  });

  it('a zero burn cap means unlimited, not "halt immediately"', () => {
    const p = parsePolicy({ maxConsecutiveReverts: 100, maxBurnPerHourWei: '0' });
    const c = { ...emptyCounters(W), consecutiveReverts: 1, burnWei: '999999999' };
    expect(evaluateCounters(c, p)).toEqual([]);
  });

  it('rejects an invalid policy instead of silently defaulting', () => {
    expect(() => parsePolicy({ maxConsecutiveReverts: 0 })).toThrow();
    expect(() => parsePolicy({ maxBurnPerHourWei: 'lots' })).toThrow();
  });
});
