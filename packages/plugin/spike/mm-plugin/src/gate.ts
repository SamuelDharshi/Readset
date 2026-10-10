// Spike gate: simulate at latest, refuse doomed sends, set gas limit, write a receipt. Pure viem; no mocks.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PublicClient } from 'viem';

export interface GateInput { from: `0x${string}`; to: `0x${string}`; data?: `0x${string}`; value?: bigint; chainId: number }
export type GateVerdict =
  | { ok: true; gas: bigint; simulatedGas: bigint; block: bigint; maxCostWei: bigint }
  | { ok: false; reason: string; kind: 'REVERT' | 'INSUFFICIENT_FUNDS' | 'RPC'; block?: bigint };

export const GAS_BUFFER_BPS = 12000n; // placeholder 1.2x; real design uses Category Labs per-(to,selector) buffer

export async function gate(client: PublicClient, i: GateInput): Promise<GateVerdict> {
  const block = await client.getBlockNumber();
  const bal = await client.getBalance({ address: i.from });
  if (bal < (i.value ?? 0n))
    return { ok: false, kind: 'INSUFFICIENT_FUNDS', block, reason: `balance ${bal} wei < value ${i.value} wei` };
  let simulatedGas: bigint;
  try {
    simulatedGas = await client.estimateGas({ account: i.from, to: i.to, data: i.data, value: i.value });
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e);
    if (/insufficient funds|exceeds (the )?balance|reserve/i.test(msg)) return { ok: false, kind: 'INSUFFICIENT_FUNDS', reason: msg, block };
    return { ok: false, kind: 'REVERT', reason: msg, block };
  }
  const gas = (simulatedGas * GAS_BUFFER_BPS) / 10000n;
  const [price, balance] = await Promise.all([client.getGasPrice(), client.getBalance({ address: i.from })]);
  const maxCostWei = gas * price + (i.value ?? 0n); // Monad charges gas_limit x price
  if (balance < maxCostWei)
    return { ok: false, kind: 'INSUFFICIENT_FUNDS', block, reason: `balance ${balance} wei < gas_limit*price+value ${maxCostWei} wei` };
  return { ok: true, gas, simulatedGas, block, maxCostWei };
}

export function writeReceipt(path: string, rec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}
