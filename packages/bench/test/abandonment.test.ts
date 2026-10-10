// Pure-logic tests of the abandonment state machine, fed with REAL monadNewHeads frames captured from
// wss://rpc.monad.xyz (mainnet) and saved in fixtures/monad-newheads-mainnet.jsonl (one {recvMs,msg} per line).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Tracker, parseHead, type BlockRecord, type HeadEvent } from '../src/abandonment-logger.js';
import { analyze, wilson } from '../src/abandonment-report.js';

const lines = readFileSync(new URL('./fixtures/monad-newheads-mainnet.jsonl', import.meta.url), 'utf8').trim().split('\n');
const events: HeadEvent[] = [];
for (const l of lines) {
  const { recvMs, msg } = JSON.parse(l);
  const e = parseHead(JSON.stringify(msg), recvMs);
  if (e) events.push(e);
}

function run(evs: HeadEvent[]) {
  const out: BlockRecord[] = [];
  const t = new Tracker('fixture', (r) => out.push(r));
  for (const e of evs) t.ingest(e);
  t.flush();
  return { out, t };
}

describe('parseHead on real frames', () => {
  it('skips the subscription ack and parses every head', () => {
    expect(lines.length).toBeGreaterThan(100);
    expect(events.length).toBe(lines.length - 1);
    for (const e of events) {
      expect(['Proposed', 'Voted', 'Finalized', 'Verified']).toContain(e.commitState);
      expect(e.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(e.number).toBeGreaterThan(1e6);
    }
  });
  it('ignores non-JSON and non-subscription frames', () => {
    expect(parseHead('nope', 0)).toBeNull();
    expect(parseHead(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xabc' }), 0)).toBeNull();
  });
});

describe('Tracker on a real 25s capture', () => {
  const { out, t } = run(events);
  it('emits exactly one record per distinct block hash', () => {
    expect(new Set(out.map((r) => r.hash)).size).toBe(out.length);
    expect(out.length).toBe(new Set(events.map((e) => e.hash)).size);
    expect(t.counts.emitted).toBe(out.length);
  });
  it('finalized blocks that we saw proposed have a monotone Proposed<=Voted<=Finalized<=Verified timeline', () => {
    const full = out.filter((r) => r.outcome === 'finalized' && r.proposedAt !== undefined);
    expect(full.length).toBeGreaterThan(50);
    for (const r of full) {
      expect(r.proposedAt!).toBeLessThanOrEqual(r.votedAt ?? r.finalizedAt!);
      if (r.votedAt) expect(r.votedAt).toBeLessThanOrEqual(r.finalizedAt!);
      if (r.verifiedAt) expect(r.finalizedAt!).toBeLessThanOrEqual(r.verifiedAt);
    }
  });
  it('blocks first seen after Proposed are partial, never counted in the rate', () => {
    const partial = out.filter((r) => r.outcome === 'partial');
    expect(partial.length).toBeGreaterThan(0);
    for (const r of partial) expect(r.proposedAt).toBeUndefined();
  });
  it('heights at the tail that never finalized in the window are unresolved, not abandoned', () => {
    for (const r of out.filter((x) => x.outcome === 'unresolved')) expect(r.finalizedAt).toBeUndefined();
    expect(out.filter((r) => r.outcome === 'abandoned').length).toBe(0); // true for this capture: one hash per height
  });
  it('is deterministic and order-preserving for the same input', () => {
    expect(run(events).out).toEqual(out);
  });
});

describe('report maths', () => {
  it('wilson interval brackets the point estimate and handles 0 events', () => {
    const w = wilson(0, 1000);
    expect(w.lo).toBe(0);
    expect(w.hi).toBeGreaterThan(0.003);
    expect(w.hi).toBeLessThan(0.005);
    const m = wilson(5, 100);
    expect(m.lo).toBeLessThan(0.05);
    expect(m.hi).toBeGreaterThan(0.05);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
  it('analyze() over tracker output reports latencies', () => {
    const { out } = run(events);
    const r = analyze(out.map((x) => JSON.stringify(x)));
    expect(r.abandoned).toBe(0);
    expect(r.finalized).toBeGreaterThan(50);
    expect(r.latencyMs.proposed_to_finalized.n).toBeGreaterThan(50);
  });
});
