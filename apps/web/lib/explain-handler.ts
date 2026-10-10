import { NextResponse } from 'next/server';
import { explainFailedTx, getTxBurn } from '@readset/core';
import { withArchive, type ArchiveAttempt } from './rpc';
import { withPublicVerdict } from './verdict';

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Each explanation costs several archive traces, so repeats within a run come from memory. */
const cache = new Map<string, unknown>();

const jsonSafe = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

/**
 * One handler behind both /api/tx/[hash] and /api/explain?hash=.
 *
 * A successful transaction is an ANSWER, not an error: the caller gets `succeeded: true` with a
 * plain sentence, so the page can say "nothing went wrong here" instead of showing a failure.
 */
export async function explainTx(rawHash: string): Promise<Response> {
  const hash = (rawHash ?? '').trim();
  if (!TX_HASH.test(hash)) {
    return NextResponse.json(
      { ok: false, error: 'not a transaction hash', hint: 'Pass a 32-byte 0x… hash.' },
      { status: 400 },
    );
  }

  const key = hash.toLowerCase();
  const hit = cache.get(key);
  if (hit) return NextResponse.json(hit);

  try {
    // Cheap first: one tx + receipt tells us whether there is anything to explain at all,
    // before spending a dozen archive traces on it.
    const { value: burn, url } = await withArchive((c) => getTxBurn(c, key as `0x${string}`));
    if (burn.status === 1) {
      return NextResponse.json(
        {
          ok: false,
          succeeded: true,
          rpc: url,
          error: `Transaction ${key.slice(0, 12)}… succeeded in block ${burn.blockNumber}. It paid ${(
            Number(burn.burnedWei) / 1e18
          ).toFixed(6)} MON and reverted nothing.`,
        },
        { status: 200 },
      );
    }

    const { value, url: traceUrl, attempts } = await withArchive((client) =>
      explainFailedTx(client, key as `0x${string}`),
    );
    const body = jsonSafe({
      ok: true,
      rpc: traceUrl,
      // Endpoints that declined, so a slow answer explains itself.
      skipped: attempts,
      // Normalised at the boundary: a funds/reserve refusal is reported as 'excluded-funds',
      // never 'unavoidable'. See lib/verdict.ts.
      explanation: withPublicVerdict(value),
    });
    cache.set(key, body);
    return NextResponse.json(body);
  } catch (err) {
    const e = err as Error & { attempts?: ArchiveAttempt[] };
    const msg = e.message ?? String(err);
    const missing = /not found/i.test(msg);
    return NextResponse.json(
      {
        ok: false,
        error: missing ? `No archive endpoint we try holds transaction ${key.slice(0, 12)}….` : msg,
        attempts: e.attempts ?? [],
        hint: missing
          ? 'It may not exist, or it may be outside their history window — set READSET_ARCHIVE_RPC (or MONAD_RPC_URL) to your own archive node. See docs/kill-tests/K1.md.'
          : 'Every archive endpoint failed or throttled. Retry, or set READSET_ARCHIVE_RPC.',
      },
      { status: missing ? 404 : 502 },
    );
  }
}
