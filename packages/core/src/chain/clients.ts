import { createPublicClient, createWalletClient, http, type Chain, type HttpTransportConfig, type HttpTransport, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from '../types.js';
import { alchemyUrl, networkNameOf, resolveNetwork, type NetworkName } from './monad.js';

function processEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

type Env = Record<string, string | undefined>;
/**
 * READSET_<name> is primary. HOTSLOT_<name> is the legacy name from the predecessor project,
 * and for the RPC URL we also accept MONAD_RPC_URL / MONAD_TESTNET_RPC_URL, which is what most
 * Monad tooling calls it — someone with those already set should not have to rename anything.
 */
function envVar(
  env: Env,
  name: 'NETWORK' | 'RPC_URL' | 'PRIVATE_KEY',
  network?: 'mainnet' | 'testnet',
): string | undefined {
  const own = env[`READSET_${name}`] || env[`HOTSLOT_${name}`];
  if (own) return own;
  if (name !== 'RPC_URL') return undefined;
  return (network === 'testnet' ? env.MONAD_TESTNET_RPC_URL : env.MONAD_RPC_URL) || undefined;
}

export interface ChainOptions {
  /** 'testnet' | 'mainnet'; default env READSET_NETWORK or 'testnet'. */
  network?: string;
  /** Explicit RPC URL; default env READSET_RPC_URL. Wins over Alchemy. */
  rpcUrl?: string;
  /** Default env ALCHEMY_API_KEY. */
  alchemyApiKey?: string;
  /** Wallet only; default env READSET_PRIVATE_KEY. */
  privateKey?: string;
  /** Per-request timeout, ms (default 20000). */
  timeoutMs?: number;
  /** Retries on transient failure / 429 (default 3, exponential backoff 400ms base). */
  retryCount?: number;
  /** JSON-RPC batching. Default: off for public endpoints (some cap batch at 1), size 50 for Alchemy. */
  batch?: boolean | { batchSize?: number; wait?: number };
  env?: Record<string, string | undefined>;
}

export interface ResolvedChainConfig {
  chain: Chain;
  network: NetworkName;
  rpcUrl: string;
  rpcSource: 'READSET_RPC_URL' | 'alchemy' | 'public';
}

export function resolveChainConfig(opts: ChainOptions = {}): ResolvedChainConfig {
  const env = opts.env ?? processEnv();
  const chain = resolveNetwork(opts.network ?? envVar(env, 'NETWORK') ?? 'testnet');
  const network = networkNameOf(chain.id);
  const override = (opts.rpcUrl ?? envVar(env, 'RPC_URL', network))?.trim();
  if (override) return { chain, network, rpcUrl: override, rpcSource: 'READSET_RPC_URL' };
  const key = (opts.alchemyApiKey ?? env.ALCHEMY_API_KEY)?.trim();
  if (key) return { chain, network, rpcUrl: alchemyUrl(network, key), rpcSource: 'alchemy' };
  return { chain, network, rpcUrl: chain.rpcUrls.default.http[0]!, rpcSource: 'public' };
}

/** Redact an API key embedded in an RPC URL path, for logging. */
export function redactUrl(url: string): string {
  return url.replace(/(\/v2\/)[^/?#]+/, '$1***');
}

function transportFor(cfg: ResolvedChainConfig, opts: ChainOptions) {
  const batchOpt = opts.batch ?? (cfg.rpcSource === 'alchemy');
  const conf: HttpTransportConfig = {
    timeout: opts.timeoutMs ?? 20_000,
    retryCount: opts.retryCount ?? 3,
    retryDelay: 400,
  };
  if (batchOpt) conf.batch = batchOpt === true ? { batchSize: 50, wait: 10 } : { batchSize: 50, wait: 10, ...batchOpt };
  return http(cfg.rpcUrl, conf);
}

export function makePublicClient(opts: ChainOptions = {}): PublicClient<HttpTransport, Chain> {
  const cfg = resolveChainConfig(opts);
  return createPublicClient({ chain: cfg.chain, transport: transportFor(cfg, opts) });
}

export function makeWalletClient(opts: ChainOptions = {}): WalletClient<HttpTransport, Chain, PrivateKeyAccount> {
  const env = opts.env ?? processEnv();
  const pk = (opts.privateKey ?? envVar(env, 'PRIVATE_KEY'))?.trim();
  if (!pk) {
    throw new Error('READSET_PRIVATE_KEY is not set: a wallet client needs a 0x-prefixed 32-byte hex private key.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    // Never echo the value.
    throw new Error('READSET_PRIVATE_KEY is malformed: expected 0x followed by 64 hex characters.');
  }
  const cfg = resolveChainConfig(opts);
  const account = privateKeyToAccount(pk as Hex);
  return createWalletClient({ account, chain: cfg.chain, transport: transportFor(cfg, opts) });
}
