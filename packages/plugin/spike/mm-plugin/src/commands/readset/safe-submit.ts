import { type CommandIO, CommandError, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from '@metamask/agent-wallet/plugin';
import { gate, writeReceipt } from '../../gate.js';

const inputs = {
  to: { type: InputFieldType.Text, flag: 'to', message: 'target', required: true, prompt: false },
  data: { type: InputFieldType.Text, flag: 'data', message: 'calldata', required: false, prompt: false },
  value: { type: InputFieldType.Text, flag: 'value', message: 'wei', required: false, prompt: false },
  chain: { type: InputFieldType.Text, flag: 'chain', message: 'chain id (default 10143)', required: false, prompt: false },
} satisfies InputSchema;

/**
 * safe-submit: gate (simulate at latest, refuse doomed sends) then hand the tx to the host's
 * policy-gated walletExecutor with an explicit `gas` (gas limit).
 */
export default class ReadsetSafeSubmit extends PluginCommand<Record<string, unknown>> {
  static override description = 'Gate a send with Readset, then submit through Agent Wallet with a tight gas limit.';
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = 'readset:safe-submit';

  async execute(io: CommandIO) {
    const a = await io.resolveInputs(inputs);
    const chainId = a.chain ? Number(a.chain) : 10143;
    const to = a.to as `0x${string}`;
    const data = a.data as `0x${string}` | undefined;
    const value = a.value ? BigInt(a.value as string) : undefined;
    const accounts: any = await (this.ctx.accountService as any).getAccounts?.();
    const from = (accounts?.[0]?.address ?? process.env.READSET_FROM) as `0x${string}`;
    const verdict = await gate(this.ctx.publicClient(chainId), { from, to, data, value, chainId });
    const rpath = process.env.READSET_RECEIPTS ?? 'readset-receipts.jsonl';
    if (!verdict.ok) {
      writeReceipt(rpath, { ts: new Date().toISOString(), chainId, from, to, verdict, sent: false });
      throw new CommandError(`READSET_REFUSED_${verdict.kind}`, verdict.reason, "Readset refused to sign: fix the cause or lower the amount, then retry.");
    }
    const exec = await this.ctx.walletExecutor(io, this.pluginCommandId); // wallet-submit; MetaMask policy still applies
    const res = await exec({ kind: 'transaction', chainId, transaction: { to, data, value, gas: verdict.gas } });
    writeReceipt(rpath, { ts: new Date().toISOString(), chainId, from, to, verdict, sent: true, result: res });
    return JSON.parse(JSON.stringify({ verdict, result: res }, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));
  }
}
