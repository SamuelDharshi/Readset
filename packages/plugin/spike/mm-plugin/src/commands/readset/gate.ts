import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from '@metamask/agent-wallet/plugin';
import { createPublicClient, http, defineChain } from 'viem';
import { gate, writeReceipt } from '../../gate.js';

const inputs = {
  from: { type: InputFieldType.Text, flag: 'from', message: 'sender', required: true, prompt: false },
  to: { type: InputFieldType.Text, flag: 'to', message: 'target', required: true, prompt: false },
  data: { type: InputFieldType.Text, flag: 'data', message: 'calldata', required: false, prompt: false },
  value: { type: InputFieldType.Text, flag: 'value', message: 'wei', required: false, prompt: false },
  rpc: { type: InputFieldType.Text, flag: 'rpc', message: 'rpc url', required: false, prompt: false },
} satisfies InputSchema;

/** Auth-free dry run of the Readset gate (proves the plugin registers + runs inside `mm`). */
export default class ReadsetGate extends PluginCommand<Record<string, unknown>> {
  static override description = 'Readset gate dry-run on Monad testnet (no signing, no auth).';
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'readset:gate';

  async execute(io: CommandIO) {
    const a = await io.resolveInputs(inputs);
    const rpc = (a.rpc as string) || 'https://testnet-rpc.monad.xyz';
    const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    const client = createPublicClient({ chain, transport: http(rpc) });
    const v = await gate(client, { from: a.from as `0x${string}`, to: a.to as `0x${string}`, data: a.data as `0x${string}` | undefined, value: a.value ? BigInt(a.value as string) : undefined, chainId: 10143 });
    const receipt = { ts: new Date().toISOString(), chainId: 10143, from: a.from, to: a.to, verdict: v };
    writeReceipt(process.env.READSET_RECEIPTS ?? 'readset-receipts.jsonl', receipt);
    return JSON.parse(JSON.stringify(receipt, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
  }
}
