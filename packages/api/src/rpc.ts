import { makePublicClient, resolveChainConfig } from '@readset/core';
import type { PublicClient } from 'viem';

/**
 * Explaining a failed transaction needs ARCHIVE state and tracing, and the default mainnet
 * endpoint (rpc.monad.xyz) keeps only about 7 days and will answer
 * "transaction not found" for anything older. docs/kill-tests/K1.md measured the history
 * window per endpoint; these two are full archive with debug_* enabled.
 */
export const ARCHIVE_MAINNET = ['https://rpc2.monad.xyz', 'https://rpc-mainnet.monadinfra.com'] as const;

let cached: PublicClient | undefined;

export function archiveClient(): PublicClient {
  if (cached) return cached;
  const rpcUrl = process.env.READSET_ARCHIVE_RPC?.trim() || ARCHIVE_MAINNET[0];
  const cfg = resolveChainConfig({ network: 'mainnet', rpcUrl });
  cached = makePublicClient(cfg);
  return cached;
}

export function archiveUrl(): string {
  return process.env.READSET_ARCHIVE_RPC?.trim() || ARCHIVE_MAINNET[0];
}
