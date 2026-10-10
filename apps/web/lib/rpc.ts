import { makePublicClient, resolveChainConfig } from '@readset/core';
import type { PublicClient } from 'viem';

/**
 * Explaining a failed transaction needs ARCHIVE state plus tracing.
 *
 * The default mainnet endpoint keeps only about 7 days, so the forensic path pins archive
 * endpoints. docs/kill-tests/K1.md has the measured history window for each. They are not
 * interchangeable in practice: rpc2 (Goldsky) has been observed answering
 * "transaction not found" for a block that rpc-mainnet.monadinfra.com serves fine, so the
 * order here is "most reliable for historical traces first" and we fail over on data errors.
 *
 * viem's own fallback transport does not help: a JSON-RPC error response is an *answer*, not a
 * transport failure, so it never moves on. This failover is explicit for that reason.
 */
export const ARCHIVE_MAINNET = [
  'https://rpc-mainnet.monadinfra.com',
  'https://rpc2.monad.xyz',
] as const;

function endpoints(): string[] {
  const override = process.env.READSET_ARCHIVE_RPC?.trim();
  return override ? [override, ...ARCHIVE_MAINNET] : [...ARCHIVE_MAINNET];
}

const clients = new Map<string, PublicClient>();

function clientFor(url: string): PublicClient {
  let c = clients.get(url);
  if (!c) {
    c = makePublicClient(resolveChainConfig({ network: 'mainnet', rpcUrl: url }));
    clients.set(url, c);
  }
  return c;
}

/** An endpoint that lacks the data, rather than a transaction that genuinely does not exist. */
const RETRYABLE = /not found|historical|pruned|not available|missing trie|timeout|429|rate|capacity|internal error/i;

export interface ArchiveAttempt {
  url: string;
  error: string;
}

/**
 * Runs `fn` against each archive endpoint until one answers, and reports which one did.
 * The caller gets every failure, so a page can say *why* all of them declined.
 */
export async function withArchive<T>(
  fn: (client: PublicClient) => Promise<T>,
): Promise<{ value: T; url: string; attempts: ArchiveAttempt[] }> {
  const attempts: ArchiveAttempt[] = [];
  const urls = endpoints();

  for (const url of urls) {
    try {
      return { value: await fn(clientFor(url)), url, attempts };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      attempts.push({ url, error: msg.split('\n')[0] ?? msg });
      // A clearly non-recoverable error (bad input, say) should not burn the other endpoints.
      if (!RETRYABLE.test(msg)) throw Object.assign(err as Error, { attempts });
    }
  }

  const detail = attempts.map((a) => `${a.url}: ${a.error}`).join(' | ');
  throw Object.assign(new Error(`no archive endpoint could answer — ${detail}`), { attempts });
}

export function archiveUrl(): string {
  return endpoints()[0]!;
}
