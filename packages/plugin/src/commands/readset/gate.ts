import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from '@metamask/agent-wallet/plugin';
import { makePublicClient, resolveChainConfig } from '@readset/core';
import { decide } from '../../decide.js';
import { buildTx } from '../../tx.js';
import { jsonSafe } from '../../json.js';

const inputs = {
  from: { type: InputFieldType.Text, flag: 'from', message: 'sender', required: true, prompt: false },
  to: { type: InputFieldType.Text, flag: 'to', message: 'target', required: true, prompt: false },
  data: { type: InputFieldType.Text, flag: 'data', message: 'calldata', required: false, prompt: false },
  value: { type: InputFieldType.Text, flag: 'value', message: 'wei', required: false, prompt: false },
  rpc: { type: InputFieldType.Text, flag: 'rpc', message: 'rpc url', required: false, prompt: false },
  network: { type: InputFieldType.Text, flag: 'network', message: 'testnet | mainnet', required: false, prompt: false },
} satisfies InputSchema;

/**
 * Dry run of the Readset gate: no signing, no auth, no host wallet.
 *
 * This is the command to show a judge first, because it needs nothing but an RPC: it prints the
 * verdict, the reason, the chosen gas limit and the receipt id.
 */
export default class ReadsetGate extends PluginCommand<Record<string, unknown>> {
  static override description = 'Readset gate dry-run: would this send revert, and what would it cost?';
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'readset:gate';

  async execute(io: CommandIO) {
    const a = await io.resolveInputs(inputs);
    const cfg = resolveChainConfig({
      ...(a.network ? { network: a.network as string } : {}),
      ...(a.rpc ? { rpcUrl: a.rpc as string } : {}),
    });
    const client = makePublicClient(cfg);
    const tx = buildTx({
      from: a.from as `0x${string}`,
      to: a.to as `0x${string}`,
      ...(a.data === undefined ? {} : { data: a.data as string }),
      ...(a.value === undefined ? {} : { value: a.value as string }),
      chainId: cfg.chain.id,
    });

    const d = await decide({ client, tx });
    return jsonSafe({
      allowed: d.allowed,
      verdict: d.verdict,
      reason: d.reason ?? null,
      gasLimit: d.gasLimit ?? null,
      receiptId: d.receipt.id,
      chainId: tx.chainId,
      dependencySlots: d.receipt.dependencySet?.slots.length ?? 0,
      sent: false,
    });
  }
}
