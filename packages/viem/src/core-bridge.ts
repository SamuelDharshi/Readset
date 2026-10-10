/**
 * Binds to @readset/core's gate / receipts / breaker at runtime.
 *
 * Core is being written concurrently by another agent, so the names in `contract.ts`
 * (`gate`, `recordAttempt`, `checkBreaker`, `recordOutcome`, `recentReceipts`,
 * `loadPolicy`, `savePolicy`, `explain`) are treated as the contract. Whichever exist are
 * used; the rest come from the clearly-marked stand-in in `fallback.ts`.
 * `bindings.from` reports, per name, which one you got — surfaced by `readset_status`.
 */
import type { PublicClient } from 'viem';
import type { BreakerStatus, CoreBindings, GateInput, GateOutcome, Policy, Receipt } from './contract.js';
import {
  DEFAULT_POLICY,
  fallbackCheckBreaker,
  fallbackGate,
  fallbackLoadPolicy,
  fallbackRecentReceipts,
  fallbackRecordAttempt,
  fallbackRecordOutcome,
  fallbackSavePolicy,
} from './fallback.js';

type Fn = (...args: unknown[]) => unknown;
const isFn = (v: unknown): v is Fn => typeof v === 'function';

let cached: CoreBindings | undefined;

/** Normalise whatever shape core's gate returns into GateOutcome. */
function normalizeGate(raw: unknown): GateOutcome {
  const o = (raw ?? {}) as Record<string, unknown>;
  const verdict = (o.verdict ?? o.decision ?? (o.allowed === true ? 'allowed' : undefined)) as
    | GateOutcome['verdict']
    | undefined;
  if (!verdict) throw new Error('@readset/core gate() returned no verdict; cannot interpret its result');
  const gasRaw = o.gasLimit ?? o.gasLimitChosen ?? o.gas;
  const doomed = (o.doomed ?? o.doomedTx) as GateOutcome['doomed'];
  return {
    verdict,
    // core puts the funds/reserve explanation on its FundsCheck, not at the top level,
    // so a refused_funds verdict would otherwise arrive with no reason to show the operator.
    reason:
      (o.reason as string | undefined) ??
      doomed?.revertReason ??
      doomed?.reason ??
      ((o.funds as { reason?: string } | undefined)?.reason) ??
      (o.error as string | undefined),
    doomed,
    dependencySet: (o.dependencySet ?? o.dependencies) as GateOutcome['dependencySet'],
    gasLimit: gasRaw === undefined || gasRaw === null ? undefined : BigInt(gasRaw as string | number | bigint),
  };
}

function normalizeBreaker(raw: unknown, policy: Policy): BreakerStatus {
  const o = (raw ?? {}) as Record<string, unknown>;
  // core's checkBreaker returns a BreakerDecision { allow, reason, target }: `allow: false`
  // IS the trip. Reading only `tripped` here would let every send through.
  const tripped =
    o.allow !== undefined
      ? !o.allow
      : Boolean(o.tripped ?? o.isTripped ?? false);
  return {
    tripped,
    reason: (o.reason as string | undefined) ?? (o.trippedReason as string | undefined),
    consecutiveReverts: Number(o.consecutiveReverts ?? o.revertStreak ?? 0),
    burnLastHourWei: String(o.burnLastHourWei ?? o.burnWeiLastHour ?? o.rollingBurnWei ?? '0'),
    limits: {
      maxConsecutiveReverts: policy.maxConsecutiveReverts,
      maxBurnPerHourWei: policy.maxBurnPerHourWei,
    },
  };
}

/**
 * Load core once.
 *
 * @readset/core now implements all of these. If an export goes missing we FAIL LOUDLY rather
 * than silently degrading to the stand-in in `fallback.ts`: a guard that quietly stopped using
 * the real gate would refuse or allow sends on different logic than the operator audited.
 * Set READSET_ALLOW_FALLBACK=1 to opt into the stand-in (development only).
 */
export async function loadCoreBindings(opts: {
  reload?: boolean;
  allowFallback?: boolean;
} = {}): Promise<CoreBindings> {
  if (cached && !opts.reload) return cached;
  let mod: Record<string, unknown> = {};
  try {
    mod = (await import('@readset/core')) as unknown as Record<string, unknown>;
  } catch {
    mod = {};
  }
  const from: Record<string, 'core' | 'fallback'> = {};
  const pick = (name: string): Fn | undefined => {
    const v = mod[name];
    if (isFn(v)) {
      from[name] = 'core';
      return v;
    }
    from[name] = 'fallback';
    return undefined;
  };

  const coreGate = pick('gate');
  const coreBreaker = pick('checkBreaker');
  const coreAttempt = pick('recordAttempt');
  const coreOutcome = pick('recordOutcome');
  const coreRecent = pick('recentReceipts');
  const coreLoadPolicy = pick('loadPolicy');
  const coreSavePolicy = pick('savePolicy');
  // core names it explainFailedTx and takes (client, txHash) positionally.
  const coreExplain = pick('explainFailedTx');

  const bindings: CoreBindings = {
    native: Object.values(from).every((v) => v === 'core'),
    from,
    gate: coreGate
      ? async (input: GateInput) => normalizeGate(await coreGate(input))
      : fallbackGate,
    checkBreaker: coreBreaker
      ? async (input) => normalizeBreaker(await coreBreaker(input), input.policy)
      : fallbackCheckBreaker,
    // core's AttemptInput keeps chainId at the top level and takes a narrow tx shape
    // (gasLimitChosen lives inside tx), so this flattens our TxRequest into it.
    recordAttempt: coreAttempt
      ? async (input) =>
          (await coreAttempt({
            chainId: input.tx.chainId,
            tx: {
              from: input.tx.from,
              to: input.tx.to,
              ...(input.tx.data === undefined ? {} : { data: input.tx.data }),
              ...(input.tx.value === undefined ? {} : { value: input.tx.value.toString() }),
              ...(input.gasLimitChosen === undefined
                ? {}
                : { gasLimitChosen: input.gasLimitChosen.toString() }),
            },
            verdict: input.verdict,
            policy: input.policy,
            ...(input.doomed === undefined ? {} : { doomed: input.doomed }),
            ...(input.dependencySet === undefined ? {} : { dependencySet: input.dependencySet }),
            ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
          })) as Receipt
      : fallbackRecordAttempt,
    // core's recordOutcome is (idOrReceipt, outcome): positional, not a single object.
    recordOutcome: coreOutcome
      ? async (input) =>
          (await coreOutcome(input.receiptId, {
            status: input.outcome.status,
            gasUsed: input.outcome.gasUsed,
            feePaidWei: input.outcome.feePaidWei,
            blockNumber: input.outcome.blockNumber,
          })) as Receipt | undefined
      : fallbackRecordOutcome,
    recentReceipts: coreRecent
      ? async (input) => (await coreRecent(input)) as Receipt[]
      : fallbackRecentReceipts,
    loadPolicy: coreLoadPolicy ? async () => (await coreLoadPolicy()) as Policy : fallbackLoadPolicy,
    savePolicy: coreSavePolicy
      ? async (p: Policy) => ((await coreSavePolicy(p)) as Policy | undefined) ?? p
      : fallbackSavePolicy,
  };
  if (coreExplain) {
    bindings.explain = async (input: { txHash: `0x${string}`; client: PublicClient }) =>
      (await coreExplain(input.client, input.txHash)) as Awaited<
        ReturnType<NonNullable<CoreBindings['explain']>>
      >;
  }
  const missing = Object.entries(from)
    .filter(([, v]) => v === 'fallback')
    .map(([k]) => k);
  const allowFallback = opts.allowFallback ?? process.env.READSET_ALLOW_FALLBACK === '1';
  if (missing.length > 0 && !allowFallback) {
    throw new Error(
      `@readset/core is missing: ${missing.join(', ')}. Readset will not run the guard on the ` +
        `fallback stand-in, because its decisions would differ from the audited core. ` +
        `Fix the core exports, or set READSET_ALLOW_FALLBACK=1 for development.`,
    );
  }
  cached = bindings;
  return bindings;
}

export { DEFAULT_POLICY };
