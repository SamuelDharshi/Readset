import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { checkBreaker, loadPolicy, recentReceipts, resolveChainConfig } from '@readset/core';
import { jsonSafe } from '../../json.js';

const inputs = {
  wallet: { type: InputFieldType.Text, flag: 'wallet', message: 'wallet address', required: false, prompt: false },
  limit: { type: InputFieldType.Text, flag: 'limit', message: 'receipts to show', required: false, prompt: false },
  network: { type: InputFieldType.Text, flag: 'network', message: 'testnet | mainnet', required: false, prompt: false },
} satisfies InputSchema;

/** What the breaker thinks, and what the agent has been doing. The operator's view. */
export default class ReadsetStatus extends PluginCommand<Record<string, unknown>> {
  static override description = 'Readset status: breaker state, recent decisions and burn.';
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'readset:status';

  async execute(io: CommandIO) {
    const a = await io.resolveInputs(inputs);
    const cfg = resolveChainConfig({ ...(a.network ? { network: a.network as string } : {}) });
    const chainId = cfg.chain.id;
    const policy = loadPolicy();
    const limit = a.limit ? Number(a.limit) : 10;
    const receipts = recentReceipts({ limit, chainId });

    const accounts = await (
      this.ctx.accountService as unknown as { getAccounts?: () => Promise<{ address?: string }[]> }
    ).getAccounts?.();
    const wallet = ((a.wallet as string | undefined) ??
      accounts?.[0]?.address ??
      process.env.READSET_FROM) as `0x${string}` | undefined;

    // Trip state is per wallet: without one there is nothing to report, so say that
    // instead of showing a breaker that belongs to nobody.
    const breaker = wallet ? checkBreaker({ wallet, chainId }, { policy }) : undefined;

    const burnedWei = receipts.reduce(
      (acc, r) => acc + (r.outcome?.status === 'reverted' ? BigInt(r.outcome.feePaidWei) : 0n),
      0n,
    );

    return jsonSafe({
      chainId,
      network: cfg.network,
      wallet: wallet ?? null,
      breaker: breaker ? { allow: breaker.allow, reason: breaker.reason ?? null } : null,
      breakerUnavailable: breaker ? null : 'No wallet: pass --wallet, run `mm login`, or set READSET_FROM.',
      policy: {
        maxConsecutiveReverts: policy.maxConsecutiveReverts,
        maxBurnPerHourWei: policy.maxBurnPerHourWei,
      },
      burnedInShownReceiptsWei: burnedWei.toString(),
      receiptCount: receipts.length,
      receipts: receipts.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        verdict: r.verdict,
        to: r.tx.to,
        txHash: r.txHash ?? null,
        outcome: r.outcome?.status ?? null,
      })),
    });
  }
}
