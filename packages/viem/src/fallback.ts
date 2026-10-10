/**
 * TEMPORARY STAND-IN for @readset/core's gate / receipts / breaker.
 *
 * Why it exists: @readset/core did not yet export `gate`, `recordAttempt` or `checkBreaker`
 * when this package was written, and this package must compile and be testable against real
 * Monad RPC today. Everything here does real RPC work and writes real files; nothing is
 * mocked or faked. It is deliberately the thinnest thing that honours the contract in
 * `contract.ts`: simulate at `latest`, charge-the-full-limit funds check, JSONL receipts,
 * revert-streak / hourly-burn breaker.
 *
 * TODO(core): DELETE THIS FILE once @readset/core exports gate/recordAttempt/checkBreaker/
 * recentReceipts/recordOutcome. `core-bridge.ts` already prefers core's versions when present,
 * so removing this file is a one-line change there. It does NOT implement core's real work
 * (prestateTracer dependency sets, slot labelling, Category Labs' per-(to,selector) gas buffer,
 * Monad reserve-balance rules, per-target policy limits) and must not be mistaken for it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decodeAbiParameters, type PublicClient } from 'viem';
import type {
  BreakerStatus,
  DoomedTx,
  GateInput,
  GateOutcome,
  Hex,
  Outcome,
  Policy,
  Receipt,
  TxRequest,
  Verdict,
} from './contract.js';

const env = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const cwd = (): string =>
  (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '.';

export const DEFAULT_POLICY: Policy = {
  maxConsecutiveReverts: 5,
  maxBurnPerHourWei: '100000000000000000', // 0.1 MON
  perTarget: [],
  gasBufferPct: 20,
  failClosed: true,
  refuseOnRevert: 'warn',
  stableRevertLookback: 3,
};

/** Directory for receipts and the policy file: READSET_STATE_DIR, else <cwd>/.readset. */
export function stateDir(): string {
  const d = env().READSET_STATE_DIR?.trim();
  return d ? resolve(d) : join(cwd(), '.readset');
}
export const receiptsPath = (): string => join(stateDir(), 'receipts.jsonl');
export const policyPath = (): string => join(stateDir(), 'policy.json');

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export const policyHash = (p: Policy): string =>
  sha256(
    canonical({
      maxConsecutiveReverts: p.maxConsecutiveReverts,
      maxBurnPerHourWei: p.maxBurnPerHourWei,
      perTarget: p.perTarget,
      gasBufferPct: p.gasBufferPct,
      failClosed: p.failClosed,
    }),
  );

// ---------------------------------------------------------------- revert decoding

const ERROR_STRING = '0x08c379a0';
const PANIC = '0x4e487b71';

/** Decode Error(string) / Panic(uint256); otherwise name the custom-error selector. */
export function decodeRevert(data?: Hex): string | undefined {
  if (!data || data === '0x') return undefined;
  try {
    if (data.startsWith(ERROR_STRING)) {
      const [msg] = decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}` as Hex);
      return String(msg);
    }
    if (data.startsWith(PANIC)) {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}` as Hex);
      return `Panic(0x${(code as bigint).toString(16)})`;
    }
  } catch {
    /* fall through to the selector form */
  }
  return `custom error ${data.slice(0, 10)}`;
}

interface RpcErr {
  message: string;
  code?: number;
  data?: Hex;
}

function rpcErr(e: unknown): RpcErr {
  let message = e instanceof Error ? e.message : String(e);
  let code: number | undefined;
  let data: Hex | undefined;
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const o = cur as Record<string, unknown>;
    if (typeof o.code === 'number' && code === undefined) code = o.code;
    if (typeof o.data === 'string' && /^0x[0-9a-fA-F]*$/.test(o.data)) data = o.data as Hex;
    if (typeof o.details === 'string' && o.details) message = o.details;
    if (typeof o.shortMessage === 'string' && !o.details && i === 0) message = o.shortMessage;
    cur = o.cause;
  }
  return { message, code, data };
}

const INSUFFICIENT = /insufficient funds|insufficient balance|exceeds (the )?balance|gas \* price/i;

// ---------------------------------------------------------------- gate (stand-in)

const hexQty = (n: bigint): Hex => `0x${n.toString(16)}`;

async function rawCall(client: PublicClient, tx: TxRequest): Promise<{ ok: true } | { ok: false; err: RpcErr }> {
  const params: Record<string, string> = { from: tx.from };
  if (tx.to) params.to = tx.to;
  if (tx.data && tx.data !== '0x') params.data = tx.data;
  if (tx.value && tx.value > 0n) params.value = hexQty(tx.value);
  if (tx.gas) params.gas = hexQty(tx.gas);
  try {
    await client.request({ method: 'eth_call', params: [params, 'latest'] } as never);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: rpcErr(e) };
  }
}

async function estimate(client: PublicClient, tx: TxRequest): Promise<bigint | undefined> {
  const params: Record<string, string> = { from: tx.from };
  if (tx.to) params.to = tx.to;
  if (tx.data && tx.data !== '0x') params.data = tx.data;
  if (tx.value && tx.value > 0n) params.value = hexQty(tx.value);
  try {
    const r = (await client.request({ method: 'eth_estimateGas', params: [params, 'latest'] } as never)) as Hex;
    return BigInt(r);
  } catch {
    return undefined;
  }
}

/** Minimal real gate: simulate at `latest`, then check the full `gas_limit x price` charge. */
export async function fallbackGate({ tx, policy, client }: GateInput): Promise<GateOutcome> {
  const sim = await rawCall(client, tx);
  if (!sim.ok && !INSUFFICIENT.test(sim.err.message)) {
    if (policy.failClosed === false && sim.err.code === undefined) {
      return { verdict: 'allowed', reason: 'simulation infra error, policy.failClosed=false' };
    }
    const doomed: DoomedTx = {
      reason: sim.err.message,
      revertData: sim.err.data,
      revertReason: decodeRevert(sim.err.data) ?? sim.err.message,
    };
    return { verdict: 'refused_doomed', reason: doomed.revertReason ?? doomed.reason, doomed };
  }

  const estimated = tx.gas ?? (await estimate(client, tx)) ?? 21_000n;
  const gasLimit =
    tx.gas ?? estimated + (estimated * BigInt(Math.max(0, Math.round(policy.gasBufferPct)))) / 100n;

  // Monad charges gas_limit x price even on revert, so the wallet must cover the whole limit.
  // TODO(core): core's gate also applies Monad's reserve-balance rule; this stand-in does not.
  const [balance, gasPrice] = await Promise.all([
    client.getBalance({ address: tx.from }),
    client.getGasPrice(),
  ]);
  const needed = gasLimit * gasPrice + (tx.value ?? 0n);
  if (balance < needed) {
    return {
      verdict: 'refused_funds',
      reason:
        `balance ${balance} wei < gas_limit*price+value ${needed} wei ` +
        `(gas_limit ${gasLimit}, price ${gasPrice} wei, value ${tx.value ?? 0n})`,
      gasLimit,
    };
  }
  return { verdict: 'allowed', gasLimit };
}

// ---------------------------------------------------------------- receipts (stand-in)

async function appendReceipt(r: Receipt): Promise<void> {
  const path = receiptsPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(r)}\n`, 'utf8');
}

export async function readReceiptLines(): Promise<Receipt[]> {
  try {
    const txt = await readFile(receiptsPath(), 'utf8');
    const out: Receipt[] = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Receipt);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function fallbackRecordAttempt(input: {
  tx: TxRequest;
  verdict: Verdict;
  policy: Policy;
  doomed?: DoomedTx;
  gasLimitChosen?: bigint;
  txHash?: Hex;
}): Promise<Receipt> {
  const body = {
    chainId: input.tx.chainId,
    tx: {
      from: input.tx.from,
      to: input.tx.to,
      data: (input.tx.data ?? '0x') as Hex,
      value: String(input.tx.value ?? 0n),
      gasLimitChosen: input.gasLimitChosen !== undefined ? String(input.gasLimitChosen) : undefined,
    },
    verdict: input.verdict,
    doomed: input.doomed,
    policyHash: policyHash(input.policy),
  };
  const receipt: Receipt = {
    version: 1,
    id: sha256(canonical(body)),
    createdAt: new Date().toISOString(),
    ...body,
    txHash: input.txHash,
  };
  await appendReceipt(receipt);
  return receipt;
}

/** Receipts are append-only JSONL, so an outcome is a second line with the same id. */
export async function fallbackRecordOutcome(input: {
  receiptId: string;
  txHash: Hex;
  outcome: Outcome;
}): Promise<Receipt | undefined> {
  const all = await readReceiptLines();
  const prev = [...all].reverse().find((r) => r.id === input.receiptId);
  if (!prev) return undefined;
  const updated: Receipt = { ...prev, txHash: input.txHash, outcome: input.outcome };
  await appendReceipt(updated);
  return updated;
}

/** Newest first, one entry per receipt id (the latest line wins). */
export async function fallbackRecentReceipts(input: { limit?: number; chainId?: number } = {}): Promise<Receipt[]> {
  const all = await readReceiptLines();
  const byId = new Map<string, Receipt>();
  for (const r of all) byId.set(r.id, r);
  const merged = [...byId.values()]
    .filter((r) => input.chainId === undefined || r.chainId === input.chainId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return merged.slice(0, input.limit ?? 20);
}

// ---------------------------------------------------------------- breaker (stand-in)

export async function fallbackCheckBreaker(input: { policy: Policy; chainId: number }): Promise<BreakerStatus> {
  const { policy, chainId } = input;
  const receipts = (await fallbackRecentReceipts({ limit: 500, chainId })).filter((r) => r.outcome || r.verdict === 'refused_doomed');
  let consecutiveReverts = 0;
  for (const r of receipts) {
    const bad = r.outcome ? r.outcome.status === 'reverted' : r.verdict === 'refused_doomed';
    if (!bad) break;
    consecutiveReverts++;
  }
  const since = Date.now() - 3_600_000;
  let burn = 0n;
  for (const r of receipts) {
    if (Date.parse(r.createdAt) < since) continue;
    if (r.outcome?.status === 'reverted') burn += BigInt(r.outcome.feePaidWei);
  }
  const limits = {
    maxConsecutiveReverts: policy.maxConsecutiveReverts,
    maxBurnPerHourWei: policy.maxBurnPerHourWei,
  };
  if (consecutiveReverts >= policy.maxConsecutiveReverts) {
    return {
      tripped: true,
      reason: `${consecutiveReverts} consecutive reverts >= maxConsecutiveReverts ${policy.maxConsecutiveReverts}`,
      consecutiveReverts,
      burnLastHourWei: String(burn),
      limits,
    };
  }
  if (burn >= BigInt(policy.maxBurnPerHourWei)) {
    return {
      tripped: true,
      reason: `burned ${burn} wei in the last hour >= maxBurnPerHourWei ${policy.maxBurnPerHourWei}`,
      consecutiveReverts,
      burnLastHourWei: String(burn),
      limits,
    };
  }
  return { tripped: false, consecutiveReverts, burnLastHourWei: String(burn), limits };
}

// ---------------------------------------------------------------- policy file (stand-in)

export async function fallbackLoadPolicy(): Promise<Policy> {
  try {
    const raw = JSON.parse(await readFile(policyPath(), 'utf8')) as Partial<Policy>;
    return { ...DEFAULT_POLICY, ...raw };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export async function fallbackSavePolicy(policy: Policy): Promise<Policy> {
  const path = policyPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  return policy;
}
