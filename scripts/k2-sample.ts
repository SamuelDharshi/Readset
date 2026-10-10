// K2 groundwork: stratified sample (default) or full 30-day pass over real Monad mainnet failed txs.
//   npx tsx scripts/k2-sample.ts            -> 200 stratified 1h-grid chunks, bootstrap CIs -> results/k2-sample.json (.sample)
//   npx tsx scripts/k2-sample.ts --full     -> every chunk of the last 30 days, exact numbers -> results/k2-sample.json (.full)
//   npx tsx scripts/k2-sample.ts --traces   -> trace sub-sample: out-of-gas share + hardcoded-gas proxy  (.traces)
// Env: K2_WINDOWS (200), K2_SEED (7), K2_CONC (3), K2_DAYS (30), K2_TRACE_N (300), K2_TRACE_RPS (8).
// Cache: .readset/cache (resumable).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ArchivePacer, DEFAULT_CHUNK, RunTracker, blockAtTimestamp, blockTimestamp, iterateFailedTxs, loadChunk, planChunks,
  resimGas, sqdHead, traceFailure, weiToMon,
  type FailedTx, type ChunkStats, type Hex,
} from '../packages/bench/src/failed-index.js';

const FULL = process.argv.includes('--full');
const TRACES = process.argv.includes('--traces');
const TRACE_N = Number(process.env.K2_TRACE_N ?? 300);
const TRACE_RPS = Number(process.env.K2_TRACE_RPS ?? 8);
const N_WIN = Number(process.env.K2_WINDOWS ?? 200);
const SEED = Number(process.env.K2_SEED ?? 7);
const CONC = Number(process.env.K2_CONC ?? 3);
const DAYS = Number(process.env.K2_DAYS ?? 30);
const OUT = path.resolve(import.meta.dirname, '..', 'results', 'k2-sample.json');

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const ci = (a: number[]) => ({ lo: pct(a, 0.025), hi: pct(a, 0.975) });

async function range() {
  // K2_RANGE=<from>-<to> pins the window so a published run is reproducible from cache alone (no head drift).
  if (process.env.K2_RANGE) {
    const [a, b] = process.env.K2_RANGE.split('-').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('K2_RANGE must be <fromBlock>-<toBlock>');
    return { startGrid: a, endGrid: b, endTs: await blockTimestamp(b).catch(() => 0) };
  }
  const { finalized } = await sqdHead();
  const endGrid = Math.floor((finalized + 1) / DEFAULT_CHUNK) * DEFAULT_CHUNK - 1; // last full grid chunk end
  const endTs = await blockTimestamp(endGrid);
  const start = await blockAtTimestamp(endTs - DAYS * 86400, endGrid);
  const startGrid = Math.ceil(start / DEFAULT_CHUNK) * DEFAULT_CHUNK;
  return { startGrid, endGrid, endTs };
}

function save(patch: Record<string, unknown>) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  writeFileSync(OUT, JSON.stringify({ ...old, ...patch }, null, 2));
}

interface Win {
  stats: ChunkStats; senderBurn: Map<string, number>; byTarget: Map<string, number>;
  burn: number; failed: number; user: number; total: number;
  loopBurn: number; loopAfter5: number; loopRuns: number; loopFailures: number;
}

function summarize(stats: ChunkStats, rows: FailedTx[]): Win {
  const rt = new RunTracker(10, 5);
  const senderBurn = new Map<string, number>(); const byTarget = new Map<string, number>();
  let burn = 0n;
  for (const r of rows) {
    rt.feed(r); burn += r.burnWei;
    const b = weiToMon(r.burnWei);
    senderBurn.set(r.from, (senderBurn.get(r.from) ?? 0) + b);
    const k = `${r.to}|${r.selector}`; byTarget.set(k, (byTarget.get(k) ?? 0) + b);
  }
  const runs = rt.finish();
  return {
    stats, senderBurn, byTarget, burn: weiToMon(burn), failed: rows.length, user: stats.userTxs, total: stats.totalTxs,
    loopBurn: weiToMon(runs.reduce((a, r) => a + r.burnWei, 0n)), loopAfter5: weiToMon(runs.reduce((a, r) => a + r.burnAfterBreakerWei, 0n)),
    loopRuns: runs.length, loopFailures: runs.reduce((a, r) => a + r.failures, 0),
  };
}

const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const sumTop = (m: Map<string, number>, n: number) => top(m, n).reduce((a, [, v]) => a + v, 0);

async function sample() {
  const { startGrid, endGrid, endTs } = await range();
  const all = planChunks(startGrid, endGrid, DEFAULT_CHUNK);
  const R = rng(SEED);
  const per = all.length / N_WIN;
  const picks = Array.from({ length: N_WIN }, (_, i) => all[Math.min(all.length - 1, Math.floor(i * per + R() * per))]);
  console.log(`range ${startGrid}-${endGrid}: ${all.length} chunks of ${DEFAULT_CHUNK}; sampling ${picks.length}`);
  const wins: Win[] = []; let done = 0;
  const queue = [...picks];
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (let p; (p = queue.shift()); ) {
      const r = await loadChunk(p[0], p[1], {});
      wins.push(summarize(r.stats, r.rows));
      if (++done % 10 === 0) console.log(`${done}/${picks.length}`);
    }
  }));
  wins.sort((a, b) => a.stats.fromBlock - b.stats.fromBlock);
  const scale = all.length / wins.length;
  const sum = (w: Win[], k: 'burn' | 'failed' | 'user' | 'total' | 'loopBurn' | 'loopAfter5' | 'loopRuns') => w.reduce((a, x) => a + x[k], 0);
  const B = 1000; const R2 = rng(SEED + 1);
  const boots = { failed: [] as number[], burn: [] as number[], rate: [] as number[], rateAll: [] as number[], loop: [] as number[], loop5: [] as number[], top50: [] as number[] };
  for (let b = 0; b < B; b++) {
    const s = Array.from({ length: wins.length }, () => wins[Math.floor(R2() * wins.length)]);
    boots.failed.push(sum(s, 'failed') * scale); boots.burn.push(sum(s, 'burn') * scale);
    boots.rate.push(sum(s, 'failed') / sum(s, 'user')); boots.rateAll.push(sum(s, 'failed') / sum(s, 'total'));
    boots.loop.push(sum(s, 'loopBurn') * scale); boots.loop5.push(sum(s, 'loopAfter5') * scale);
    if (b < 300) {
      const m = new Map<string, number>();
      for (const w of s) for (const [k, v] of w.senderBurn) m.set(k, (m.get(k) ?? 0) + v);
      boots.top50.push(sumTop(m, 50) / sum(s, 'burn'));
    }
  }
  const mAll = new Map<string, number>(); const tAll = new Map<string, number>();
  for (const w of wins) {
    for (const [k, v] of w.senderBurn) mAll.set(k, (mAll.get(k) ?? 0) + v);
    for (const [k, v] of w.byTarget) tAll.set(k, (tAll.get(k) ?? 0) + v);
  }
  const totalBurn = sum(wins, 'burn');
  const out = {
    generatedAt: new Date().toISOString(), source: 'sqd', dataset: 'monad-mainnet', chainId: 143,
    design: {
      days: DAYS, gridChunkBlocks: DEFAULT_CHUNK, totalChunks: all.length, sampledChunks: wins.length, seed: SEED,
      stratified: 'one random grid chunk per equal-width stratum of the 30d span',
      ci: '95% bootstrap over sampled chunks (stratification ignored, so slightly conservative)',
      rangeBlocks: [startGrid, endGrid], endTimestamp: endTs,
    },
    sampled: {
      blocks: wins.length * DEFAULT_CHUNK, totalTxs: sum(wins, 'total'), userTxs: sum(wins, 'user'), failedTxs: sum(wins, 'failed'),
      failedBurnMON: totalBurn, gasUsedNeGasLimitFailed: wins.reduce((a, w) => a + w.stats.gasUsedNeGasLimitFailed, 0),
    },
    estimate30d: {
      failedTxs: { point: sum(wins, 'failed') * scale, ...ci(boots.failed) },
      revertBurnMON: { point: totalBurn * scale, ...ci(boots.burn) },
      failureRateOfUserTxs: { point: sum(wins, 'failed') / sum(wins, 'user'), ...ci(boots.rate) },
      failureRateOfAllTxsInclSystem: { point: sum(wins, 'failed') / sum(wins, 'total'), ...ci(boots.rateAll) },
      top50SenderBurnShare: { point: sumTop(mAll, 50) / totalBurn, ...ci(boots.top50), note: 'top-50 chosen inside the sample; see caveats' },
      loopBurnRunsGE10MON: { point: sum(wins, 'loopBurn') * scale, ...ci(boots.loop), note: 'runs truncated at 1h chunk edges: lower bound' },
      loopBurnPreventedByBreaker5MON: { point: sum(wins, 'loopAfter5') * scale, ...ci(boots.loop5) },
      loopRunsGE10: sum(wins, 'loopRuns') * scale,
    },
    topSendersInSample: top(mAll, 10).map(([a, v]) => ({ sender: a, burnMON: v, shareOfSampleBurn: v / totalBurn })),
    topTargetsInSample: top(tAll, 10).map(([k, v]) => ({ toAndSelector: k, burnMON: v, share: v / totalBurn })),
    windows: wins.map((w) => ({ from: w.stats.fromBlock, to: w.stats.toBlock, ts: w.stats.timestampFrom, userTxs: w.user, failed: w.failed, burnMON: w.burn })),
  };
  save({ sample: out });
  console.log(JSON.stringify({ ...out, windows: undefined }, null, 2));
}

async function full() {
  const { startGrid, endGrid, endTs } = await range();
  const rt = new RunTracker(10, 5);
  const senderBurn = new Map<string, number>(); const byTarget = new Map<string, number>();
  const daily = new Map<string, { user: number; failed: number; burn: number }>();
  let user = 0, total = 0, failed = 0, burn = 0n, mismatch = 0, blocks = 0; let n = 0;
  const t0 = Date.now();
  for await (const c of iterateFailedTxs({ fromBlock: startGrid, toBlock: endGrid, concurrency: CONC })) {
    user += c.stats.userTxs; total += c.stats.totalTxs; failed += c.stats.failedTxs; mismatch += c.stats.gasUsedNeGasLimitFailed; blocks += c.stats.blocks;
    const day = new Date(c.stats.timestampFrom * 1000).toISOString().slice(0, 10);
    const d = daily.get(day) ?? { user: 0, failed: 0, burn: 0 };
    d.user += c.stats.userTxs; d.failed += c.stats.failedTxs; d.burn += weiToMon(c.stats.failedBurnWei); daily.set(day, d);
    for (const r of c.rows) {
      rt.feed(r); burn += r.burnWei;
      const b = weiToMon(r.burnWei);
      senderBurn.set(r.from, (senderBurn.get(r.from) ?? 0) + b);
      const k = `${r.to}|${r.selector}`; byTarget.set(k, (byTarget.get(k) ?? 0) + b);
    }
    if (++n % 20 === 0) console.log(`${n} chunks, ${((Date.now() - t0) / 1000).toFixed(0)}s, failed so far ${failed}`);
  }
  const runs = rt.finish().sort((a, b) => (b.burnWei > a.burnWei ? 1 : -1));
  const totalBurn = weiToMon(burn);
  const loopBurn = weiToMon(runs.reduce((a, r) => a + r.burnWei, 0n));
  const out = {
    generatedAt: new Date().toISOString(), source: 'sqd', rangeBlocks: [startGrid, endGrid], endTimestamp: endTs, blocks, days: DAYS,
    totalTxs: total, userTxs: user, failedTxs: failed, failureRateOfUserTxs: failed / user, failureRateOfAllTxsInclSystem: failed / total,
    revertBurnMON: totalBurn, gasUsedNeGasLimitFailed: mismatch, distinctFailingSenders: senderBurn.size,
    top50SenderBurnMON: sumTop(senderBurn, 50), top50SenderBurnShare: sumTop(senderBurn, 50) / totalBurn,
    top10SenderBurnShare: sumTop(senderBurn, 10) / totalBurn, top1000SenderBurnShare: sumTop(senderBurn, 1000) / totalBurn,
    topSenders: top(senderBurn, 50).map(([a, v]) => ({ sender: a, burnMON: v, share: v / totalBurn })),
    topTargets: top(byTarget, 25).map(([k, v]) => ({ toAndSelector: k, burnMON: v, share: v / totalBurn })),
    loops: {
      minRun: 10, breaker: 5, runs: runs.length, failuresInRuns: runs.reduce((a, r) => a + r.failures, 0),
      burnMON: loopBurn, burnShareOfRevertBurn: loopBurn / totalBurn,
      burnPreventedByBreaker5MON: weiToMon(runs.reduce((a, r) => a + r.burnAfterBreakerWei, 0n)),
      distinctSenders: new Set(runs.map((r) => r.from)).size,
      top20Runs: runs.slice(0, 20).map((r) => ({ ...r, burnWei: r.burnWei.toString(), burnAfterBreakerWei: r.burnAfterBreakerWei.toString(), burnMON: weiToMon(r.burnWei) })),
    },
    daily: [...daily.entries()].sort().map(([day, d]) => ({ day, ...d, rate: d.failed / d.user })),
    elapsedSec: (Date.now() - t0) / 1000,
  };
  save({ full: out });
  console.log(JSON.stringify({ ...out, daily: undefined, topSenders: out.topSenders.slice(0, 5) }, null, 2));
}

// ---------------------------------------------------------------- trace sub-sample (OOG + hardcoded-gas proxy)

interface TraceRow {
  hash: string; blockNumber: number; from: string; to: string | null; selector: string | null;
  gasLimit: string; burnWei: string;
  traceError: string | null; outOfGas: boolean; revertOutput: string | null;
  resimMode: string; resimGas: string | null; atParent: string; revertAtParent?: string; note?: string;
  rpcCalls: number;
}

const TRACE_CACHE = path.resolve(import.meta.dirname, '..', '.readset', 'cache', 'traces', 'k2-traces.jsonl');

function loadTraceCache(): Map<string, TraceRow> {
  const m = new Map<string, TraceRow>();
  if (!existsSync(TRACE_CACHE)) return m;
  for (const l of readFileSync(TRACE_CACHE, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l) as TraceRow; m.set(r.hash, r); } catch { /* truncated last line */ }
  }
  return m;
}

/** Stratified sub-sample of failed txs drawn from the already-cached 30-day chunks. */
async function traces() {
  const { startGrid, endGrid, endTs } = await range();
  const all = planChunks(startGrid, endGrid, DEFAULT_CHUNK);
  const strata = Math.min(60, all.length);
  const perChunk = Math.ceil(TRACE_N / strata);
  const R = rng(SEED + 2);
  const per = all.length / strata;
  const picks = Array.from({ length: strata }, (_, i) => all[Math.min(all.length - 1, Math.floor(i * per + R() * per))]);

  const pool: FailedTx[] = [];
  for (const [a, b] of picks) {
    const { rows } = await loadChunk(a, b, {});
    if (!rows.length) continue;
    const idx = new Set<number>();
    while (idx.size < Math.min(perChunk, rows.length)) idx.add(Math.floor(R() * rows.length));
    for (const i of idx) pool.push(rows[i]);
  }
  console.log(`trace sub-sample: ${pool.length} failed txs from ${picks.length} of ${all.length} 1h chunks (${startGrid}-${endGrid})`);

  const cache = loadTraceCache();
  mkdirSync(path.dirname(TRACE_CACHE), { recursive: true });
  const todo = pool.filter((r) => !cache.has(r.hash));
  console.log(`${pool.length - todo.length} cached, ${todo.length} to fetch`);

  const pacer = new ArchivePacer(undefined, TRACE_RPS);
  const queue = [...todo];
  let done = 0, errs = 0;
  const append = (r: TraceRow) => { cache.set(r.hash, r); writeFileSync(TRACE_CACHE, JSON.stringify(r) + '\n', { flag: 'a' }); };

  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let r; (r = queue.shift()); ) {
      try {
        const tx = await pacer.call<any>('eth_getTransactionByHash', [r.hash]);
        if (!tx) throw new Error('tx not found');
        const tr = await traceFailure(r.hash as Hex, pacer);
        const rg = await resimGas(
          { from: tx.from as Hex, to: (tx.to ?? null) as Hex | null, input: (tx.input ?? '0x') as Hex, value: (tx.value ?? '0x0') as Hex, gasLimit: BigInt(tx.gas) },
          r.blockNumber - 1, pacer,
        );
        append({
          hash: r.hash, blockNumber: r.blockNumber, from: r.from, to: r.to, selector: r.selector,
          gasLimit: r.gasLimit.toString(), burnWei: r.burnWei.toString(),
          traceError: tr.error, outOfGas: tr.outOfGas, revertOutput: tr.revertOutput,
          resimMode: rg.mode, resimGas: rg.gas?.toString() ?? null, atParent: rg.atParent,
          revertAtParent: rg.revertAtParent, note: rg.note, rpcCalls: rg.rpcCalls + 2,
        });
      } catch (e) {
        errs++;
        console.error(`  ${r.hash} failed: ${(e as Error).message.slice(0, 140)}`);
      }
      if (++done % 25 === 0) console.log(`${done}/${todo.length} (${errs} errors)`);
    }
  }));

  const rows = pool.map((r) => cache.get(r.hash)).filter((x): x is TraceRow => !!x);
  const burn = (r: TraceRow) => weiToMon(r.burnWei);
  const totalBurn = rows.reduce((a, r) => a + burn(r), 0);
  const shareBy = (f: (r: TraceRow) => boolean, pool_ = rows) => {
    const hit = pool_.filter(f);
    const pb = pool_.reduce((a, r) => a + burn(r), 0);
    return {
      count: hit.length, ofCount: pool_.length ? hit.length / pool_.length : 0,
      burnMON: hit.reduce((a, r) => a + burn(r), 0), ofBurn: pb ? hit.reduce((a, r) => a + burn(r), 0) / pb : 0,
      denomCount: pool_.length,
    };
  };
  const withResim = rows.filter((r) => r.resimGas !== null);
  const ratio = (r: TraceRow) => Number(BigInt(r.gasLimit)) / Number(BigInt(r.resimGas!));
  const ratios = withResim.map(ratio).sort((a, b) => a - b);
  // Cluster bootstrap over the sampled 1h chunks (rows inside one chunk are correlated: often the same bot).
  const clusters = new Map<number, TraceRow[]>();
  for (const r of rows) {
    const k = Math.floor(r.blockNumber / DEFAULT_CHUNK);
    (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(r);
  }
  const cl = [...clusters.values()];
  const RB = rng(SEED + 3);
  const bootCi = (f: (r: TraceRow) => boolean, keep: (r: TraceRow) => boolean) => {
    const byCount: number[] = [], byBurn: number[] = [];
    for (let b = 0; b < 1000; b++) {
      let n = 0, hit = 0, bw = 0, hbw = 0;
      for (let i = 0; i < cl.length; i++) {
        for (const r of cl[Math.floor(RB() * cl.length)]) {
          if (!keep(r)) continue;
          n++; bw += burn(r);
          if (f(r)) { hit++; hbw += burn(r); }
        }
      }
      if (n) byCount.push(hit / n);
      if (bw) byBurn.push(hbw / bw);
    }
    return { ofCountCi: ci(byCount), ofBurnCi: ci(byBurn), clusters: cl.length };
  };

  const byAtParent: Record<string, number> = {};
  for (const r of rows) byAtParent[r.atParent] = (byAtParent[r.atParent] ?? 0) + 1;
  const byMode: Record<string, number> = {};
  for (const r of rows) byMode[r.resimMode] = (byMode[r.resimMode] ?? 0) + 1;

  const out = {
    generatedAt: new Date().toISOString(), chainId: 143, endpoints: pacer.urls, rpcTarget: TRACE_RPS,
    design: {
      traced: rows.length, requested: pool.length, strata: picks.length, totalChunks: all.length,
      rangeBlocks: [startGrid, endGrid], endTimestamp: endTs, seed: SEED + 2,
      sampling: 'uniform over failed txs within 30 stratified 1h chunks; burn shares are ratio estimates weighted by each row\'s burnWei',
      resim: 'eth_estimateGas at the parent block; when the tx reverts there, gas-to-revert bisected with eth_call to 1% (upper bound, so gasLimit/resim is slightly understated)',
      errors: errs,
      rpcCalls: rows.reduce((a, r) => a + r.rpcCalls, 0),
    },
    outOfGas: { ...shareBy((r) => r.outOfGas), ...bootCi((r) => r.outOfGas, () => true) },
    traceErrorHistogram: Object.entries(rows.reduce<Record<string, number>>((a, r) => { const k = r.traceError ?? '(none)'; a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]),
    hardcodedGasProxy: {
      definition: 'failed tx whose gasLimit >= 2x its re-simulated gas at the parent block',
      resolved: withResim.length, unresolved: rows.length - withResim.length,
      ge2x: {
        ...shareBy((r) => r.resimGas !== null && ratio(r) >= 2, withResim),
        ...bootCi((r) => r.resimGas !== null && ratio(r) >= 2, (r) => r.resimGas !== null),
      },
      ge3x: shareBy((r) => r.resimGas !== null && ratio(r) >= 3, withResim),
      ge10x: shareBy((r) => r.resimGas !== null && ratio(r) >= 10, withResim),
      ratioPercentiles: ratios.length ? { p10: pct(ratios, 0.1), p25: pct(ratios, 0.25), p50: pct(ratios, 0.5), p75: pct(ratios, 0.75), p90: pct(ratios, 0.9), p99: pct(ratios, 0.99), max: ratios[ratios.length - 1] } : null,
      wastedGasShare: withResim.length
        ? 1 - withResim.reduce((a, r) => a + Number(BigInt(r.resimGas!)), 0) / withResim.reduce((a, r) => a + Number(BigInt(r.gasLimit)), 0)
        : null,
    },
    replayAtParentBlock: {
      note: 'side observation only; the knowable-at-N-k benchmark is a separate work item and uses N-1/N-2/N-3',
      histogram: byAtParent, resimModeHistogram: byMode,
      revertsAtParent: shareBy((r) => r.atParent === 'revert'),
    },
    sampledBurnMON: totalBurn,
  };
  save({ traces: out });
  console.log(JSON.stringify(out, null, 2));
}

await (TRACES ? traces() : FULL ? full() : sample());
