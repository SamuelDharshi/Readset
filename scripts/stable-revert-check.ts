// Does requiring the revert to REPRODUCE at N-3 kill the false blocks?
//
// The headline benchmark refuses a send when it reverts at N-1. That wrongly refuses 8.5% of
// txs that actually succeeded: their precondition was written by an earlier tx in their own
// block, so N-1 state does not have it yet. Knowable burn is almost identical at N-1 (36.41%)
// and N-3 (36.34%), so demanding a STABLE revert should cost us almost no detection while
// dropping the churn cases. This re-simulates only the false-block candidates at N-2/N-3.
//
//   npx tsx scripts/stable-revert-check.ts [results/replay/latest.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { RpcPool, simulateAt, type SimCall } from '../packages/bench/src/replay.js';

type Hex = `0x${string}`;
const file = process.argv[2] ?? 'results/replay/latest.json';
const r = JSON.parse(readFileSync(file, 'utf8')) as {
  rows: { successful: Row[] };
  design: { endpoints: string[]; rps: number };
};

interface Row {
  hash: Hex;
  blockNumber: number;
  from: Hex;
  to: Hex | null;
  selector: Hex | null;
  gasLimit: string;
  falseBlock?: boolean;
  reason?: string;
}

const pool = new RpcPool({ urls: r.design.endpoints, rps: r.design.rps ?? 9 });
const candidates = r.rows.successful.filter((x) => x.falseBlock);
console.log(`false-block candidates: ${candidates.length}`);

/** Re-fetch the tx so we replay the exact same call, and the parent hashes of N-1..N-3. */
async function hashesFor(blockNumber: number): Promise<Hex[]> {
  const out: Hex[] = [];
  for (const k of [1, 2, 3]) {
    const b = await pool.call<{ hash: Hex } | null>('eth_getBlockByNumber', [
      `0x${(blockNumber - k).toString(16)}`,
      false,
    ]);
    if (!b) throw new Error(`no block ${blockNumber - k}`);
    out.push(b.hash);
  }
  return out;
}

let stillRevertsAtN3 = 0;
let cleanAtN3 = 0;
let unmeasured = 0;
const GATE_GAS: Hex = '0x1e84800';
const detail: Record<string, unknown>[] = [];

for (const [i, c] of candidates.entries()) {
  try {
    const tx = await pool.call<{ from: Hex; to: Hex | null; input: Hex; value: Hex } | null>(
      'eth_getTransactionByHash',
      [c.hash],
    );
    if (!tx) {
      unmeasured++;
      continue;
    }
    const h = await hashesFor(c.blockNumber);
    const call: SimCall = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: GATE_GAS };
    const n3 = await simulateAt(pool, call, h[2]!);
    if (n3.reverted === null) unmeasured++;
    else if (n3.reverted) stillRevertsAtN3++;
    else cleanAtN3++;
    detail.push({ hash: c.hash, revertsAtN3: n3.reverted, error: n3.error ?? null });
  } catch (e) {
    unmeasured++;
    detail.push({ hash: c.hash, error: (e as Error).message });
  }
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${candidates.length}`);
}

const n = r.rows.successful.length;
const naive = candidates.length / n;
const stable = stillRevertsAtN3 / n;
const out = {
  source: file,
  successfulN: n,
  falseBlockCandidates: candidates.length,
  stillRevertsAtN3,
  cleanAtN3,
  unmeasured,
  rates: {
    naiveRefuseOnAnyRevertAtN1: naive,
    stableRequireRevertAtN1AndN3: stable,
  },
  detail,
};
writeFileSync('results/replay/stable-revert-check.json', JSON.stringify(out, null, 2));

console.log('\n============ STABLE-REVERT RULE ============');
console.log(`successful sample      : ${n}`);
console.log(`false blocks (N-1 only): ${candidates.length}  = ${(naive * 100).toFixed(2)}%`);
console.log(`  still revert at N-3  : ${stillRevertsAtN3}  = ${(stable * 100).toFixed(2)}%  <- stable rule`);
console.log(`  clean at N-3         : ${cleanAtN3}  (churn: would no longer be refused)`);
console.log(`unmeasured             : ${unmeasured}`);
console.log('============================================');
