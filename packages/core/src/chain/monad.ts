import { defineChain } from 'viem';

/**
 * Monad network parameters. Verified 2026-10-06 against docs.monad.xyz
 * (network-information, testnet pages) and live `eth_chainId` probes; see docs/chain.md.
 */
export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com'],
      webSocket: ['wss://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' },
    monadscan: { name: 'Monadscan', url: 'https://testnet.monadscan.com' },
  },
  testnet: true,
});

export const monadMainnet = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.monad.xyz', 'https://rpc-mainnet.monadinfra.com'],
      webSocket: ['wss://rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://monadvision.com' },
    monadscan: { name: 'Monadscan', url: 'https://monadscan.com' },
  },
});

export type NetworkName = 'testnet' | 'mainnet';

export const FAUCET_URL = 'https://faucet.monad.xyz';

/** Alchemy host slug per network (RPC: https://<slug>.g.alchemy.com/v2/<key>). */
export const ALCHEMY_SLUG: Record<NetworkName, string> = {
  testnet: 'monad-testnet',
  mainnet: 'monad-mainnet',
};

export function resolveNetwork(name: string = 'testnet') {
  const n = name.trim().toLowerCase();
  if (n === 'testnet' || n === 'monad-testnet' || n === 'monadtestnet') return monadTestnet;
  if (n === 'mainnet' || n === 'monad' || n === 'monad-mainnet' || n === 'monadmainnet') return monadMainnet;
  throw new Error(`Unknown network "${name}". READSET_NETWORK must be "testnet" or "mainnet".`);
}

export function networkNameOf(chainId: number): NetworkName {
  if (chainId === monadTestnet.id) return 'testnet';
  if (chainId === monadMainnet.id) return 'mainnet';
  throw new Error(`Unsupported chain id ${chainId}`);
}

export function alchemyUrl(network: NetworkName, apiKey: string): string {
  return `https://${ALCHEMY_SLUG[network]}.g.alchemy.com/v2/${apiKey}`;
}
