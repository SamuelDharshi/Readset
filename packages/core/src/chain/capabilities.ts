import type { PublicClient } from 'viem';
import type { Hex } from '../types.js';

export type Support = 'supported' | 'unsupported' | 'unknown';

export interface ProbeResult {
  status: Support;
  /** Raw error message when status != supported. */
  error?: string;
  /** JSON-RPC error code if any. */
  code?: number;
  /** HTTP status if the failure was HTTP-level. */
  httpStatus?: number;
}

export interface Capabilities {
  chainId: number;
  blockNumber: bigint;
  clientVersion: string | null;
  /** Real tx used for the tracing probes (null if none found in the scanned window). */
  probeTx: Hex | null;
  supportsCreateAccessList: ProbeResult;
  supportsDebugTraceTransaction: ProbeResult;
  supportsDebugTraceCall: ProbeResult;
  supportsPrestateTracer: ProbeResult;
  supportsTraceBlock: ProbeResult;
}

type RawRequest = (a: { method: string; params?: unknown[] }) => Promise<unknown>;

interface ErrInfo {
  message: string;
  code?: number;
  httpStatus?: number;
}

function errInfo(e: unknown): ErrInfo {
  let message = e instanceof Error ? e.message : String(e);
  let code: number | undefined;
  let httpStatus: number | undefined;
  let cur: any = e;
  for (let i = 0; i < 6 && cur; i++, cur = cur.cause) {
    if (typeof cur.code === 'number' && code === undefined) code = cur.code;
    if (typeof cur.status === 'number' && httpStatus === undefined) httpStatus = cur.status;
    if (typeof cur.details === 'string' && cur.details) message = cur.details;
  }
  return { message, code, httpStatus };
}

const RATE = /rate.?limit|too many requests|429|capacity|throttl|exceeded.*(limit|quota)|compute units/i;
const DENIED =
  /not allowed|not available|not enabled|not supported|unsupported|disabled|upgrade|paid plan|method not found|does not exist|unknown method|not whitelisted|forbidden/i;

function classifyError(e: unknown): ProbeResult {
  const { message, code, httpStatus } = errInfo(e);
  const base = { error: message, code, httpStatus };
  if (httpStatus === 429 || code === -32005 || (RATE.test(message) && !DENIED.test(message))) {
    return { status: 'unknown', ...base };
  }
  if (code === -32601 || code === -32053 || httpStatus === 403 || httpStatus === 401 || DENIED.test(message)) {
    return { status: 'unsupported', ...base };
  }
  return { status: 'unknown', ...base };
}

/** EVM execution failures prove the method itself is implemented. */
const EXECUTION_ERR = /revert|insufficient funds|out of gas|execution failed/i;

async function attempt(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await fn();
    return { status: 'supported' };
  } catch (e) {
    const info = errInfo(e);
    if (info.code === -32003 || (info.code === -32000 && EXECUTION_ERR.test(info.message)) || (info.code === 3 && EXECUTION_ERR.test(info.message))) {
      return { status: 'supported', error: 'method executed; EVM error: ' + info.message, code: info.code };
    }
    return classifyError(e);
  }
}

const hexNum = (n: bigint) => `0x${n.toString(16)}`;

/**
 * Really call the RPC and report which tracing/access-list methods work.
 * Tracing probes use a real transaction from a recent block (walks back up to `maxBlockScan`
 * blocks from head-2 to find one). Calls are sequential to stay inside public rate limits.
 */
export async function probeCapabilities(
  client: PublicClient,
  opts: { maxBlockScan?: number } = {},
): Promise<Capabilities> {
  const raw = client.request as unknown as RawRequest;
  const chainId = await client.getChainId();
  const blockNumber = await client.getBlockNumber();

  let clientVersion: string | null = null;
  try {
    clientVersion = (await raw({ method: 'web3_clientVersion' })) as string;
  } catch {
    clientVersion = null;
  }

  let probeTx: Hex | null = null;
  let probeBlock: bigint = blockNumber;
  let txObj: { from: Hex; to: Hex; input: Hex } | null = null;
  const scan = opts.maxBlockScan ?? 40;
  const start = blockNumber > 2n ? blockNumber - 2n : blockNumber;
  for (let i = 0n; i < BigInt(scan) && start - i >= 0n; i++) {
    try {
      const b = (await raw({ method: 'eth_getBlockByNumber', params: [hexNum(start - i), true] })) as any;
      const t = b?.transactions?.find((x: any) => x.to);
      if (t) {
        probeTx = t.hash;
        probeBlock = start - i;
        txObj = { from: t.from, to: t.to, input: t.input ?? '0x' };
        break;
      }
    } catch {
      break;
    }
  }

  const callShape = txObj
    ? { from: txObj.from, to: txObj.to, data: txObj.input }
    : { to: '0x0000000000000000000000000000000000000000', data: '0x' };

  const supportsCreateAccessList = await attempt(() =>
    raw({ method: 'eth_createAccessList', params: [callShape, 'latest'] }),
  );

  const noTx: ProbeResult = {
    status: 'unknown',
    error: `no transaction found in ${scan} recent blocks to probe tracing against`,
  };

  let supportsDebugTraceTransaction = noTx;
  let supportsPrestateTracer = noTx;
  if (probeTx) {
    // Monad requires the options object (-32602 otherwise); default tracer is callTracer.
    supportsDebugTraceTransaction = await attempt(() =>
      raw({ method: 'debug_traceTransaction', params: [probeTx, {}] }),
    );
    supportsPrestateTracer = await attempt(() =>
      raw({
        method: 'debug_traceTransaction',
        params: [probeTx, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }],
      }),
    );
    if (supportsDebugTraceTransaction.status === 'unsupported' && supportsPrestateTracer.status !== 'supported') {
      supportsPrestateTracer = { ...supportsPrestateTracer, status: 'unsupported' };
    } else if (
      supportsDebugTraceTransaction.status === 'supported' &&
      supportsPrestateTracer.status === 'unknown' &&
      supportsPrestateTracer.code === -32602
    ) {
      // plain tracing works but this tracer is rejected as invalid params
      supportsPrestateTracer = { ...supportsPrestateTracer, status: 'unsupported' };
    }
  }

  const supportsDebugTraceCall = await attempt(() =>
    raw({ method: 'debug_traceCall', params: [callShape, 'latest', {}] }),
  );
  const supportsTraceBlock = await attempt(() =>
    raw({ method: 'trace_block', params: [hexNum(probeBlock)] }),
  );

  return {
    chainId,
    blockNumber,
    clientVersion,
    probeTx,
    supportsCreateAccessList,
    supportsDebugTraceTransaction,
    supportsDebugTraceCall,
    supportsPrestateTracer,
    supportsTraceBlock,
  };
}
