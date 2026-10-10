/**
 * Real-network helpers for the @readset/viem tests. No mocks, no fixtures: every value here
 * comes from Monad testnet (chain 10143) over JSON-RPC at test time.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { monadTestnet } from '@readset/core';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import type { Hex } from '../src/index.js';

/** The project wallet from the PRD / K3 notes. Currently unfunded on testnet. */
export const PROJECT_WALLET: Hex = '0x28F0ae7b3dB471479196718794E0b3A4b9AB90BA';

export const RPC_URL =
  process.env.READSET_RPC_URL?.trim() || monadTestnet.rpcUrls.default.http[0]!;

export function publicClient(): PublicClient {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(RPC_URL, { timeout: 20_000, retryCount: 2 }),
  }) as PublicClient;
}

/** A wallet client over a plain address: enough to gate, since a refusal never signs. */
export function addressWalletClient(
  address: Hex = PROJECT_WALLET,
): WalletClient<HttpTransport, Chain, Account> {
  return createWalletClient({
    account: address,
    chain: monadTestnet,
    transport: http(RPC_URL, { timeout: 20_000, retryCount: 2 }),
  }) as unknown as WalletClient<HttpTransport, Chain, Account>;
}

/** null when the RPC is reachable, else the reason to skip loudly. */
export async function networkDown(): Promise<string | null> {
  if (offline()) return OFFLINE_REASON;
  try {
    const id = await publicClient().getChainId();
    if (id !== monadTestnet.id) return `RPC ${RPC_URL} reported chain ${id}, expected ${monadTestnet.id}`;
    return null;
  } catch (e) {
    return `Monad testnet RPC ${RPC_URL} unreachable: ${(e as Error).message}`;
  }
}

const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0');

/** Tokens seen moving on testnet; used first, then discovery via recent Transfer logs. */
const KNOWN_TOKENS: Array<{ token: Hex; holder: Hex }> = [
  { token: '0xd1ec521d1a49a1590b6ed06ed7d96daba24e28c1', holder: '0xa85f4e89eddf919eebd68c6de93ad69c6810ed67' },
  { token: '0x39ad31e31b8b202e6fa7bd8682e68ac4e66ce92a', holder: '0xa8c3eb37c94914dd253f19cba26a7e07122b84b3' },
];

export interface DoomedCall {
  token: Hex;
  holder: Hex;
  /** transferFrom(holder, spender, 1) — reverts because `spender` has no allowance. */
  data: Hex;
}

function transferFromData(holder: Hex, spender: Hex): Hex {
  return `0x23b872dd${pad(holder)}${pad(spender)}${(1n).toString(16).padStart(64, '0')}` as Hex;
}

async function revertsWithNoAllowance(client: PublicClient, token: Hex, holder: Hex, spender: Hex): Promise<boolean> {
  try {
    const allowance = (await client.request({
      method: 'eth_call',
      params: [{ to: token, data: `0xdd62ed3e${pad(holder)}${pad(spender)}` }, 'latest'],
    } as never)) as Hex;
    if (!allowance || BigInt(allowance) !== 0n) return false;
  } catch {
    return false;
  }
  try {
    await client.request({
      method: 'eth_call',
      params: [{ from: spender, to: token, data: transferFromData(holder, spender) }, 'latest'],
    } as never);
    return false; // it did not revert, so it is not doomed
  } catch {
    return true;
  }
}

/**
 * Find a real testnet ERC-20 whose `transferFrom` reverts for `spender` (no allowance).
 * Tries known tokens, then scans recent Transfer logs in 100-block windows (the RPC caps
 * eth_getLogs at 100 blocks). Returns null if nothing suitable is live right now.
 */
export async function findDoomedTransferFrom(
  client: PublicClient,
  spender: Hex = PROJECT_WALLET,
): Promise<DoomedCall | null> {
  for (const { token, holder } of KNOWN_TOKENS) {
    if (await revertsWithNoAllowance(client, token, holder, spender)) {
      return { token, holder, data: transferFromData(holder, spender) };
    }
  }
  const head = await client.getBlockNumber();
  for (let i = 0n; i < 1500n; i += 100n) {
    const logs = (await client
      .request({
        method: 'eth_getLogs',
        params: [
          {
            fromBlock: `0x${(head - i - 100n).toString(16)}`,
            toBlock: `0x${(head - i).toString(16)}`,
            topics: [TRANSFER_TOPIC],
          },
        ],
      } as never)
      .catch(() => [])) as Array<{ address: Hex; topics: Hex[] }>;
    for (const log of logs) {
      if (log.topics.length !== 3) continue;
      const holder = `0x${log.topics[2]!.slice(26)}` as Hex;
      if (await revertsWithNoAllowance(client, log.address, holder, spender)) {
        return { token: log.address, holder, data: transferFromData(holder, spender) };
      }
    }
  }
  return null;
}

export const ERC20_TRANSFER_FROM_ABI = [
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;
