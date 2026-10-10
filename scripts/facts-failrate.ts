// Current failure rate + OOG share + sum(tx gas limit)/block gasLimit over a spaced sample of recent mainnet blocks.
import { writeFileSync } from "node:fs";
const EP = ["https://rpc.monad.xyz", "https://rpc1.monad.xyz"];
const hex = (n: number) => "0x" + n.toString(16);
async function post(ep: string, body: any) {
  for (let a = 0; a < 10; a++) {
    try { const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }); const j: any = await r.json();
      if (Array.isArray(j) ? j.some((x) => x.result === undefined) : j.result === undefined) throw new Error("bad"); return j; } catch { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); }
  }
  throw new Error("fail");
}
const head = parseInt((await post(EP[0], { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })).result, 16) - 100;
const S = Number(process.argv[2] ?? 400), step = Math.floor(20000 / S);
const ks = Array.from({ length: S }, (_, i) => head - i * step);
let blocks = 0, txs = 0, failed = 0, okEq = 0, txGas = 0n, gl = 0n, gu = 0n, failGasLimit = 0n, burnWei = 0n;
const chunks: number[][] = []; for (let i = 0; i < ks.length; i += 2) chunks.push(ks.slice(i, i + 2));
let nxt = 0;
async function w(i: number) { while (nxt < chunks.length) {
  const c = chunks[nxt++]; const ep = EP[i % 2];
  const body = c.flatMap((k) => [{ jsonrpc: "2.0", id: k * 2, method: "eth_getBlockByNumber", params: [hex(k), true] }, { jsonrpc: "2.0", id: k * 2 + 1, method: "eth_getBlockReceipts", params: [hex(k)] }]);
  const res: any[] = await post(ep, body); const m = new Map(res.map((x) => [x.id, x.result]));
  for (const k of c) { const b = m.get(k * 2), rcs = m.get(k * 2 + 1); blocks++; gl += BigInt(b.gasLimit); gu += BigInt(b.gasUsed);
    const tx = new Map<string, any>(b.transactions.map((t: any) => [t.hash, t]));
    for (const t of b.transactions) { txs++; txGas += BigInt(t.gas); }
    for (const r of rcs) { if (r.status === "0x0") { failed++; const t = tx.get(r.transactionHash); failGasLimit += BigInt(t.gas); burnWei += BigInt(t.gas) * BigInt(r.effectiveGasPrice); } else if (BigInt(r.gasUsed) === BigInt(tx.get(r.transactionHash).gas)) okEq++; } }
} }
await Promise.all(Array.from({ length: 6 }, (_, i) => w(i)));
const out = { at: new Date().toISOString(), head, sampledBlocks: blocks, spacing: step, txs, failed, failRate: failed / txs, successGasUsedEqLimit: okEq, successTxs: txs - failed, sumTxGasLimitOverBlockGasLimit: Number(txGas) / Number(gl), blockGasUsedOverGasLimit: Number(gu) / Number(gl), failedTxShareOfDeclaredGas: Number(failGasLimit) / Number(txGas), failedBurnMON_inSample: Number(burnWei) / 1e18, avgBurnMONPerFailedTx: Number(burnWei) / 1e18 / failed };
writeFileSync("results/facts/failrate-sample.json", JSON.stringify(out, null, 2)); console.log(out);
