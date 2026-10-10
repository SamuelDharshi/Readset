// Empirical on-chain checks on Monad mainnet via public RPC.
// usage: tsx scripts/facts-chain.ts tps|failed
import { writeFileSync } from "node:fs";
const RPC = process.env.FACTS_RPC ?? "https://rpc.monad.xyz";
let id = 0;
const rf = async (u: string, o: any) => { for (let i = 0; i < 8; i++) { try { return await fetch(u, { ...o, signal: AbortSignal.timeout(45000) }); } catch { await new Promise((s) => setTimeout(s, 1000 * (i + 1))); } } throw new Error('network'); };
async function call(method: string, params: any[]) {
  for (let a = 0; a < 6; a++) {
    const r = await rf(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 500 * (a + 1))); continue; }
    const j: any = await r.json(); if (j.error) throw new Error(method + ": " + JSON.stringify(j.error)); return j.result;
  }
  throw new Error("rate limited");
}
async function batch(reqs: [string, any[]][]) {
  for (let a = 0; a < 8; a++) {
    const body = reqs.map(([m, p], i) => ({ jsonrpc: "2.0", id: i, method: m, params: p }));
    const r = await rf(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 700 * (a + 1))); continue; }
    const j: any = await r.json();
    if (!Array.isArray(j)) { await new Promise((s) => setTimeout(s, 700 * (a + 1))); continue; }
    if (j.some((x: any) => x.error?.code === -32005 || x.error?.code === 429)) { await new Promise((s) => setTimeout(s, 700 * (a + 1))); continue; }
    return j.sort((x: any, y: any) => x.id - y.id).map((x: any) => x.error ? { error: x.error } : x.result);
  }
  throw new Error("batch failed");
}
const hex = (n: number) => "0x" + n.toString(16);
const mode = process.argv[2];

if (mode === "tps") {
  const head = parseInt(await call("eth_blockNumber", []), 16) - 50;
  const N = 20000, start = head - N + 1, B = 50, CONC = 10;
  const ENDPOINTS = ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"];
  const rows = new Map<number, { ts: number; n: number; gu: bigint; gl: bigint }>();
  const starts: number[] = []; for (let b = start; b <= head; b += B) starts.push(b);
  let next = 0, done = 0;
  async function worker(w: number) {
    while (next < starts.length) {
      const b = starts[next++]; const ep = ENDPOINTS[w % ENDPOINTS.length];
      const body = []; for (let k = b; k < Math.min(b + B, head + 1); k++) body.push({ jsonrpc: "2.0", id: k, method: "eth_getBlockByNumber", params: [hex(k), false] });
      for (let a = 0; a < 10; a++) {
        try {
          const r = await rf(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const j: any = await r.json();
          if (!Array.isArray(j) || j.some((x: any) => !x.result)) throw new Error("bad");
          for (const x of j) rows.set(x.id, { ts: parseInt(x.result.timestamp, 16), n: x.result.transactions.length, gu: BigInt(x.result.gasUsed), gl: BigInt(x.result.gasLimit) });
          break;
        } catch { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); }
      }
      done++; if (done % 20 === 0) console.error("batches", done, "/", starts.length);
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));
  if (rows.size !== N) throw new Error("missing blocks: " + rows.size);
  let txs = 0, gu = 0n, gl = 0n, empty = 0, tmin = Infinity, tmax = 0;
  for (const v of rows.values()) { txs += v.n; gu += v.gu; gl += v.gl; if (!v.n) empty++; tmin = Math.min(tmin, v.ts); tmax = Math.max(tmax, v.ts); }
  const secs = tmax - tmin;
  const r = { rpc: ENDPOINTS, at: new Date().toISOString(), startBlock: start, endBlock: head, blocks: N, txs, txPerBlock: txs / N, secondsSpan: secs, blocksPerSec: N / secs, tps: txs / secs, avgBlockTimeMs: (secs * 1000) / N, emptyBlocks: empty, gasUsedOverGasLimit: Number(gu) / Number(gl), avgGasLimitPerBlock: Number(gl) / N, avgGasUsedPerBlock: Number(gu) / N };
  writeFileSync("results/facts/tps-20k.json", JSON.stringify(r, null, 2)); console.log(r);
}

if (mode === "gaslimit") {
  // sum of tx.gas (declared limits) / block gasLimit over a sample of full blocks (what SQD calls gas-limit utilisation)
  const head = parseInt(await call("eth_blockNumber", []), 16) - 50;
  const S = Number(process.argv[3] ?? 2000), step = Math.floor(20000 / S), B = 25;
  let txs = 0, txGasSum = 0n, gasLimitSum = 0n, gasUsed = 0n, blocks = 0, secs0 = 0, n = 0;
  const ks: number[] = []; for (let i = 0; i < S; i++) ks.push(head - i * step);
  for (let i = 0; i < ks.length; i += B) {
    const res = await batch(ks.slice(i, i + B).map((k) => ["eth_getBlockByNumber", [hex(k), true]] as [string, any[]]));
    for (const blk of res) { blocks++; gasLimitSum += BigInt(blk.gasLimit); gasUsed += BigInt(blk.gasUsed); for (const t of blk.transactions) { txs++; txGasSum += BigInt(t.gas); } }
  }
  const r = { rpc: RPC, at: new Date().toISOString(), sampledBlocks: blocks, spacing: step, headBlock: head, txs, sumTxGasLimitOverBlockGasLimit: Number(txGasSum) / Number(gasLimitSum), gasUsedOverGasLimit: Number(gasUsed) / Number(gasLimitSum), avgTxGasLimit: Number(txGasSum) / txs, avgTxGasUsedPerTx: Number(gasUsed) / txs };
  writeFileSync("results/facts/gaslimit-util.json", JSON.stringify(r, null, 2)); console.log(r);
}
