import {
  type CommandIO,
  CommandError,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { makePublicClient, resolveChainConfig } from '@readset/core';
import { attachHash, decide } from '../../decide.js';
import { buildTx } from '../../tx.js';
import { jsonSafe } from '../../json.js';

const inputs = {
  to: { type: InputFieldType.Text, flag: 'to', message: 'target', required: true, prompt: false },
  data: { type: InputFieldType.Text, flag: 'data', message: 'calldata', required: false, prompt: false },
  value: { type: InputFieldType.Text, flag: 'value', message: 'wei', required: false, prompt: false },
  network: { type: InputFieldType.Text, flag: 'network', message: 'testnet | mainnet', required: false, prompt: false },
  rpc: { type: InputFieldType.Text, flag: 'rpc', message: 'rpc url', required: false, prompt: false },
} satisfies InputSchema;

/**
 * Gate the send, then hand it to the host's policy-gated walletExecutor with an explicit gas LIMIT.
 *
 * An agent calls this INSTEAD OF a raw send. It is cooperative: Agent Wallet has no interception
 * hook (docs/kill-tests/K3.md), so an agent that calls `mm transfer` directly is not guarded.
 * MetaMask's own policies still apply on top of this — they decide what the agent may do, Readset
 * decides whether this particular send is worth doing right now.
 */
export default class ReadsetSafeSubmit extends PluginCommand<Record<string, unknown>> {
  static override description = 'Gate a send with Readset, then submit it through Agent Wallet with a chosen gas limit.';
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'readset:safe-submit';

  async execute(io: CommandIO) {
    const a = await io.resolveInputs(inputs);
    const cfg = resolveChainConfig({
      ...(a.network ? { network: a.network as string } : {}),
      ...(a.rpc ? { rpcUrl: a.rpc as string } : {}),
    });
    const chainId = cfg.chain.id;

    const accounts = await (
      this.ctx.accountService as unknown as { getAccounts?: () => Promise<{ address?: string }[]> }
    ).getAccounts?.();
    const from = (accounts?.[0]?.address ?? process.env.READSET_FROM) as `0x${string}` | undefined;
    if (!from) {
      throw new CommandError(
        'READSET_NO_SENDER',
        'No account from the host and no READSET_FROM set.',
        'Run `mm login`, or pass READSET_FROM=<address> to gate without the host wallet.',
      );
    }

    const tx = buildTx({
      from,
      to: a.to as `0x${string}`,
      ...(a.data === undefined ? {} : { data: a.data as string }),
      ...(a.value === undefined ? {} : { value: a.value as string }),
      chainId,
    });

    const d = await decide({ client: makePublicClient(cfg), tx });
    if (!d.allowed) {
      // The receipt is already written: a refusal is part of the audit trail, not an absence of one.
      throw new CommandError(
        `READSET_${d.verdict.toUpperCase()}`,
        `${d.reason ?? 'refused'} (receipt ${d.receipt.id})`,
        d.verdict === 'refused_breaker'
          ? 'The circuit breaker is tripped. Inspect the receipts, fix the cause, then reset it.'
          : 'Readset refused to sign: the state this send depends on has already moved against it.',
      );
    }

    const exec = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const res = (await exec({
      kind: 'transaction',
      chainId,
      transaction: {
        to: tx.to as `0x${string}`,
        ...(tx.data === undefined ? {} : { data: tx.data }),
        ...(tx.value === undefined ? {} : { value: tx.value }),
        // Monad charges the LIMIT, so Readset sets it rather than letting the host pad it.
        ...(d.gasLimit === undefined ? {} : { gas: d.gasLimit }),
      },
    })) as { hash?: string; transactionHash?: string } | undefined;

    const hash = (res?.hash ?? res?.transactionHash) as `0x${string}` | undefined;
    const receipt = hash ? attachHash(d.receipt, hash) : d.receipt;

    return jsonSafe({
      allowed: true,
      verdict: d.verdict,
      gasLimit: d.gasLimit ?? null,
      receiptId: receipt.id,
      txHash: hash ?? null,
      sent: Boolean(hash),
      result: res ?? null,
    });
  }
}
