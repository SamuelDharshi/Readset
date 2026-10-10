/*
 * Verdict vocabulary at the explain OUTPUT boundary.
 *
 * core's classifyResims returns 'unavoidable' for a funds/reserve refusal, because from its
 * point of view there was nothing to avoid. The replay benchmark calls that same bucket
 * 'excluded-funds'. Two names for one thing is fine inside the engine, and confusing the moment
 * a reader sees it: "unavoidable" should mean one specific thing on this site — a same-block
 * race that no client-side guard could have caught.
 *
 * So the public surface normalises here rather than renaming anything in core or the benchmark.
 * Pure and free of framework imports, so it can be unit-tested directly.
 */

export type PublicVerdict =
  | 'N-1'
  | 'N-2'
  | 'N-3'
  | 'same-block'
  | 'excluded-funds'
  | 'unavoidable'
  | 'unknown';

export interface ResimLike {
  k: number;
  /** core's ResimOutcome; 'funds' means the node refused it for funds / reserve balance. */
  outcome: string;
}

export interface VerdictInput {
  avoidableAt?: string;
  avoidableClass?: string;
  resims?: ResimLike[];
}

/**
 * True when the N-1 re-simulation was refused for sender funds or the reserve balance.
 *
 * Read from the re-simulation OUTCOME, not from the rationale text: a message can be reworded,
 * an enum cannot drift silently.
 */
export function isFundsRefusal(input: VerdictInput): boolean {
  const atN1 = input.resims?.find((r) => r.k === 1);
  if (atN1?.outcome === 'funds') return true;
  // The benchmark's own label, if an upstream ever hands us one already normalised.
  return input.avoidableClass === 'excluded-funds' || input.avoidableAt === 'excluded-funds';
}

/** The verdict this site shows. 'unavoidable' is reserved for same-block races. */
export function publicVerdict(input: VerdictInput): PublicVerdict {
  if (isFundsRefusal(input)) return 'excluded-funds';
  const v = input.avoidableAt ?? input.avoidableClass ?? 'unknown';
  if (v === 'N-1' || v === 'N-2' || v === 'N-3') return v;
  if (v === 'same-block') return 'same-block';
  if (v === 'knowable' || v === 'latency-sensitive') {
    // Class names, not the at-k name: fall back to whichever k the engine reported.
    const at = input.avoidableAt;
    return at === 'N-1' || at === 'N-2' || at === 'N-3' ? at : 'unknown';
  }
  if (v === 'unavoidable') return 'unavoidable';
  return 'unknown';
}

/**
 * Rewrites the explanation's verdict fields for public output. Everything else is untouched —
 * the rationale, the re-simulations and the evidence are the engine's, not ours to edit.
 */
export function withPublicVerdict<T extends VerdictInput>(e: T): T & { avoidableAt: PublicVerdict } {
  const verdict = publicVerdict(e);
  return {
    ...e,
    avoidableAt: verdict,
    ...(verdict === 'excluded-funds' ? { avoidableClass: 'excluded-funds' } : {}),
  };
}
