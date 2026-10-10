import { NextResponse } from 'next/server';
import { ReceiptStore, recentReceipts } from '@readset/core';
import { STATE_ROOT } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The audit trail. Receipts live in an append-only JSONL store under .readset/, written by
 * whichever surface made the decision — the viem wrapper, the MCP server or the plugin.
 * `verifyAll` re-hashes every record, so the page can state whether the log is intact rather
 * than merely displaying it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
  const chainParam = url.searchParams.get('chainId');
  const chainId = chainParam ? Number(chainParam) : undefined;

  try {
    const receipts = recentReceipts({ limit, root: STATE_ROOT, ...(chainId === undefined ? {} : { chainId }) });
    const store = new ReceiptStore({ root: STATE_ROOT, ...(chainId === undefined ? {} : { chainId }) });
    // verifyAll re-hashes every record and names the ones that do not match.
    let integrity: { checked: number; bad: { id: string; reason: string }[] } | null = null;
    try {
      integrity = store.verifyAll(chainId === undefined ? {} : { chainId });
    } catch {
      integrity = null;
    }
    return NextResponse.json({
      ok: true,
      root: store.root,
      count: receipts.length,
      integrity,
      receipts,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
