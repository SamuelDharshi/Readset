// Reads .readset/abandonment/<network>.jsonl and reports abandonment rate (Wilson 95% CI) and latency distributions.
// Usage: npx tsx packages/bench/src/abandonment-report.ts [file] [--json]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BlockRecord } from './abandonment-logger.js';

export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function quantiles(xs: number[]) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

export function analyze(lines: string[]) {
  const blocks: BlockRecord[] = [];
  let sessions = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.t === 'block') blocks.push(r);
    if (r.t === 'session_start') sessions++;
  }
  const by = (o: string) => blocks.filter((b) => b.outcome === o);
  const fin = by('finalized');
  const ab = by('abandoned');
  const n = fin.length + ab.length;
  const d = (xs: BlockRecord[], a: 'proposedAt' | 'votedAt' | 'finalizedAt', b: 'votedAt' | 'finalizedAt' | 'verifiedAt') =>
    xs.filter((x) => x[a] !== undefined && x[b] !== undefined).map((x) => (x[b] as number) - (x[a] as number));
  const nums = blocks.map((b) => b.number);
  return {
    sessions,
    blocksLogged: blocks.length,
    heightRange: nums.length ? [Math.min(...nums), Math.max(...nums)] : null,
    finalized: fin.length,
    abandoned: ab.length,
    unresolved: by('unresolved').length,
    partial: by('partial').length,
    abandonmentRate: n ? ab.length / n : null,
    wilson95: wilson(ab.length, n),
    denominator: n,
    latencyMs: {
      proposed_to_voted: quantiles(d(fin, 'proposedAt', 'votedAt')),
      voted_to_finalized: quantiles(d(fin, 'votedAt', 'finalizedAt')),
      proposed_to_finalized: quantiles(d(fin, 'proposedAt', 'finalizedAt')),
      finalized_to_verified: quantiles(d(fin, 'finalizedAt', 'verifiedAt')),
    },
    abandonedSamples: ab.slice(0, 5),
    note: 'Latencies are local receive-time deltas on one websocket (include network jitter). Denominator = blocks first seen as Proposed that either finalized or were superseded; unresolved/partial excluded.',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--')) ?? '.readset/abandonment/mainnet.jsonl';
  const r = analyze(readFileSync(file, 'utf8').split('\n'));
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`file: ${file}\nsessions=${r.sessions} blocks=${r.blocksLogged} heights=${r.heightRange?.join('..')}`);
    console.log(`finalized=${r.finalized} abandoned=${r.abandoned} unresolved=${r.unresolved} partial=${r.partial}`);
    const p = (x: number) => (x * 100).toFixed(4) + '%';
    console.log(`abandonment rate = ${r.abandonmentRate === null ? 'n/a' : p(r.abandonmentRate)} of ${r.denominator} (Wilson 95%: ${p(r.wilson95.lo)} .. ${p(r.wilson95.hi)})`);
    for (const [k, v] of Object.entries(r.latencyMs)) console.log(`${k}:`, JSON.stringify(v, (_, x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x)));
    if (r.abandonedSamples.length) console.log('abandoned samples:', JSON.stringify(r.abandonedSamples, null, 1));
  }
}
