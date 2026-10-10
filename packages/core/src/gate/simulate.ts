// The Gate, step 1: simulate a transaction before it is signed.
//
// Everything here is a real RPC call against a real Monad endpoint. Nothing is mocked and no state is
// invented: a verdict only ever comes from `eth_call` / `eth_estimateGas` output, or from a decode of the
// revert bytes the node returned.
//
// Two Monad facts shape this file (docs/facts.md #1a, docs/kill-tests/K1.md):
//  - Monad charges gas_limit x price, not gas used, so a tx that is going to revert pays its WHOLE limit.
//    That is the entire reason to simulate first.
//  - Public endpoint latency is spiky (K1: p50 ~0.2-1 s, p95 up to 15 s), so a live gate needs a hard
//    timeout and a second endpoint. Hence the failover pool below.
import { createPublicClient, decodeAbiParameters, http, type Chain, type PublicClient } from 'viem';
import type { Hex, SimulationResult, TxRequest } from '../types.js';
import { encodeBlockSelector, type BlockSelector } from '../trace/index.js';

// ---------------------------------------------------------------- errors

/** Per-endpoint failure detail for a request that never got an answer. */
export interface AttemptError {
  endpoint: string;
  error: string;
}

/** The node could not be reached / answered with a non-execution error on every endpoint. */
export class GateInfraError extends Error {
  constructor(
    message: string,
    public readonly attempts: AttemptError[],
  ) {
    super(message);
    this.name = 'GateInfraError';
  }
}

// ---------------------------------------------------------------- failover RPC pool

export interface FailoverOptions {
  /** Per-attempt timeout in ms. Default 2000 (K1's recommended hard timeout for the live gate). */
  timeoutMs?: number;
  /**
   * One last attempt on the first endpoint with this timeout, after every endpoint has failed fast.
   * Covers the measured p95 (up to 15 s) without making the common case wait. Default 15000; 0 disables.
   */
  patientTimeoutMs?: number;
  /**
   * Explicit endpoint list, used INSTEAD of the client's own endpoints (first = primary).
   * Default: the client's own URL, then the chain's other configured URLs.
   */
  endpoints?: string[];
}

export interface GateRpc {
  /** Endpoints in the order they are tried. */
  readonly endpoints: string[];
  /** The endpoint that answered the most recent successful request. */
  readonly lastEndpoint: string | undefined;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** A viem client bound to `endpoints[0]`, for helpers that need a PublicClient (e.g. the tracers). */
  client(endpoint?: string): PublicClient;
}

function transportUrl(client: PublicClient): string | undefined {
  const u = (client as unknown as { transport?: { url?: unknown } }).transport?.url;
  return typeof u === 'string' ? u : undefined;
}

/** The client's own endpoint first, then the remaining URLs configured for its chain. */
export function endpointsFor(client: PublicClient, extra: string[] = []): string[] {
  const own = transportUrl(client);
  const chainUrls = client.chain?.rpcUrls?.default?.http ?? [];
  return [...new Set([...extra, ...(own ? [own] : []), ...chainUrls])];
}

/** Execution-level failures prove the endpoint works; they must not trigger failover. */
const EXECUTION = /execution reverted|revert|insufficient funds|out of gas|intrinsic gas|exceeds block gas limit|max code size|nonce too|already known|gas required exceeds/i;

export function errorChain(e: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    out.push(cur as Record<string, unknown>);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export function errorText(e: unknown): string {
  const parts: string[] = [];
  for (const o of errorChain(e)) {
    for (const k of ['shortMessage', 'details', 'message'] as const) {
      const v = o[k];
      if (typeof v === 'string' && v && !parts.includes(v)) parts.push(v);
    }
  }
  if (parts.length === 0) parts.push(String(e));
  return parts.join(' | ');
}

/** True when the node executed the call and the EVM rejected it (as opposed to an infra failure). */
export function isExecutionError(e: unknown): boolean {
  if (extractRevertData(e) !== undefined) return true;
  for (const o of errorChain(e)) {
    if (o['code'] === 3) return true; // JSON-RPC 3 = execution error (eth_call revert)
  }
  return EXECUTION.test(errorText(e));
}

const HEXDATA = /^0x([0-9a-fA-F]{2})*$/;

/** Pull the returned revert bytes out of whatever shape the endpoint wrapped them in. */
export function extractRevertData(e: unknown): Hex | undefined {
  for (const o of errorChain(e)) {
    for (const key of ['data', 'revertData', 'returnData', 'output'] as const) {
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === 'string' && HEXDATA.test(v)) return v.toLowerCase() as Hex;
      if (v && typeof v === 'object') {
        const inner = (v as Record<string, unknown>)['data'];
        if (typeof inner === 'string' && HEXDATA.test(inner)) return inner.toLowerCase() as Hex;
      }
    }
  }
  // Some nodes only put the bytes in the message text.
  const m = /(?:reverted|revert data|return data)[^0-9a-fA-Fx]*(0x[0-9a-fA-F]{8,})/.exec(errorText(e));
  return m ? (m[1]!.toLowerCase() as Hex) : undefined;
}

/**
 * The best sentence we can give an operator for why a call reverted.
 *
 * Decoded revert data wins. Failing that, an EMPTY revert is stated as such rather than left to
 * a transport message: a node answering `{"code":3,"message":"execution reverted","data":"0x"}`
 * has executed the call and rejected it, and reporting that as "RPC Request failed." would send
 * someone to check their endpoint when the contract simply said no.
 *
 * When we do fall back to the error chain, prefer a message that mentions execution over a
 * client-library wrapper, because viem's generic `shortMessage` is the first entry and the
 * node's own text sits behind it.
 */
export function revertReasonFrom(e: unknown, revertData?: Hex): string {
  const decoded = decodeRevertReason(revertData);
  if (decoded) return decoded;

  const parts = errorText(e).split(' | ');
  const informative = parts.find((t) =>
    /revert|execution|insufficient|out of gas|invalid opcode|stack|balance/i.test(t),
  );

  if (revertData === '0x') {
    const detail = informative ?? parts[0];
    return `reverted without a reason${detail ? ` (${detail})` : ''}`;
  }
  return informative ?? parts[0] ?? 'reverted';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A small failover pool over real endpoints. Execution errors are rethrown immediately (the node did its
 * job); only infra errors and timeouts move on to the next endpoint. After all endpoints have failed fast
 * it makes one patient attempt on the primary, then throws GateInfraError with every attempt recorded.
 */
export function createGateRpc(client: PublicClient, opts: FailoverOptions = {}): GateRpc {
  const endpoints = opts.endpoints?.length ? [...new Set(opts.endpoints)] : endpointsFor(client);
  if (endpoints.length === 0) {
    throw new Error('createGateRpc: no RPC endpoint could be derived from the client (pass FailoverOptions.endpoints)');
  }
  const fast = opts.timeoutMs ?? 2_000;
  const patient = opts.patientTimeoutMs ?? 15_000;
  const chain = client.chain as Chain | undefined;
  const cache = new Map<string, PublicClient>();

  const clientFor = (url: string, timeout: number): PublicClient => {
    const key = `${url}|${timeout}`;
    let c = cache.get(key);
    if (!c) {
      // retryCount 0: this pool, not viem, owns the retry policy.
      c = createPublicClient({ chain, transport: http(url, { timeout, retryCount: 0 }) }) as PublicClient;
      cache.set(key, c);
    }
    return c;
  };

  let lastEndpoint: string | undefined;

  const plan: Array<{ url: string; timeout: number }> = endpoints.map((url) => ({ url, timeout: fast }));
  if (patient > fast) plan.push({ url: endpoints[0]!, timeout: patient });

  return {
    endpoints,
    get lastEndpoint() {
      return lastEndpoint;
    },
    client(endpoint?: string) {
      return clientFor(endpoint ?? endpoints[0]!, patient > 0 ? patient : fast);
    },
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
      const attempts: AttemptError[] = [];
      for (let i = 0; i < plan.length; i++) {
        const { url, timeout } = plan[i]!;
        try {
          const raw = clientFor(url, timeout).request as unknown as (a: { method: string; params?: unknown[] }) => Promise<T>;
          const r = await raw({ method, params });
          lastEndpoint = url;
          return r;
        } catch (e) {
          if (isExecutionError(e)) throw e;
          attempts.push({ endpoint: url, error: errorText(e).split('\n')[0]!.slice(0, 300) });
          if (i + 1 < plan.length) await sleep(50);
        }
      }
      throw new GateInfraError(
        `${method} failed on all ${attempts.length} attempt(s) across ${endpoints.length} endpoint(s): ` +
          attempts.map((a) => `${a.endpoint}: ${a.error}`).join(' ; '),
        attempts,
      );
    },
  };
}

// ---------------------------------------------------------------- revert decoding

export const ERROR_STRING_SELECTOR = '0x08c379a0'; // Error(string)
export const PANIC_SELECTOR = '0x4e487b71'; // Panic(uint256)

/** Solidity panic codes (docs.soliditylang.org, "Panic via assert and Error via require"). */
export const PANIC_REASONS: Record<string, string> = {
  '0x00': 'generic compiler panic',
  '0x01': 'assert(false)',
  '0x11': 'arithmetic overflow or underflow',
  '0x12': 'division or modulo by zero',
  '0x21': 'invalid enum conversion',
  '0x22': 'invalid storage byte array encoding',
  '0x31': 'pop() on an empty array',
  '0x32': 'array index out of bounds',
  '0x41': 'out of memory / too much memory allocated',
  '0x51': 'call to a zero-initialised internal function variable',
};

/**
 * Decode revert bytes to a human reason, without an ABI:
 *  - Error(string)  -> the string
 *  - Panic(uint)    -> "Panic(0x11): arithmetic overflow or underflow"
 *  - anything else  -> the 4-byte selector passed through verbatim, plus the raw argument bytes.
 * Returns undefined when there is nothing to decode (success, or truly empty revert).
 */
export function decodeRevertReason(data?: Hex): string | undefined {
  if (!data || data === '0x') return undefined;
  const d = data.toLowerCase() as Hex;
  if (d.length < 10) return `reverted with ${d.length - 2} byte(s) of data: ${d}`;
  const selector = d.slice(0, 10);
  const args = `0x${d.slice(10)}` as Hex;
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      return decodeAbiParameters([{ type: 'string' }], args)[0] as string;
    } catch {
      return `Error(string) with undecodable payload: ${d}`;
    }
  }
  if (selector === PANIC_SELECTOR) {
    try {
      const code = decodeAbiParameters([{ type: 'uint256' }], args)[0] as bigint;
      const key = `0x${code.toString(16).padStart(2, '0')}`;
      return `Panic(${key})${PANIC_REASONS[key] ? `: ${PANIC_REASONS[key]}` : ''}`;
    } catch {
      return `Panic(uint256) with undecodable payload: ${d}`;
    }
  }
  // Custom error: we do not have the ABI, so pass the selector through untouched rather than guess.
  return args === '0x'
    ? `custom error ${selector} (no ABI available to name it)`
    : `custom error ${selector} (no ABI available to name it), args ${args}`;
}

// ---------------------------------------------------------------- pinned block

/** The block the whole gate decision is pinned to. Fetched once, then addressed by hash. */
export interface PinnedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

interface RawHeader {
  number: Hex;
  hash: Hex;
  timestamp: Hex;
  baseFeePerGas?: Hex;
}

/**
 * Resolve `blockTag` to a concrete header, once. Every later request in the gate uses the HASH, so a
 * Monad Proposed block that gets replaced cannot silently split the decision across two states
 * (PRD "Honest limits": `latest` is a Proposed block and can be abandoned).
 */
export async function pinBlock(rpc: GateRpc, blockTag: BlockSelector = 'latest'): Promise<PinnedBlock> {
  const sel = encodeBlockSelector(blockTag);
  const h =
    typeof sel === 'object'
      ? await rpc.request<RawHeader>('eth_getBlockByHash', [sel.blockHash, false])
      : await rpc.request<RawHeader>('eth_getBlockByNumber', [sel, false]);
  if (!h || !h.hash) throw new GateInfraError(`block ${String(blockTag)} not found`, []);
  return { number: BigInt(h.number), hash: h.hash.toLowerCase() as Hex, timestamp: BigInt(h.timestamp) };
}

// ---------------------------------------------------------------- simulate

export interface SimulateOptions extends FailoverOptions {
  /** Reuse an already-pinned block (keeps a whole gate run on one state). */
  pinnedBlock?: PinnedBlock;
  /** Reuse an existing failover pool. */
  rpc?: GateRpc;
}

/** Call object as the RPC wants it. `to: null` (contract creation) is sent without `to`. */
export function callObjectOf(tx: TxRequest): Record<string, string> {
  const c: Record<string, string> = { from: tx.from };
  if (tx.to) c.to = tx.to;
  if (tx.data && tx.data !== '0x') c.data = tx.data;
  if (tx.value !== undefined && tx.value !== 0n) c.value = `0x${tx.value.toString(16)}`;
  if (tx.gas !== undefined) c.gas = `0x${tx.gas.toString(16)}`;
  return c;
}

/**
 * Simulate `tx` at `blockTag` and report what the chain says would happen.
 *
 *  - `eth_call` decides success vs revert; revert bytes are kept verbatim and decoded if possible.
 *  - `eth_estimateGas` supplies `gasUsed`, and only when the call succeeded (an estimate on a reverting
 *    call is meaningless, and Monad's docs warn that wallets react badly to it: docs/facts.md #1c).
 *  - the block is pinned by hash first, so call and estimate see the same state.
 *
 * Throws GateInfraError when no endpoint answered. An EVM revert is a normal result, not an error.
 */
export async function simulate(
  client: PublicClient,
  tx: TxRequest,
  blockTag: BlockSelector = 'latest',
  opts: SimulateOptions = {},
): Promise<SimulationResult> {
  const rpc = opts.rpc ?? createGateRpc(client, opts);
  const block = opts.pinnedBlock ?? (await pinBlock(rpc, blockTag));
  const at = { blockHash: block.hash };
  const call = callObjectOf(tx);

  let returnData: Hex | undefined;
  try {
    returnData = await rpc.request<Hex>('eth_call', [call, at]);
  } catch (e) {
    if (!isExecutionError(e)) throw e;
    const revertData = extractRevertData(e);
    return {
      success: false,
      gasUsed: 0n,
      revertData,
      revertReason: revertReasonFrom(e, revertData),
      block,
    };
  }

  try {
    const gas = await rpc.request<Hex>('eth_estimateGas', [call, at]);
    return { success: true, gasUsed: BigInt(gas), returnData, block };
  } catch (e) {
    if (!isExecutionError(e)) throw e;
    // eth_call passed but the estimate hit an EVM error (e.g. the search had to raise the gas cap and the
    // call then failed): report it as doomed rather than inventing a gas number.
    const revertData = extractRevertData(e);
    return {
      success: false,
      gasUsed: 0n,
      returnData,
      revertData,
      revertReason: `eth_call succeeded but eth_estimateGas failed: ${revertReasonFrom(e, revertData)}`,
      block,
    };
  }
}
