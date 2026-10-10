/**
 * K1 probe: does debug_traceCall accept historical block number / block hash,
 * does prestateTracer list read-only slots, history window, overrides, latency.
 * Real RPCs only. Run: npx tsx scripts/k1-probe.ts [--quick]
 * Outputs: results/k1.json (summary) + results/k1-raw.json (raw responses).
 * Only reads optional provider keys from env (ALCHEMY_API_KEY, QUICKNODE_URL, DWELLIR_API_KEY); never prints them.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { keccak256, encodeAbiParameters, pad, toHex } from 'viem';

// load .env without printing
if (existsSync('.env')) {
  for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const QUICK = process.argv.includes('--quick');

type Ep = { name: string; url: string; net: 'mainnet' | 'testnet'; secret?: boolean };
const eps: Ep[] = [
  { name: 'mainnet:rpc.monad.xyz', url: 'https://rpc.monad.xyz', net: 'mainnet' },
  { name: 'mainnet:rpc-mainnet.monadinfra.com', url: 'https://rpc-mainnet.monadinfra.com', net: 'mainnet' },
  { name: 'mainnet:rpc1.monad.xyz', url: 'https://rpc1.monad.xyz', net: 'mainnet' },
  { name: 'mainnet:rpc2.monad.xyz', url: 'https://rpc2.monad.xyz', net: 'mainnet' },
  { name: 'mainnet:rpc3.monad.xyz', url: 'https://rpc3.monad.xyz', net: 'mainnet' },
  { name: 'testnet:testnet-rpc.monad.xyz', url: 'https://testnet-rpc.monad.xyz', net: 'testnet' },
  { name: 'testnet:rpc-testnet.monadinfra.com', url: 'https://rpc-testnet.monadinfra.com', net: 'testnet' },
];
const A = process.env.ALCHEMY_API_KEY, Q = process.env.QUICKNODE_URL, D = process.env.DWELLIR_API_KEY;
if (A) { eps.push({ name: 'mainnet:alchemy', url: `https://monad-mainnet.g.alchemy.com/v2/${A}`, net: 'mainnet', secret: true });
         eps.push({ name: 'testnet:alchemy', url: `https://monad-testnet.g.alchemy.com/v2/${A}`, net: 'testnet', secret: true }); }
if (Q) eps.push({ name: 'quicknode', url: Q, net: Q.includes('testnet') ? 'testnet' : 'mainnet', secret: true });
if (D) eps.push({ name: 'dwellir', url: `https://api-monad-mainnet-archive.n.dwellir.com/${D}`, net: 'mainnet', secret: true });

const WMON: Record<string, string> = {
  mainnet: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  testnet: '0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541',
};
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // mainnet canonical; checked per-net via getCode
const T_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));

const raw: Record<string, any> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type R = { ok: boolean; result?: any; error?: any; http?: number; ms: number };
async function rpc(ep: Ep, method: string, params: any[], tries = 3): Promise<R> {
  if (process.env.K1_VERBOSE) console.error(new Date().toISOString().slice(11,19), ep.name, "->", method);
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(ep.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(25000),
      });
      const ms = performance.now() - t0;
      const txt = await res.text();
      let j: any; try { j = JSON.parse(txt); } catch { j = { error: { message: txt.slice(0, 200) } }; }
      if (res.status === 429 || j?.error?.code === -32005) { if (i < tries - 1) { await sleep(1500 * (i + 1)); continue; } return { ok: false, error: j.error ?? { message: '429' }, http: res.status, ms }; }
      return j.error ? { ok: false, error: j.error, http: res.status, ms } : { ok: true, result: j.result, http: res.status, ms };
    } catch (e: any) {
      if (i === tries - 1) return { ok: false, error: { message: String(e?.message ?? e) }, ms: performance.now() - t0 };
      await sleep(500);
    }
  }
  return { ok: false, error: { message: 'unreachable' }, ms: 0 };
}
const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const short = (r: R) => r.ok ? 'ok' : `err ${r.error?.code ?? ''} ${String(r.error?.message ?? '').slice(0, 140)}`;

async function probe(ep: Ep) {
  const out: any = { endpoint: ep.secret ? ep.name : ep.url, net: ep.net };
  const rw: any = (raw[ep.name] = {});
  let wmon = WMON[ep.net];

  const cid = await rpc(ep, 'eth_chainId', []);
  if (!cid.ok) { out.reachable = false; out.error = short(cid); return out; }
  out.reachable = true; out.chainId = cid.result;
  out.client = (await rpc(ep, 'web3_clientVersion', [])).result ?? null;
  const head = parseInt((await rpc(ep, 'eth_blockNumber', [])).result, 16);
  out.head = head;

  // ---- history window ----
  const hist: any = {};
  const offsets = [1, 100, 10_000, 100_000, 1_000_000, 5_000_000, 20_000_000, 50_000_000, 100_000_000];
  const stateAt = async (n: number) => {
    const b = await rpc(ep, 'eth_getBalance', [wmon, hex(n)]);
    const c = await rpc(ep, 'eth_call', [{ to: wmon, data: '0x18160ddd' }, hex(n)]); // totalSupply()
    return { getBalance: short(b), ethCall: short(c), ok: b.ok && c.ok };
  };
  for (const o of offsets) { if (head - o > 0) hist[`-${o}`] = await stateAt(head - o); }
  const blk = await rpc(ep, 'eth_getBlockByNumber', [hex(Math.max(1, head - 1_000_000)), false]);
  hist['getBlockByNumber(-1M)'] = short(blk);
  // bisect true state window between farthest ok and first failing offset
  let lastOk = 0, firstBad = 0;
  for (const o of offsets) { if (hist[`-${o}`]?.ok) lastOk = o; else if (hist[`-${o}`] && !firstBad) { firstBad = o; break; } }
  if (!QUICK && firstBad && lastOk >= 0) {
    let lo = lastOk, hi = firstBad;
    while (hi - lo > Math.max(10, lo * 0.02) ) { const mid = Math.floor((lo + hi) / 2); if ((await stateAt(head - mid)).ok) lo = mid; else hi = mid; }
    hist.bisectedStateWindowBlocks = lo;
  }
  hist.archive = !firstBad && head > 1_000_000;
  out.history = hist;
  const lookback = Math.min(...[1_000_000, hist.bisectedStateWindowBlocks ?? 1_000_000].filter((x) => x > 0), 1_000_000);
  void lookback;

  // ---- find a holder of the token (real Transfer log) ----
  let holder: string | null = null, logBlock = head - 2;
  for (const span of [50, 200, 1000]) {
    const lg = await rpc(ep, 'eth_getLogs', [{ address: wmon, topics: [T_TOPIC], fromBlock: hex(head - 2 - span), toBlock: hex(head - 2) }]);
    rw.getLogs = short(lg);
    if (lg.ok && lg.result.length) { const l = lg.result[lg.result.length - 1]; holder = '0x' + l.topics[2].slice(26); logBlock = parseInt(l.blockNumber, 16); break; }
  }
  if (!holder) { // fallback: any ERC20 Transfer (3 topics) in the last 30 blocks, use that token
    const lg = await rpc(ep, 'eth_getLogs', [{ topics: [T_TOPIC], fromBlock: hex(head - 32), toBlock: hex(head - 2) }]);
    const l = lg.ok ? lg.result.find((x: any) => x.topics.length === 3) : null;
    if (l) { wmon = l.address; holder = '0x' + l.topics[2].slice(26); out.tokenFallback = wmon; }
  }
  out.holder = holder;
  if (!holder) { out.note = 'no WMON Transfer found; trace tests skipped'; }

  const traceBlockNum = head - 3; // safely finalized-ish
  const bh = (await rpc(ep, 'eth_getBlockByNumber', [hex(traceBlockNum), false])).result;
  const hash: string | undefined = bh?.hash;
  out.traceBlock = { number: traceBlockNum, hash };

  const dataBal = holder ? '0x70a08231' + pad(holder as `0x${string}`, { size: 32 }).slice(2) : '0x';
  const callBal = holder ? { from: holder, to: wmon, data: dataBal } : null;
  const dummy = '0x000000000000000000000000000000000000dEaD';
  // transfer(dummy, 1) from holder => a WRITE call
  const dataXfer = holder ? '0xa9059cbb' + pad(dummy as `0x${string}`, { size: 32 }).slice(2) + pad('0x1', { size: 32 }).slice(2) : '0x';
  const callXfer = holder ? { from: holder, to: wmon, data: dataXfer } : null;

  const trace: any = (out.traceCall = {});
  const tcall = async (label: string, call: any, block: any, opts: any) => {
    const r = await rpc(ep, 'debug_traceCall', [call, block, opts]);
    rw[`traceCall:${label}`] = r.ok ? r.result : r.error;
    trace[label] = short(r);
    return r;
  };
  if (holder && hash) {
    const bnum = hex(traceBlockNum);
    const pre = { tracer: 'prestateTracer' };
    await tcall('prestate@latest', callBal, 'latest', pre);
    await tcall('prestate@blockNumber', callBal, bnum, pre);
    await tcall('prestate@blockHashString', callBal, hash, pre);
    await tcall('prestate@EIP1898{blockHash}', callBal, { blockHash: hash }, pre);
    await tcall('prestate@EIP1898{blockNumber}', callBal, { blockNumber: bnum }, pre);
    for (const o of [100, 10_000, 100_000]) {
      if (head - o > 0) await tcall(`prestate@-${o}`, callBal, hex(head - o), pre);
    }
    await tcall('callTracer@blockNumber', callBal, bnum, { tracer: 'callTracer' });
    const rNo = await tcall('prestate(no tracerConfig) READ', callBal, bnum, pre);
    const rF = await tcall('prestate diffMode:false READ', callBal, bnum, { tracer: 'prestateTracer', tracerConfig: { diffMode: false } });
    const rT = await tcall('prestate diffMode:true READ', callBal, bnum, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } });
    const rW = await tcall('prestate diffMode:true WRITE(transfer)', callXfer, bnum, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } });
    const rW2 = await tcall('prestate diffMode:false WRITE(transfer)', callXfer, bnum, { tracer: 'prestateTracer', tracerConfig: { diffMode: false } });

    // ---- read-only slot analysis ----
    const balSlots = new Set<string>();
    for (let i = 0; i < 12; i++)
      balSlots.add(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder as `0x${string}`, BigInt(i)])));
    const find = (r: R, path: 'pre' | 'post' | 'top') => {
      if (!r.ok) return null;
      const acc = path === 'top' ? r.result : r.result?.[path];
      const e = acc && Object.entries(acc).find(([a]) => a.toLowerCase() === wmon.toLowerCase());
      const storage = (e?.[1] as any)?.storage ?? {};
      const keys = Object.keys(storage);
      return { accountsListed: acc ? Object.keys(acc).length : 0, wmonStorageKeys: keys.length, hasHolderBalanceSlot: keys.some((k) => balSlots.has(k.toLowerCase())), keys: keys.slice(0, 8) };
    };
    out.readOnlySlots = {
      note: 'pure read: WMON.balanceOf(holder). hasHolderBalanceSlot=true means read-only slot IS listed',
      nonDiff_noConfig: find(rNo, 'top'),
      nonDiff_false: find(rF, 'top'),
      diffMode_READ_pre: find(rT, 'pre'), diffMode_READ_post: find(rT, 'post'),
      diffMode_WRITE_pre: find(rW, 'pre'), diffMode_WRITE_post: find(rW, 'post'),
      nonDiff_WRITE: find(rW2, 'top'),
      // any storage key listed for the token on a pure read (proxy tokens may not use mapping slot 0..11)
      readIsListed: (find(rNo, 'top')?.wmonStorageKeys ?? 0) > 0 && (find(rF, 'top')?.wmonStorageKeys ?? 0) > 0,
      readListedInDiffMode: (find(rT, 'pre')?.wmonStorageKeys ?? 0) > 0,
    };

    // ---- overrides ----
    const ov: any = (out.overrides = {});
    const mc = ep.net === 'mainnet' ? MULTICALL3 : MULTICALL3;
    const code = await rpc(ep, 'eth_getCode', [mc, 'latest']);
    const mcOk = code.ok && code.result && code.result !== '0x';
    ov.multicall3Present = mcOk;
    if (mcOk) {
      const target = '0x00000000000000000000000000000000000000AA';
      const getEthBal = '0x4d2301cc' + pad(target as `0x${string}`, { size: 32 }).slice(2);
      const getTs = '0x0f28c97d'; // getCurrentBlockTimestamp()
      const getNum = '0x42cbb15c'; // getBlockNumber()
      const bigBal = '0xde0b6b3a7640000'; // 1e18
      const r1 = await rpc(ep, 'eth_call', [{ to: mc, data: getEthBal }, 'latest', { [target]: { balance: bigBal } }]);
      ov.eth_call_stateOverride_balance = r1.ok ? { returned: r1.result, works: BigInt(r1.result) === 10n ** 18n } : short(r1);
      const r2 = await rpc(ep, 'eth_call', [{ to: mc, data: getTs }, 'latest', {}, { time: '0x5f5e100' }]);
      ov.eth_call_blockOverrides_time = r2.ok ? { returned: r2.result, works: r2.result && BigInt(r2.result) === 0x5f5e100n } : short(r2);
      const r2b = await rpc(ep, 'eth_call', [{ to: mc, data: getTs }, 'latest', {}, { timestamp: '0x5f5e100' }]);
      ov.eth_call_blockOverrides_timestamp_key = r2b.ok ? { returned: r2b.result, works: r2b.result && BigInt(r2b.result) === 0x5f5e100n } : short(r2b);
      const r3 = await rpc(ep, 'eth_call', [{ to: mc, data: getNum }, 'latest', {}, { number: '0x1234' }]);
      ov.eth_call_blockOverrides_number = r3.ok ? { returned: r3.result, works: r3.result && BigInt(r3.result) === 0x1234n } : short(r3);
      const t1 = await rpc(ep, 'debug_traceCall', [{ to: mc, data: getEthBal }, 'latest', { tracer: 'callTracer', stateOverrides: { [target]: { balance: bigBal } } }]);
      ov.debug_traceCall_stateOverrides = t1.ok ? { output: t1.result?.output, works: t1.result?.output && BigInt(t1.result.output) === 10n ** 18n } : short(t1);
      const t2 = await rpc(ep, 'debug_traceCall', [{ to: mc, data: getTs }, 'latest', { tracer: 'callTracer', blockOverrides: { time: '0x5f5e100' } }]);
      ov.debug_traceCall_blockOverrides_time = t2.ok ? { output: t2.result?.output, works: t2.result?.output && BigInt(t2.result.output) === 0x5f5e100n } : short(t2);
      const t3 = await rpc(ep, 'debug_traceCall', [{ to: mc, data: getNum }, 'latest', { tracer: 'callTracer', blockOverrides: { number: '0x1234' } }]);
      ov.debug_traceCall_blockOverrides_number = t3.ok ? { output: t3.result?.output, works: t3.result?.output && BigInt(t3.result.output) === 0x1234n } : short(t3);
      rw.overrides = { r1, r2, r2b, r3, t1, t2, t3 };
    }
  }

  // ---- debug_traceBlockByNumber / ByHash ----
  const tb: any = (out.traceBlock2 = {});
  for (const [label, cfg] of [['callTracer', { tracer: 'callTracer' }], ['prestate', { tracer: 'prestateTracer' }], ['prestate diffMode', { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]] as const) {
    const r = await rpc(ep, 'debug_traceBlockByNumber', [hex(traceBlockNum), cfg]);
    const bytes = r.ok ? JSON.stringify(r.result).length : 0;
    const txs = r.ok && Array.isArray(r.result) ? r.result.length : null;
    tb[`ByNumber ${label}`] = r.ok ? { ms: Math.round(r.ms), bytes, txs } : short(r);
    rw[`traceBlock:${label}`] = r.ok ? (JSON.stringify(r.result).length > 20000 ? '[truncated ' + bytes + ']' : r.result) : r.error;
  }
  if (hash) {
    const r = await rpc(ep, 'debug_traceBlockByHash', [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    tb['ByHash prestate diffMode'] = r.ok ? { ms: Math.round(r.ms), bytes: JSON.stringify(r.result).length } : short(r);
  }
  // old block trace
  const oldN = head - 100_000;
  if (oldN > 0) {
    const r = await rpc(ep, 'debug_traceBlockByNumber', [hex(oldN), { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    tb['ByNumber diffMode @-100k'] = short(r);
  }

  // ---- latency (20 sequential) ----
  if (callBal) {
    const lat: any = (out.latency = {});
    const series = async (label: string, fn: () => Promise<R>) => {
      const ms: number[] = []; let fail = 0;
      for (let i = 0; i < 20; i++) { const r = await fn(); if (r.ok) ms.push(r.ms); else fail++; await sleep(60); }
      lat[label] = { n: ms.length, fail, p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
    };
    await series('eth_call@latest', () => rpc(ep, 'eth_call', [callBal, 'latest'], 1));
    await series('debug_traceCall prestate@latest', () => rpc(ep, 'debug_traceCall', [callBal, 'latest', { tracer: 'prestateTracer' }], 1));
    await series('debug_traceCall prestate@blockNumber(-3)', () => rpc(ep, 'debug_traceCall', [callBal, hex(traceBlockNum), { tracer: 'prestateTracer' }], 1));
    await series('debug_traceCall callTracer@latest', () => rpc(ep, 'debug_traceCall', [callBal, 'latest', { tracer: 'callTracer' }], 1));
    if (hist['-100000']?.ok) await series('debug_traceCall prestate@-100k', () => rpc(ep, 'debug_traceCall', [callBal, hex(head - 100_000), { tracer: 'prestateTracer' }], 1));
  }

  // ---- rate limit burst ----
  if (!QUICK) {
    const N = 40; const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: N }, () => rpc(ep, 'eth_blockNumber', [], 1)));
    const lim = rs.filter((r) => !r.ok);
    out.rateLimit = { burst: N, failed: lim.length, http429: rs.filter((r) => r.http === 429).length, wallMs: Math.round(performance.now() - t0), sampleError: lim[0] ? short(lim[0]) : null };
    await sleep(3000);
  }
  return out;
}

// endpoints are different hosts, so probe them in parallel (each is sequential internally)
const only = process.env.K1_ONLY;
const results: any[] = await Promise.all(eps.filter((e) => !only || e.name.includes(only)).map(async (ep) => {
  console.error(`probing ${ep.secret ? ep.name : ep.url} ...`);
  try { const r = await probe(ep); mkdirSync('results/k1-partial', { recursive: true }); writeFileSync(`results/k1-partial/${ep.name.replace(/[^a-z0-9.]/gi, "_")}.json`, JSON.stringify(r, null, 2)); console.error(`finished ${ep.name}`); return r; }
  catch (e: any) { return { endpoint: ep.secret ? ep.name : ep.url, fatal: String(e?.message ?? e) }; }
}));
mkdirSync('results', { recursive: true });
const merged = readdirSync('results/k1-partial').filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync('results/k1-partial/' + f, 'utf8')));
writeFileSync('results/k1.json', JSON.stringify({ ranAt: new Date().toISOString(), quick: QUICK, results: merged }, null, 2));
writeFileSync(`results/k1-raw${only ? '-' + only.replace(/[^a-z0-9.]/gi, '_') : ''}.json`, JSON.stringify(raw, null, 2));
console.log('done; wrote results/k1.json and results/k1-raw.json');
