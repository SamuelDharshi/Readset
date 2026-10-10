// Replay benchmark runner (K2). Real Monad MAINNET only.
//
//   npx tsx scripts/replay-benchmark.ts                                  # default: 2000 blocks, seed 20261007
//   npx tsx scripts/replay-benchmark.ts --blocks 3000 --budget-min 60
//   npx tsx scripts/replay-benchmark.ts --run smoke --blocks 40 --cross-check 5
//   npx tsx scripts/replay-benchmark.ts --report-only                    # re-aggregate the existing checkpoint
//
// Flags: --blocks N  --seed N  --rps N  --conc N  --budget-min N  --max-failed N  --success-per-block N
//        --run NAME (checkpoint dir .readset/replay/NAME)  --cross-check N  --report-only  --no-doc
// Everything is resumable: re-running the same --run/--seed/--blocks continues from the JSONL checkpoint.

import path from 'node:path';
import {
  DEFAULT_SEED,
  defaultReplayDir,
  runReplayBenchmark,
  openCheckpoint,
  sampleBlocks,
  FRAME,
  type BlockHarvest,
  type FailedReplayRow,
  type SuccessReplayRow,
  type RunResult,
} from '../packages/bench/src/replay.js';
import { buildReport, writeBenchmarkDoc, writeResultJson } from '../packages/bench/src/report.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const num = (name: string, dflt: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const str = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};

const ROOT = path.resolve(import.meta.dirname, '..');
const run = str('run', 'main');
const blocks = num('blocks', 2000);
const seed = num('seed', DEFAULT_SEED);
const rps = num('rps', 9);
const conc = num('conc', 8);
const budgetMin = num('budget-min', 0);
const maxFailed = num('max-failed', 0);
const successPerBlock = num('success-per-block', 1);
const crossCheck = num('cross-check', 40);
const dir = defaultReplayDir(run);

function progressPrinter() {
  let last = 0;
  let lastPhase = '';
  return (p: { phase: string; done: number; total: number; note?: string }) => {
    if (p.note) console.log(`  ! ${p.note}`);
    const now = Date.now();
    if (p.phase !== lastPhase || now - last > 5000 || p.done === p.total) {
      lastPhase = p.phase;
      last = now;
      console.log(`[${p.phase}] ${p.done}/${p.total}`);
    }
  };
}

/** Rebuild a RunResult from the checkpoint alone (no re-simulation), for --report-only. */
function fromCheckpoint(): RunResult {
  const cpBlocks = openCheckpoint(dir, 'blocks');
  const cpFailed = openCheckpoint(dir, 'failed');
  const cpSucc = openCheckpoint(dir, 'successful');
  const cpMeta = openCheckpoint(dir, 'meta');
  const harvests = cpBlocks.rows<BlockHarvest & { error?: string }>().filter((h) => !h.error);
  // the run that produced this checkpoint recorded its own design (endpoints, rps, call count, wall time)
  const saved = cpMeta.rows<RunResult['design']>().find((d) => d && (d as RunResult['design']).oracle === 'eth_call@blockHash');
  return {
    design: saved ?? {
      frame: FRAME,
      seed,
      blocksRequested: blocks,
      blocksHarvested: harvests.length,
      successPerBlock,
      endpoints: ['https://rpc2.monad.xyz', 'https://rpc-mainnet.monadinfra.com'],
      rps,
      oracle: 'eth_call@blockHash',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      wallMs: 0,
      rpcCalls: 0,
      truncated: true,
    },
    harvest: {
      blocks: harvests.length,
      txs: harvests.reduce((a, h) => a + h.txs, 0),
      failedTxs: harvests.reduce((a, h) => a + h.failedTxs, 0),
      successTxs: harvests.reduce((a, h) => a + h.successTxs, 0),
    },
    failed: cpFailed.rows<FailedReplayRow>(),
    successful: cpSucc.rows<SuccessReplayRow>(),
    crossCheck: { n: 0, agree: 0, disagree: [] },
  };
}

async function main() {
  console.log(
    `replay-benchmark: frame ${FRAME.fromBlock}-${FRAME.toBlock}, ${blocks} blocks, seed ${seed}, ${rps} rps, conc ${conc}` +
      (budgetMin ? `, budget ${budgetMin} min` : '') +
      `\ncheckpoint ${dir}`,
  );
  if (!flag('report-only')) console.log(`first/last sampled block: ${sampleBlocks(blocks, seed)[0]} / ${sampleBlocks(blocks, seed).at(-1)}`);

  const result = flag('report-only')
    ? fromCheckpoint()
    : await runReplayBenchmark({
        blocks,
        seed,
        rps,
        concurrency: conc,
        dir,
        successPerBlock,
        maxFailed: maxFailed || undefined,
        budgetMs: budgetMin ? budgetMin * 60_000 : undefined,
        crossCheck,
        onProgress: progressPrinter(),
      });

  const report = buildReport(result);
  const outDir = path.join(ROOT, 'results', 'replay');
  const file = writeResultJson(report, { failed: result.failed, successful: result.successful }, outDir);
  if (!flag('no-doc')) writeBenchmarkDoc(report, file, path.join(ROOT, 'docs', 'benchmark.md'));

  const k = report.knowable.ofAllBurn;
  const p = (x: { point: number; lo: number; hi: number }) => `${(x.point * 100).toFixed(2)}% [${(x.lo * 100).toFixed(2)}, ${(x.hi * 100).toFixed(2)}]`;
  console.log('\n================ HEADLINE ================');
  console.log(`n failed      : ${report.sample.failedN}  (${report.sample.failedBurnMON.toFixed(2)} MON burn)`);
  console.log(`n successful  : ${report.sample.successfulN}`);
  console.log(`blocks        : ${report.sample.blocks}`);
  console.log(`knowable burn : N-1 ${p(k['N-1'].byBurn)}   N-2 ${p(k['N-2'].byBurn)}   N-3 ${p(k['N-3'].byBurn)}`);
  console.log(`knowable txs  : N-1 ${p(k['N-1'].byCount)}   N-3 ${p(k['N-3'].byCount)}`);
  console.log(`false blocks  : ${p(report.falseBlocks.rate)}  (${report.falseBlocks.rate.k}/${report.falseBlocks.rate.n})`);
  console.log(`same-block    : ${p(report.sameBlock.byBurn)} of burn`);
  console.log(`excluded-funds: ${p(report.excluded.byBurn)} of burn`);
  console.log(`oracle agree  : ${report.oracleCrossCheck.agree}/${report.oracleCrossCheck.n}`);
  console.log(`K2 verdict    : ${report.targets.k2Verdict}`);
  console.log('==========================================');
  console.log(`\nwrote ${file}`);
  if (!flag('no-doc')) console.log('wrote docs/benchmark.md');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
