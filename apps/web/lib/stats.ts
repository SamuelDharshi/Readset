import { readResult } from './results';

/**
 * The page's numbers come from the committed measurement outputs, never from constants typed
 * into the UI. If a results file is missing the field is null and the page says "not measured"
 * rather than showing a plausible-looking number.
 */

export interface Stats {
  census: {
    source: string;
    blocks: number;
    days: number;
    rangeBlocks: [number, number];
    userTxs: number;
    failedTxs: number;
    failureRate: number;
    revertBurnMON: number;
    burnPerDayMON: number;
    gasUsedNeGasLimitFailed: number;
    distinctFailingSenders: number;
    top50SenderBurnShare: number;
    top10SenderBurnShare: number;
    loops?: { burnMON?: number; burnShare?: number; stoppedByBreaker5MON?: number; runs?: number };
  } | null;
  gasPadding: { neverNeededShare?: number; burnShareOfPadded?: number; paddedTxShare?: number; tracedN?: number } | null;
  replay: {
    failedN: number;
    successfulN: number;
    knowableBurnN1: number;
    knowableBurnN3: number;
    falseBlockRate: number;
    sameBlockBurnShare: number;
  } | null;
  falseBlocks: { naive: number; stable: number; unmeasured: number; candidates: number } | null;
  generatedAt: string;
}

interface CensusFile {
  full?: {
    source?: string;
    blocks?: number;
    days?: number;
    rangeBlocks?: [number, number];
    userTxs?: number;
    failedTxs?: number;
    failureRateOfUserTxs?: number;
    revertBurnMON?: number;
    gasUsedNeGasLimitFailed?: number;
    distinctFailingSenders?: number;
    top50SenderBurnShare?: number;
    top10SenderBurnShare?: number;
    loops?: Record<string, number>;
  };
  traces?: {
    design?: { traced?: number };
    outOfGas?: Record<string, number>;
    /** `wastedGasShare` plus `ge2x.{ofBurn,ofCount}`: see results/k2-sample.json. */
    hardcodedGasProxy?: { wastedGasShare?: number; ge2x?: { ofBurn?: number; ofCount?: number } };
  };
}

interface ReplayFile {
  sample?: { failedN?: number; successfulN?: number };
  knowable?: { ofAllBurn?: Record<string, { byBurn?: { point?: number } }> };
  falseBlocks?: { rate?: { point?: number } };
  sameBlock?: { byBurn?: { point?: number } };
}

interface StableFile {
  falseBlockCandidates?: number;
  unmeasured?: number;
  rates?: { naiveRefuseOnAnyRevertAtN1?: number; stableRequireRevertAtN1AndN3?: number };
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export async function buildStats(): Promise<Stats> {
  const k2 = await readResult<CensusFile>('k2-sample.json');
  const replay = await readResult<ReplayFile>('replay/latest.json');
  const stable = await readResult<StableFile>('replay/stable-revert-check.json');

  const f = k2?.full;
  const census: Stats['census'] = f?.failedTxs
    ? {
        source: f.source ?? 'unknown',
        blocks: f.blocks ?? 0,
        days: f.days ?? 0,
        rangeBlocks: f.rangeBlocks ?? [0, 0],
        userTxs: f.userTxs ?? 0,
        failedTxs: f.failedTxs,
        failureRate: f.failureRateOfUserTxs ?? 0,
        revertBurnMON: f.revertBurnMON ?? 0,
        burnPerDayMON: (f.revertBurnMON ?? 0) / (f.days || 1),
        gasUsedNeGasLimitFailed: f.gasUsedNeGasLimitFailed ?? -1,
        distinctFailingSenders: f.distinctFailingSenders ?? 0,
        top50SenderBurnShare: f.top50SenderBurnShare ?? 0,
        top10SenderBurnShare: f.top10SenderBurnShare ?? 0,
        ...(f.loops
          ? {
              loops: {
                ...(num(f.loops.burnMON) === undefined ? {} : { burnMON: num(f.loops.burnMON) }),
                ...(num(f.loops.burnShareOfRevertBurn) === undefined
                  ? {}
                  : { burnShare: num(f.loops.burnShareOfRevertBurn) }),
                ...(num(f.loops.burnPreventedByBreaker5MON) === undefined
                  ? {}
                  : { stoppedByBreaker5MON: num(f.loops.burnPreventedByBreaker5MON) }),
                ...(num(f.loops.runs) === undefined ? {} : { runs: num(f.loops.runs) }),
              },
            }
          : {}),
      }
    : null;

  const t = k2?.traces;
  const padded = t?.hardcodedGasProxy as
    | { wastedGasShare?: number; ge2x?: { ofBurn?: number; ofCount?: number } }
    | undefined;
  const gasPadding: Stats['gasPadding'] = padded
    ? {
        ...(num(padded.wastedGasShare) === undefined ? {} : { neverNeededShare: num(padded.wastedGasShare) }),
        ...(num(padded.ge2x?.ofBurn) === undefined ? {} : { burnShareOfPadded: num(padded.ge2x?.ofBurn) }),
        ...(num(padded.ge2x?.ofCount) === undefined ? {} : { paddedTxShare: num(padded.ge2x?.ofCount) }),
        ...(num((t?.design as { traced?: number } | undefined)?.traced) === undefined
          ? {}
          : { tracedN: num((t?.design as { traced?: number } | undefined)?.traced) }),
      }
    : null;

  const kb = replay?.knowable?.ofAllBurn;
  const replayStats: Stats['replay'] = replay?.sample?.failedN
    ? {
        failedN: replay.sample.failedN,
        successfulN: replay.sample.successfulN ?? 0,
        knowableBurnN1: kb?.['N-1']?.byBurn?.point ?? 0,
        knowableBurnN3: kb?.['N-3']?.byBurn?.point ?? 0,
        falseBlockRate: replay.falseBlocks?.rate?.point ?? 0,
        sameBlockBurnShare: replay.sameBlock?.byBurn?.point ?? 0,
      }
    : null;

  const falseBlocks: Stats['falseBlocks'] = stable?.rates
    ? {
        naive: stable.rates.naiveRefuseOnAnyRevertAtN1 ?? 0,
        stable: stable.rates.stableRequireRevertAtN1AndN3 ?? 0,
        unmeasured: stable.unmeasured ?? 0,
        candidates: stable.falseBlockCandidates ?? 0,
      }
    : null;

  return { census, gasPadding, replay: replayStats, falseBlocks, generatedAt: new Date().toISOString() };
}
