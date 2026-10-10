// The "Why your bot lost" server. Everything it returns is read from the real chain or from the
// committed measurement outputs; there is no fixture path and no sample data.
//
//   npx tsx packages/api/src/server.ts          # http://localhost:5173

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { explainFailedTx } from '@readset/core';
import { archiveClient, archiveUrl } from './rpc.js';
import { buildStats } from './stats.js';

const PORT = Number(process.env.PORT ?? 5173);
const WEB_DIR = path.resolve(process.cwd(), 'packages/web');
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** Cache explanations: each one costs several archive traces, and the page re-requests on reload. */
const explainCache = new Map<string, unknown>();

async function handleExplain(res: ServerResponse, hash: string): Promise<void> {
  if (!TX_HASH.test(hash)) {
    return json(res, 400, { ok: false, error: 'not a transaction hash', hint: 'Pass a 32-byte 0x… hash.' });
  }
  const key = hash.toLowerCase();
  const hit = explainCache.get(key);
  if (hit) return json(res, 200, hit);

  try {
    const e = await explainFailedTx(archiveClient(), key as `0x${string}`);
    const body = { ok: true, rpc: archiveUrl(), explanation: e };
    explainCache.set(key, body);
    return json(res, 200, body);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // The single most likely failure is a hash outside the endpoint's history window, and the
    // operator can act on that, so it gets its own message instead of a generic 500.
    const notFound = /not found|historical|pruned/i.test(msg);
    return json(res, notFound ? 404 : 502, {
      ok: false,
      error: msg,
      rpc: archiveUrl(),
      hint: notFound
        ? 'This endpoint may not hold that block. Set READSET_ARCHIVE_RPC to a full-archive endpoint (see docs/kill-tests/K1.md).'
        : 'The archive endpoint failed or throttled. Retry, or set READSET_ARCHIVE_RPC.',
    });
  }
}

/**
 * The test summary is written by the suite itself (vitest --reporter=json, summarised into
 * results/test-summary.json). Serving that file rather than a hardcoded count means the page
 * cannot claim a green suite that nobody actually ran.
 */
async function handleTests(res: ServerResponse): Promise<void> {
  const dir = process.env.READSET_RESULTS_DIR ?? path.resolve(process.cwd(), 'results');
  try {
    const raw = await readFile(path.join(dir, 'test-summary.json'), 'utf8');
    return json(res, 200, { ok: true, ...(JSON.parse(raw) as object) });
  } catch {
    return json(res, 200, {
      ok: false,
      error: 'no results/test-summary.json yet',
      hint: 'npx vitest run --reporter=json --outputFile=.readset/tmp/tests.json',
    });
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  // Never serve outside the web directory.
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`not found: ${rel}`);
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/stats') {
    return void json(res, 200, { ok: true, ...buildStats() });
  }
  if (url.pathname === '/api/explain') {
    return void handleExplain(res, (url.searchParams.get('hash') ?? '').trim());
  }
  if (url.pathname === '/api/tests') {
    return void handleTests(res);
  }
  if (url.pathname === '/api/health') {
    return void json(res, 200, { ok: true, rpc: archiveUrl() });
  }
  return void serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  const s = buildStats();
  console.log(`\n  Readset — "Why your bot lost"`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  archive rpc : ${archiveUrl()}`);
  console.log(
    `  census      : ${
      s.census
        ? `${s.census.failedTxs.toLocaleString()} failed txs, ${Math.round(s.census.revertBurnMON).toLocaleString()} MON burned over ${s.census.days}d`
        : 'results/k2-sample.json not found — run scripts/k2-sample.ts --full'
    }`,
  );
  console.log('');
});
