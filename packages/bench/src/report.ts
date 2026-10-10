// Aggregation and reporting for the replay benchmark (K2).
// Pure functions over the rows produced by replay.ts: no RPC, no I/O except the two writers at the bottom.
//
// Two interval estimators, because the two questions are different:
//   wilson()    - 95% Wilson score interval for a binomial COUNT proportion (share of transactions).
//   bootstrapCI - 95% percentile interval from a CLUSTER bootstrap over sampled BLOCKS, for BURN-weighted
//                 shares. Burn is heavily skewed and our primary sampling unit is the block, so resampling
//                 blocks (not transactions) is the honest interval for "share of MON burned".

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FailedReplayRow, ReplayClass, RunResult, SuccessReplayRow } from './replay.js';

export const WEI_PER_MON = 10n ** 18n;
export const toMon = (wei: bigint | string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/** 95% Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.959964): Interval & { k: number; n: number } {
  if (n === 0) return { point: 0, lo: 0, hi: 0, k, n };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { point: p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d), k, n };
}

interface Cluster {
  num: number;
  den: number;
}

/** Percentile bootstrap of a ratio sum(num)/sum(den) over independent clusters (blocks). Deterministic. */
export function bootstrapCI(clusters: Cluster[], reps = 2000, seed = 1): Interval {
  const den0 = clusters.reduce((a, c) => a + c.den, 0);
  const num0 = clusters.reduce((a, c) => a + c.num, 0);
  const point = den0 > 0 ? num0 / den0 : 0;
  if (clusters.length < 2 || den0 === 0) return { point, lo: point, hi: point };
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const m = clusters.length;
  const out: number[] = [];
  for (let r = 0; r < reps; r++) {
    let n = 0;
    let d = 0;
    for (let i = 0; i < m; i++) {
      const c = clusters[Math.floor(rand() * m)]!;
      n += c.num;
      d += c.den;
    }
    if (d > 0) out.push(n / d);
  }
  out.sort((a, b) => a - b);
  const q = (p: number) => out[Math.min(out.length - 1, Math.max(0, Math.floor(p * out.length)))] ?? point;
  return { point, lo: q(0.025), hi: q(0.975) };
}

// ---------------------------------------------------------------- aggregation

export interface ShareMetric {
  /** share of transactions (Wilson 95%) */
  byCount: Interval & { k: number; n: number };
  /** share of burned MON (cluster bootstrap 95% over sampled blocks) */
  byBurn: Interval;
  burnMON: number;
  totalBurnMON: number;
}

export interface ReplayReport {
  design: RunResult['design'] & { generatedAt: string };
  sample: {
    failedN: number;
    successfulN: number;
    blocks: number;
    failedBurnMON: number;
    /** sum of gas limits in the successful sample (we do not spend an RPC call per successful tx to read its receipt) */
    successfulGasLimit: number;
    harvest: RunResult['harvest'];
    /** failed txs we could not fully re-simulate at all three depths */
    incomplete: number;
    /**
     * Rows that reverted at N-3 but were CLEAN at N-1. The PRD defines `knowable` as "reverts at N-3", and these
     * rows satisfy it, but a gate simulating at `latest` would NOT have caught them. Reported so the
     * non-monotonicity is visible instead of being hidden inside the class label.
     */
    nonMonotoneN3CleanAtN1: number;
  };
  /** headline (a): share of revert burn that was already knowable k blocks before inclusion */
  knowable: {
    /** denominator = ALL sampled revert burn */
    ofAllBurn: { 'N-1': ShareMetric; 'N-2': ShareMetric; 'N-3': ShareMetric };
    /** denominator = revert burn excluding sender-funds / reserve-balance reverts (the PRD's "avoidable" base) */
    ofEligibleBurn: { 'N-1': ShareMetric; 'N-2': ShareMetric; 'N-3': ShareMetric };
  };
  classes: Record<ReplayClass, { count: number; shareOfCount: Interval & { k: number; n: number }; burnMON: number; shareOfBurn: Interval }>;
  /** headline (b): false blocks on an equal-size sample of SUCCESSFUL sends */
  falseBlocks: {
    rate: Interval & { k: number; n: number };
    /** excluding sends whose sender had an earlier tx in the same block (stale own-state at N-1) */
    rateExclSelfOrdered: Interval & { k: number; n: number };
    /** counting sender-funds / reserve-balance refusals as blocks too (upper bound) */
    rateInclFundsRefusals: Interval & { k: number; n: number };
    /**
     * Gas-limit-weighted rate (cluster bootstrap over blocks): how much of the work a gate would have refused.
     * We weight by gas LIMIT, not fee, because reading an effective gas price for every successful send would
     * cost one extra RPC call each and the public archive budget is better spent on re-simulations.
     */
    byGasLimit: Interval;
    unmeasurable: number;
    examples: { hash: string; reason: string; selfOrdered: boolean; verifiedStatus?: string }[];
  };
  excluded: ShareMetric;
  sameBlock: ShareMetric;
  oracleCrossCheck: { n: number; agree: number; agreementRate: number; disagree: RunResult['crossCheck']['disagree'] };
  targets: {
    'knowable>=30% at N-1': { target: number; actual: number; lo: number; met: boolean };
    'knowable>=25% at N-3': { target: number; actual: number; lo: number; met: boolean };
    'false blocks <1%': { target: number; actual: number; hi: number; met: boolean };
    k2Verdict: 'PASS' | 'FAIL' | 'PARTIAL';
  };
  topKnowableTargets: { to: string | null; selector: string | null; count: number; burnMON: number }[];
}

const CLASSES: ReplayClass[] = ['knowable', 'latency-sensitive', 'same-block', 'unavoidable', 'excluded-funds'];

/** Group rows into block clusters for the bootstrap. */
function clustersBy<T>(rows: T[], blockOf: (r: T) => number, num: (r: T) => number, den: (r: T) => number): Cluster[] {
  const m = new Map<number, Cluster>();
  for (const r of rows) {
    const b = blockOf(r);
    const c = m.get(b) ?? { num: 0, den: 0 };
    c.num += num(r);
    c.den += den(r);
    m.set(b, c);
  }
  return [...m.values()];
}

function shareMetric(rows: FailedReplayRow[], hit: (r: FailedReplayRow) => boolean, eligible: (r: FailedReplayRow) => boolean = () => true, bootSeed = 1): ShareMetric {
  const base = rows.filter(eligible);
  const k = base.filter(hit).length;
  const burnHit = base.filter(hit).reduce((a, r) => a + toMon(r.burnWei), 0);
  const burnAll = base.reduce((a, r) => a + toMon(r.burnWei), 0);
  return {
    byCount: wilson(k, base.length),
    byBurn: bootstrapCI(
      clustersBy(base, (r) => r.blockNumber, (r) => (hit(r) ? toMon(r.burnWei) : 0), (r) => toMon(r.burnWei)),
      2000,
      bootSeed,
    ),
    burnMON: burnHit,
    totalBurnMON: burnAll,
  };
}

export function buildReport(run: RunResult): ReplayReport {
  const failed = run.failed;
  const successful = run.successful;
  const notFunds = (r: FailedReplayRow) => !r.funds;

  const rev = (k: 1 | 2 | 3) => (r: FailedReplayRow) => (k === 1 ? r.revertsAtN1 : k === 2 ? r.revertsAtN2 : r.revertsAtN3) === true && !r.funds;

  const ofAll = {
    'N-1': shareMetric(failed, rev(1), undefined, 11),
    'N-2': shareMetric(failed, rev(2), undefined, 12),
    'N-3': shareMetric(failed, rev(3), undefined, 13),
  };
  const ofEligible = {
    'N-1': shareMetric(failed, rev(1), notFunds, 21),
    'N-2': shareMetric(failed, rev(2), notFunds, 22),
    'N-3': shareMetric(failed, rev(3), notFunds, 23),
  };

  const classes = Object.fromEntries(
    CLASSES.map((c, i) => {
      const m = shareMetric(failed, (r) => r.class === c, undefined, 31 + i);
      return [c, { count: m.byCount.k, shareOfCount: m.byCount, burnMON: m.burnMON, shareOfBurn: m.byBurn }];
    }),
  ) as ReplayReport['classes'];

  const fbK = successful.filter((r) => r.falseBlock).length;
  const fbMeasured = successful.filter((r) => r.revertsAtN1 !== null);
  const clean = fbMeasured.filter((r) => !r.selfOrdered);
  const falseBlocks: ReplayReport['falseBlocks'] = {
    rate: wilson(fbK, fbMeasured.length),
    rateExclSelfOrdered: wilson(clean.filter((r) => r.falseBlock).length, clean.length),
    rateInclFundsRefusals: wilson(fbMeasured.filter((r) => r.revertsAtN1 === true).length, fbMeasured.length),
    byGasLimit: bootstrapCI(
      clustersBy(fbMeasured, (r) => r.blockNumber, (r) => (r.falseBlock ? Number(r.gasLimit) : 0), (r) => Number(r.gasLimit)),
      2000,
      41,
    ),
    unmeasurable: successful.length - fbMeasured.length,
    examples: successful
      .filter((r) => r.revertsAtN1 === true)
      .slice(0, 25)
      .map((r) => ({ hash: r.hash, reason: r.reason, selfOrdered: r.selfOrdered, verifiedStatus: r.verifiedStatus })),
  };

  // top (to, selector) pairs among knowable burn: what a gate would actually have stopped
  const byTarget = new Map<string, { to: string | null; selector: string | null; count: number; burnMON: number }>();
  for (const r of failed) {
    if (r.class !== 'knowable') continue;
    const key = `${r.to}|${r.selector}`;
    const e = byTarget.get(key) ?? { to: r.to, selector: r.selector, count: 0, burnMON: 0 };
    e.count++;
    e.burnMON += toMon(r.burnWei);
    byTarget.set(key, e);
  }

  const n1 = ofAll['N-1'].byBurn;
  const n3 = ofAll['N-3'].byBurn;
  const fb = falseBlocks.rate;
  const metN1 = n1.point >= 0.3;
  const metN3 = n3.point >= 0.25;
  const metFB = fb.point < 0.01;

  return {
    design: { ...run.design, generatedAt: new Date().toISOString() },
    sample: {
      failedN: failed.length,
      successfulN: successful.length,
      blocks: run.harvest.blocks,
      failedBurnMON: failed.reduce((a, r) => a + toMon(r.burnWei), 0),
      successfulGasLimit: successful.reduce((a, r) => a + Number(r.gasLimit), 0),
      harvest: run.harvest,
      incomplete: failed.filter((r) => r.incomplete).length,
      nonMonotoneN3CleanAtN1: failed.filter((r) => r.revertsAtN3 === true && r.revertsAtN1 === false && !r.funds).length,
    },
    knowable: { ofAllBurn: ofAll, ofEligibleBurn: ofEligible },
    classes,
    falseBlocks,
    excluded: shareMetric(failed, (r) => r.funds, undefined, 51),
    sameBlock: shareMetric(failed, (r) => r.class === 'same-block', undefined, 52),
    oracleCrossCheck: {
      n: run.crossCheck.n,
      agree: run.crossCheck.agree,
      agreementRate: run.crossCheck.n ? run.crossCheck.agree / run.crossCheck.n : 0,
      disagree: run.crossCheck.disagree,
    },
    targets: {
      'knowable>=30% at N-1': { target: 0.3, actual: n1.point, lo: n1.lo, met: metN1 },
      'knowable>=25% at N-3': { target: 0.25, actual: n3.point, lo: n3.lo, met: metN3 },
      'false blocks <1%': { target: 0.01, actual: fb.point, hi: fb.hi, met: metFB },
      k2Verdict: metN3 && metFB ? (metN1 ? 'PASS' : 'PARTIAL') : metN3 || metN1 ? 'PARTIAL' : 'FAIL',
    },
    topKnowableTargets: [...byTarget.values()].sort((a, b) => b.burnMON - a.burnMON).slice(0, 10),
  };
}

// ---------------------------------------------------------------- writers

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const ci = (i: Interval) => `${pct(i.point)} (95% CI ${pct(i.lo)}-${pct(i.hi)})`;
const mon = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function writeResultJson(report: ReplayReport, rows: { failed: FailedReplayRow[]; successful: SuccessReplayRow[] }, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.design.generatedAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}.json`);
  writeFileSync(file, JSON.stringify({ ...report, rows }, null, 2));
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({ ...report, rows }, null, 2));
  return file;
}

export function renderMarkdown(r: ReplayReport, resultFile: string): string {
  const d = r.design;
  const days = d.frameTimestamps ? ((d.frameTimestamps.to - d.frameTimestamps.from) / 86400).toFixed(1) : '~29.9';
  const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : 'n/a');
  const L: string[] = [];

  L.push('# Replay benchmark (K2): how much Monad revert burn was knowable before sending?');
  L.push('');
  L.push(
    `Real Monad **mainnet** (chain 143) transactions only. Nothing on this page is simulated data, a fork or an estimate: ` +
      `every row is a live re-execution of a real transaction against real archived state. Generated ${d.generatedAt} by ` +
      '`npx tsx scripts/replay-benchmark.ts`. Raw rows: `' +
      resultFile.replace(/\\/g, '/').replace(/^.*\/results\//, 'results/') +
      '` (and `results/replay/latest.json`).',
  );
  L.push('');
  L.push('## Headline');
  L.push('');
  L.push('| Metric | PRD target | Measured | Met? |');
  L.push('|---|---|---|---|');
  const t = r.targets;
  L.push(`| Revert **burn** knowable at N-1 | >=30% | ${ci(r.knowable.ofAllBurn['N-1'].byBurn)} | ${t['knowable>=30% at N-1'].met ? 'YES' : 'NO'} |`);
  L.push(`| Revert **burn** knowable at N-3 | >=25% | ${ci(r.knowable.ofAllBurn['N-3'].byBurn)} | ${t['knowable>=25% at N-3'].met ? 'YES' : 'NO'} |`);
  L.push(`| False blocks on successful sends | <1% | ${ci(r.falseBlocks.rate)} | ${t['false blocks <1%'].met ? 'YES' : 'NO'} |`);
  L.push('');
  L.push(`**K2 verdict: ${t.k2Verdict}.**`);
  L.push('');
  L.push(
    `n = ${r.sample.failedN} failed transactions (${mon(r.sample.failedBurnMON)} MON of real burn) and ` +
      `${r.sample.successfulN} successful transactions, drawn from ${r.sample.blocks} randomly sampled blocks.`,
  );
  L.push('');

  L.push('## Sampling frame, seed and windows');
  L.push('');
  L.push(`- **Frame:** every user transaction mined in Monad mainnet blocks **${d.frame.fromBlock.toLocaleString('en-US')} – ${d.frame.toBlock.toLocaleString('en-US')}** ` +
    `(${(d.frame.toBlock - d.frame.fromBlock + 1).toLocaleString('en-US')} blocks, ${days} days: ${iso(d.frameTimestamps?.from)} to ${iso(d.frameTimestamps?.to)}). ` +
    'This is the same 30-day, grid-aligned window as the failed-transaction index (`results/k2-sample.json`), so the burn denominators line up. ' +
    'Monad system/staking syscalls (gas limit 0) are not user sends and are excluded.');
  L.push(`- **Primary sampling unit: the block.** ${d.blocksRequested} distinct block numbers were drawn uniformly at random without replacement from the frame ` +
    `with seed **${d.seed}** (mulberry32, the same generator and seed convention as \`scripts/k2-sample.ts\`). ${d.blocksHarvested} were harvested successfully.`);
  L.push('- **Failed sample:** *every* failed transaction in each sampled block, taken from the cached SQD `monad-mainnet` index ' +
    '(`.readset/cache/failed/sqd/*.jsonl.gz`, built by `packages/bench/src/failed-index.ts`). Burn per failure = `gasLimit x effectiveGasPrice`, ' +
    'because Monad charges the gas limit (verified on 12 real failures in `docs/facts.md`).');
  L.push(`- **Successful sample:** ${d.successPerBlock} successful transaction per sampled block, drawn uniformly at random *inside* the block with a ` +
    'per-block seed derived from the run seed, then randomly trimmed to exactly the size of the failed sample. Same blocks, same frame, same seed: ' +
    'the two samples are directly comparable.');
  L.push('- **Reproducible:** the seed fixes the block list, the within-block successful draw and the bootstrap. Re-running the command reproduces ' +
    'the identical sample; the JSONL checkpoint under `.readset/replay/` makes a partial run resumable without re-drawing.');
  L.push('');

  L.push('## Method');
  L.push('');
  L.push(`For a transaction that failed in block N, the **exact same call** (\`from\`, \`to\`, \`data\`, \`value\`, \`gas\`) is re-executed against committed ` +
    'state at **N-1, N-2 and N-3**, each pinned by **block hash** via EIP-1898 (kill test K1 verified that Monad accepts a historical block number ' +
    'and a block hash on these endpoints). A revert at N-k means the state that doomed the transaction had already moved k blocks before it landed, ' +
    'so a gate that simulated at `latest` would have refused it.');
  L.push('');
  L.push(`- **Oracle:** \`eth_call\` at the pinned block hash, which is exactly what a client-side gate does (viem's \`estimateGas\`/\`simulateContract\` path). ` +
    `Cross-checked against \`debug_traceCall\` + \`callTracer\` on a seeded subsample of ${r.oracleCrossCheck.n} rows: ` +
    `**${pct(r.oracleCrossCheck.agreementRate)} agreement** (${r.oracleCrossCheck.agree}/${r.oracleCrossCheck.n}).`);
  L.push(`- **Endpoints:** ${d.endpoints.join(', ')} — the only free Monad mainnet endpoints that are full archive *and* allow \`debug_*\` (K1). ` +
    `Round-robin with failover, globally rate-limited to ${d.rps} requests/second (under the 10 rps self-imposed cap; documented public caps are 15-25 rps). ` +
    `${d.rpcCalls.toLocaleString('en-US')} RPC calls in ${(d.wallMs / 60000).toFixed(1)} minutes of wall time.`);
  L.push('- **Reserve balance / insufficient funds** re-simulation failures are classified `excluded-funds` and removed from the "avoidable" numerator, ' +
    'as the PRD requires. They are reported as their own share so nothing is hidden.');
  L.push('');

  L.push('### Classes');
  L.push('');
  L.push('| Class | Meaning |');
  L.push('|---|---|');
  L.push('| `knowable` | already reverting at **N-3**: a gate catches it even with a 3-block-stale simulation |');
  L.push('| `latency-sensitive` | clean at N-3, reverting at N-2 or N-1: only a simulation immediately before signing catches it |');
  L.push('| `same-block` | clean at N-1, N-2 and N-3: whatever doomed it moved inside block N. Monad has no pending-transaction feed, so **no client-side gate can catch this** |');
  L.push('| `unavoidable` | clean at N-1 but the sender had an earlier transaction in block N, so state at N-1 is not what the transaction actually saw; or N-1 could not be re-simulated |');
  L.push('| `excluded-funds` | sender funds / Monad reserve-balance condition; excluded from "avoidable" per the PRD |');
  L.push('');

  L.push('## Results');
  L.push('');
  L.push('### (a) Knowable share of revert burn');
  L.push('');
  L.push('Denominator: all sampled revert burn. Burn shares use a 95% percentile **cluster bootstrap over sampled blocks** (2,000 resamples); ' +
    'count shares use the 95% **Wilson** score interval. Burn is the metric the PRD targets; the count share is shown next to it because they differ a lot.');
  L.push('');
  L.push('| Re-simulated at | Share of burn (95% CI) | Burn (MON) | Share of txs (Wilson 95%) |');
  L.push('|---|---|---|---|');
  for (const k of ['N-1', 'N-2', 'N-3'] as const) {
    const m = r.knowable.ofAllBurn[k];
    L.push(`| ${k} | ${ci(m.byBurn)} | ${mon(m.burnMON)} of ${mon(m.totalBurnMON)} | ${ci(m.byCount)} (${m.byCount.k}/${m.byCount.n}) |`);
  }
  L.push('');
  L.push('Excluding sender-funds / reserve-balance reverts from the denominator as well (the PRD\'s strict "avoidable" base):');
  L.push('');
  L.push('| Re-simulated at | Share of eligible burn (95% CI) | Share of eligible txs (Wilson 95%) |');
  L.push('|---|---|---|');
  for (const k of ['N-1', 'N-2', 'N-3'] as const) {
    const m = r.knowable.ofEligibleBurn[k];
    L.push(`| ${k} | ${ci(m.byBurn)} | ${ci(m.byCount)} (${m.byCount.k}/${m.byCount.n}) |`);
  }
  L.push('');

  L.push(`The three depths are measured **independently**, and the result is not perfectly monotone: ${r.sample.nonMonotoneN3CleanAtN1} of ` +
    `${r.sample.failedN} failed transactions reverted at N-3 but were clean again at N-1 (state moved back). ` +
    'They satisfy the PRD\'s definition of `knowable` ("reverts at N-3") but a gate simulating at `latest` would not have caught them, ' +
    'which is why the N-1 column, not the class label, is the number to quote for what Readset actually stops. ' +
    `${r.sample.incomplete} rows could not be re-simulated at all three depths.`);
  L.push('');
  L.push('### Class distribution');
  L.push('');
  L.push('| Class | Txs | Share of txs (Wilson 95%) | Burn (MON) | Share of burn (95% CI) |');
  L.push('|---|---|---|---|---|');
  for (const c of CLASSES) {
    const x = r.classes[c];
    L.push(`| \`${c}\` | ${x.count} | ${ci(x.shareOfCount)} | ${mon(x.burnMON)} | ${ci(x.shareOfBurn)} |`);
  }
  L.push('');
  L.push(`**The share we cannot catch:** \`same-block\` is ${ci(r.sameBlock.byBurn)} of revert burn by burn and ` +
    `${ci(r.sameBlock.byCount)} by transaction count. Monad accepts a \`newPendingTransactions\` subscription but never emits on it ` +
    '(`docs/facts.md` #7), so this share is invisible to any client-side guard, including Readset. ' +
    `**Excluded (funds / reserve balance):** ${ci(r.excluded.byBurn)} of burn, ${ci(r.excluded.byCount)} of transactions.`);
  L.push('');

  L.push('### (b) False blocks');
  L.push('');
  L.push(`On an equal-size sample of transactions that actually **succeeded** on chain, re-simulated at N-1: a revert there is a transaction ` +
    'Readset would have wrongly refused. Every candidate false block had its receipt re-read on chain to confirm the transaction really succeeded.');
  L.push('');
  L.push('| Measure | Rate (Wilson 95%) |');
  L.push('|---|---|');
  L.push(`| False-block rate (headline) | ${ci(r.falseBlocks.rate)} (${r.falseBlocks.rate.k}/${r.falseBlocks.rate.n}) |`);
  L.push(`| Excluding sends whose sender had an earlier tx in the same block | ${ci(r.falseBlocks.rateExclSelfOrdered)} (${r.falseBlocks.rateExclSelfOrdered.k}/${r.falseBlocks.rateExclSelfOrdered.n}) |`);
  L.push(`| Upper bound: counting funds / reserve-balance refusals too | ${ci(r.falseBlocks.rateInclFundsRefusals)} (${r.falseBlocks.rateInclFundsRefusals.k}/${r.falseBlocks.rateInclFundsRefusals.n}) |`);
  L.push(`| Gas-limit-weighted (cluster bootstrap) | ${ci(r.falseBlocks.byGasLimit)} |`);
  L.push('');
  if (r.falseBlocks.unmeasurable) L.push(`${r.falseBlocks.unmeasurable} successful sends could not be re-simulated and are outside both numerator and denominator.`);
  if (r.falseBlocks.examples.length) {
    L.push('');
    L.push('Every successful send that re-simulated as a revert at N-1:');
    L.push('');
    L.push('| Tx | Receipt re-check | Sender had an earlier tx in block N | Reason |');
    L.push('|---|---|---|---|');
    for (const e of r.falseBlocks.examples) L.push(`| \`${e.hash}\` | ${e.verifiedStatus ?? 'n/a'} | ${e.selfOrdered ? 'yes' : 'no'} | ${e.reason.replace(/\|/g, '\\|').slice(0, 180)} |`);
  }
  L.push('');

  if (r.topKnowableTargets.length) {
    L.push('### Where the knowable burn is');
    L.push('');
    L.push('| `to` | selector | knowable failures | burn (MON) |');
    L.push('|---|---|---|---|');
    for (const x of r.topKnowableTargets) L.push(`| \`${x.to ?? '(create)'}\` | \`${x.selector ?? '(none)'}\` | ${x.count} | ${mon(x.burnMON)} |`);
    L.push('');
  }

  L.push('## Limits (read these before quoting the numbers)');
  L.push('');
  L.push('1. **Re-simulating at N-1 approximates, but is not, the real pre-send moment.** A bot may have signed many blocks earlier, or microseconds ' +
    'before inclusion. N-1 is the closest *observable* proxy for "the last state a gate could have seen". It is an upper bound on what a ' +
    'gate simulating at `latest` sees, and a lower bound on what a gate simulating long before sending sees.');
  L.push('2. **`latest` on Monad is a Proposed block and can be abandoned.** Our N-1/N-2/N-3 states are finalized history; a live gate reads a block ' +
    'that may be rolled back. The abandonment rate is measured separately (`packages/bench/src/abandonment-report.ts`) and must be read next to the false-block rate.');
  L.push('3. **No pending-transaction feed.** Same-block races cannot be seen by any client-side guard; that share is reported above and is not claimed as savings.');
  L.push('4. **Self-ordering.** A transaction whose sender had an earlier transaction in the same block is re-simulated against stale own-state. ' +
    'Those rows are flagged, classed `unavoidable` on the failed side, and reported separately on the false-block side rather than silently counted.');
  L.push('5. **Gas is replayed as sent.** The gas limit from the original transaction is passed to the re-simulation, so an out-of-gas failure ' +
    'shows up as a revert and is counted as knowable. That is correct for this question (a gate would also have seen it) but it means the ' +
    '"knowable" bucket is not purely state races.');
  L.push('6. **Burn shares are cluster-bootstrapped over blocks, not Wilson.** Wilson assumes a binomial count; burn is a heavily skewed ' +
    'sum dominated by a few large-gas senders (the top-50 senders carry ~71% of burn, `results/k2-sample.json`), so the burn interval is wider and honest about that.');
  L.push('7. **One sampling frame, one chain.** Mainnet only, one 30-day window. Results will move with mainnet activity; re-run before quoting.');
  if (d.truncated) L.push('8. **This run was truncated by its wall-clock budget.** The achieved n is reported above; see "Scaling up" for the exact command.');
  L.push('');

  L.push('## Reproduce / scale up');
  L.push('');
  L.push('```sh');
  L.push('# exactly this run (resumes from .readset/replay/<run> if present)');
  L.push(`npx tsx scripts/replay-benchmark.ts --blocks ${d.blocksRequested} --seed ${d.seed} --rps ${d.rps}`);
  L.push('');
  L.push('# scale up: ~5 RPC calls per failed tx (2 block fetches amortised + 3 re-simulations) and 1 per successful tx.');
  L.push('# At 9 rps, wall time ~= (2 x blocks + 3 x failedTxs + successfulTxs) / 9 seconds.');
  L.push('npx tsx scripts/replay-benchmark.ts --blocks 3000 --budget-min 60   # ~2,500 failed txs, ~35 min');
  L.push('npx tsx scripts/replay-benchmark.ts --blocks 6000 --budget-min 150  # ~5,000 failed txs, ~70 min');
  L.push('```');
  L.push('');
  const perFailed = r.sample.failedN ? d.rpcCalls / r.sample.failedN : 0;
  L.push(`Observed cost for this run: ${d.rpcCalls.toLocaleString('en-US')} RPC calls for ${r.sample.failedN} failed + ${r.sample.successfulN} successful ` +
    `transactions (${perFailed.toFixed(1)} calls per failed tx), ${(d.wallMs / 60000).toFixed(1)} min at ${d.rps} rps. ` +
    `Reaching the PRD's 2,000 failed transactions needs about ${Math.ceil((2000 / Math.max(1, r.sample.failedN)) * d.blocksRequested)} sampled blocks, ` +
    `about ${((((2 * Math.ceil((2000 / Math.max(1, r.sample.failedN)) * d.blocksRequested)) + 3 * 2000 + 2000) / d.rps) / 60).toFixed(0)} minutes at ${d.rps} rps ` +
    '(linear, and resumable: the checkpoint means several short runs add up to one big sample). A paid archive key removes the rps cap and the ' +
    'whole 2,000-tx run finishes in a few minutes.');
  L.push('');
  return L.join('\n');
}

export function writeBenchmarkDoc(report: ReplayReport, resultFile: string, docPath: string): string {
  mkdirSync(path.dirname(docPath), { recursive: true });
  writeFileSync(docPath, renderMarkdown(report, resultFile) + '\n');
  return docPath;
}
