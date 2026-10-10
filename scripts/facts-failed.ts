// Core-premise test on REAL mainnet data: failed txs pay gasLimit x price.
// Scans recent blocks via eth_getBlockReceipts, picks failed txs whose sender sent exactly one tx in block and
// is not a recipient of any tx value in that block, and compares balance(N-1) - balance(N) with gasLimit*effectiveGasPrice.
import { writeFileSync } from "node:fs";
const RPC = "https://rpc.monad.xyz";
let id = 0;
async function call(method: string, params: any[]): Promise<any> {
  for (let a = 0; a < 10; a++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j: any = await r.json(); if (j.result === undefined && !j.error) throw new Error("empty:" + JSON.stringify(j).slice(0,100)); if (j.error) { if (/limit|rate/i.test(JSON.stringify(j.error))) throw new Error("rl"); throw new Error(method + JSON.stringify(j.error)); } return j.result;
    } catch (e: any) { if (String(e.message).startsWith(method)) throw e; await new Promise((s) => setTimeout(s, 1200 * (a + 1))); }
  }
  throw new Error("fail " + method);
}
const hex = (n: number) => "0x" + n.toString(16);
const head = parseInt(await call("eth_blockNumber", []), 16) - 200; // settle margin
const rows: any[] = [];
let okTxs = 0, okGasUsedEqLimit = 0, failTxs = 0, failGasUsedEqLimit = 0, scanned = 0;
for (let n = head; rows.length < 12 && n > head - 400; n--) {
  const [blk, rcs] = await Promise.all([call("eth_getBlockByNumber", [hex(n), true]), call("eth_getBlockReceipts", [hex(n)])]);
  scanned++;
  const txByHash = new Map<string, any>(blk.transactions.map((t: any) => [t.hash, t]));
  const senderCount = new Map<string, number>(), recipients = new Set<string>();
  for (const t of blk.transactions) { senderCount.set(t.from.toLowerCase(), (senderCount.get(t.from.toLowerCase()) ?? 0) + 1); if (t.to) recipients.add(t.to.toLowerCase()); }
  for (const rc of rcs) {
    const t = txByHash.get(rc.transactionHash); const eq = BigInt(rc.gasUsed) === BigInt(t.gas);
    if (rc.status === "0x1") { okTxs++; if (eq) okGasUsedEqLimit++; } else { failTxs++; if (eq) failGasUsedEqLimit++; }
  }
  for (const rc of rcs) {
    if (rc.status !== "0x0" || rows.length >= 12) continue;
    const t = txByHash.get(rc.transactionHash); const from = t.from.toLowerCase();
    if (senderCount.get(from) !== 1 || recipients.has(from) || BigInt(t.value) !== 0n) continue;
    const [b0, b1] = await Promise.all([call("eth_getBalance", [t.from, hex(n - 1)]), call("eth_getBalance", [t.from, hex(n)])]);
    const delta = BigInt(b0) - BigInt(b1);
    const limit = BigInt(t.gas), price = BigInt(rc.effectiveGasPrice);
    rows.push({ block: n, hash: t.hash, from: t.from, to: t.to, type: t.type, gasLimit: limit.toString(), gasUsed: BigInt(rc.gasUsed).toString(), effectiveGasPrice: price.toString(), maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, gasPrice: t.gasPrice, status: rc.status, expectedFee_limitXprice: (limit * price).toString(), balanceDelta_wei: delta.toString(), deltaEqualsLimitXPrice: delta === limit * price, ifGasUsedXPriceWasCharged: (BigInt(rc.gasUsed) * price).toString(), feeMON: Number(delta) / 1e18 });
    console.error("row", rows.length, t.hash, delta === limit * price);
  }
}
const out = { rpc: RPC, at: new Date().toISOString(), blocksScanned: scanned, head, receiptStats: { okTxs, okGasUsedEqLimit, failTxs, failGasUsedEqLimit, failRate: failTxs / (failTxs + okTxs) }, rows };
writeFileSync("results/facts/failed-tx-fee-check.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.receiptStats), "rows", rows.length, "matches", rows.filter((r) => r.deltaEqualsLimitXPrice).length);
