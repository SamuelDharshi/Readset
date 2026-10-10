import { encodeFunctionData, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem';
import type { BreakerStatus, Hex, Policy, Receipt, TxRequest } from './contract.js';
import { loadCoreBindings } from './core-bridge.js';
import { attachOutcome, guard, publicClientFor, refusalError, type GuardDecision } from './guard.js';

/** Minimum viem-shaped request this wrapper can guard. */
export interface GuardableTx {
  to?: Hex | null;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
  nonce?: number;
  account?: Account | Hex;
}

export interface GuardedExtras {
  /** Run breaker -> gate -> receipt without sending. Never throws on a refusal. */
  guard(tx: GuardableTx): Promise<GuardDecision>;
  readset: {
    /** Policy in force (from @readset/core when it exports loadPolicy). */
    policy(): Promise<Policy>;
    breaker(): Promise<BreakerStatus>;
    receipts(limit?: number): Promise<Receipt[]>;
    /** Decision for the most recent send/guard on this client. */
    lastDecision?: GuardDecision;
    /** Resolves when the last send's outcome has been attached to its receipt. */
    lastOutcome?: Promise<Receipt | undefined>;
    /** Per-function: 'core' or the temporary 'fallback' stand-in. */
    source(): Promise<Record<string, 'core' | 'fallback'>>;
  };
}

/**
 * A guarded client IS a viem WalletClient (same methods, same parameters, same return types)
 * plus `guard()` and `readset`. The one behavioural difference: `sendTransaction` and
 * `writeContract` can throw `DoomedTxError` instead of signing.
 */
export type GuardedWalletClient<TClient> = TClient & GuardedExtras;

export interface CreateGuardedWalletClientOptions<TClient> {
  walletClient: TClient;
  /** Used for simulation, gas price, balances and receipt watching. Derived from the wallet's chain if omitted. */
  publicClient?: PublicClient;
  /** Pinned policy. Omit to load it from @readset/core / the policy file on every send. */
  policy?: Policy;
  /** Await the mined outcome before returning the hash (default false: it is attached in the background). */
  awaitOutcome?: boolean;
  /** Called with every decision, allowed or refused. */
  onDecision?: (d: GuardDecision) => void;
}

type AnyWalletClient = WalletClient<Transport, Chain | undefined, Account | undefined>;

function addressOf(client: AnyWalletClient, override?: Account | Hex): Hex {
  const acc = override ?? client.account;
  if (!acc) throw new Error('No account: pass `account` or give the wallet client one.');
  return (typeof acc === 'string' ? acc : acc.address) as Hex;
}

export function createGuardedWalletClient<TClient extends AnyWalletClient>(
  opts: CreateGuardedWalletClientOptions<TClient>,
): GuardedWalletClient<TClient> {
  const wallet = opts.walletClient;
  const publicClient = opts.publicClient ?? publicClientFor(wallet);
  let chainIdCache: number | undefined = wallet.chain?.id;

  const chainId = async (): Promise<number> => {
    if (chainIdCache === undefined) chainIdCache = await publicClient.getChainId();
    return chainIdCache;
  };

  const extras: GuardedExtras = {
    guard: async (tx) => decide(await toTxRequest(tx)),
    readset: {
      policy: async () => opts.policy ?? (await (await loadCoreBindings()).loadPolicy()),
      breaker: async () => {
        const core = await loadCoreBindings();
        const policy = opts.policy ?? (await core.loadPolicy());
        return core.checkBreaker({ policy, chainId: await chainId(), wallet: addressOf(wallet) });
      },
      receipts: async (limit = 20) => {
        const core = await loadCoreBindings();
        return core.recentReceipts({ limit, chainId: await chainId() });
      },
      source: async () => (await loadCoreBindings()).from,
    },
  };

  async function toTxRequest(tx: GuardableTx & { data?: Hex }): Promise<TxRequest> {
    return {
      from: addressOf(wallet, tx.account),
      to: (tx.to ?? null) as Hex | null,
      data: tx.data ?? '0x',
      value: tx.value ?? 0n,
      gas: tx.gas,
      nonce: tx.nonce,
      chainId: await chainId(),
    };
  }

  async function decide(tx: TxRequest): Promise<GuardDecision> {
    const d = await guard({ tx, publicClient, policy: opts.policy });
    extras.readset.lastDecision = d;
    opts.onDecision?.(d);
    return d;
  }

  /** Gate, then hand the chosen gas limit to the real viem action and watch the outcome. */
  async function send<TArgs extends Record<string, unknown>>(
    action: 'sendTransaction' | 'writeContract',
    args: TArgs,
    tx: TxRequest,
  ): Promise<Hex> {
    const d = await decide(tx);
    if (!d.allowed) throw refusalError(d);
    const underlying = Reflect.get(wallet, action) as (a: unknown) => Promise<Hex>;
    const hash = await underlying.call(wallet, { ...args, gas: d.gasLimit ?? tx.gas });
    const watcher = attachOutcome({ publicClient, receiptId: d.receipt.id, txHash: hash }).catch(
      () => undefined,
    );
    extras.readset.lastOutcome = watcher;
    if (opts.awaitOutcome) await watcher;
    return hash;
  }

  const overrides: Record<string, unknown> = {
    ...extras,
    sendTransaction: async (args: GuardableTx & Record<string, unknown>) =>
      send('sendTransaction', args, await toTxRequest(args)),
    writeContract: async (args: Record<string, unknown>) => {
      const data = encodeFunctionData({
        abi: args.abi,
        functionName: args.functionName,
        args: args.args ?? [],
      } as unknown as Parameters<typeof encodeFunctionData>[0]);
      const tx = await toTxRequest({
        to: args.address as Hex,
        data,
        value: args.value as bigint | undefined,
        gas: args.gas as bigint | undefined,
        nonce: args.nonce as number | undefined,
        account: args.account as Account | Hex | undefined,
      });
      return send('writeContract', args, tx);
    },
  };

  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    has(target, prop) {
      return (typeof prop === 'string' && prop in overrides) || Reflect.has(target, prop);
    },
  }) as GuardedWalletClient<TClient>;
}
