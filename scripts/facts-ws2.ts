// Subscribe ONLY to newPendingTransactions and record what it delivers in 10s.
import { writeFileSync } from "node:fs";
const ws = new WebSocket("wss://rpc.monad.xyz");
const got: any[] = []; let subId = "";
ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: [process.argv[2] ?? "newPendingTransactions"] }));
ws.onmessage = (m) => { const j = JSON.parse(String(m.data)); if (j.id === 1) { subId = j.result; console.log("sub", j.result ?? j.error); } else got.push(j); };
setTimeout(() => {
  const summary = { at: new Date().toISOString(), subId, notifications: got.length, firstKinds: got.slice(0, 3).map((g) => typeof g.params?.result === "string" ? "string:" + g.params.result.length + " chars" : "object keys:" + Object.keys(g.params?.result ?? {}).slice(0, 8).join(",")) , sample: got[0] };
  writeFileSync(`results/facts/ws-sub-${process.argv[2] ?? "newPendingTransactions"}.json`, JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ ...summary, sample: undefined })); ws.close(); process.exit(0);
}, 10000);
