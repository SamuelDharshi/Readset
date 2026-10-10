// Probe public WS endpoint for eth_subscribe support. Writes results/facts/ws-probe.json
import { writeFileSync } from "node:fs";
const url = "wss://rpc.monad.xyz";
const out: any[] = [];
const ws = new WebSocket(url);
const subs = [["newHeads"], ["newPendingTransactions"], ["monadNewHeads"], ["syncing"], ["logs", {}], ["monadLogs", {}]];
ws.onopen = () => subs.forEach((p, i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "eth_subscribe", params: p })));
ws.onmessage = (m) => { const j = JSON.parse(String(m.data)); if (j.id) out.push({ params: subs[j.id - 1], response: j.error ? { error: j.error } : { result: "subscription id " + String(j.result).slice(0, 10) + "..." } }); };
setTimeout(() => { ws.close(); writeFileSync("results/facts/ws-probe.json", JSON.stringify({ url, at: new Date().toISOString(), out }, null, 2)); console.log(JSON.stringify(out, null, 1)); process.exit(0); }, 6000);
