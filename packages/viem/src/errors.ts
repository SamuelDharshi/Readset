import type { DependencySet, DoomedTx, Hex, Verdict } from './contract.js';

export interface DoomedTxErrorInit {
  verdict: Exclude<Verdict, 'allowed'>;
  reason: string;
  revertReason?: string;
  revertData?: Hex;
  receiptId: string;
  dependencySet?: DependencySet;
  doomed?: DoomedTx;
  chainId: number;
}

/**
 * Thrown instead of signing. This is the ONE behavioural difference from a plain viem
 * WalletClient: `sendTransaction` / `writeContract` can refuse. `name` is 'DoomedTxError',
 * so a caller can branch on it without importing this package.
 */
export class DoomedTxError extends Error {
  readonly name = 'DoomedTxError';
  /** Why it was refused: 'refused_doomed' | 'refused_breaker' | 'refused_funds' | 'refused_policy'. */
  readonly verdict: Exclude<Verdict, 'allowed'>;
  readonly reason: string;
  readonly revertReason?: string;
  readonly revertData?: Hex;
  /** Id of the dependency receipt written for this refusal. */
  readonly receiptId: string;
  readonly dependencySet?: DependencySet;
  readonly doomed?: DoomedTx;
  readonly chainId: number;

  constructor(init: DoomedTxErrorInit) {
    super(`Readset refused to sign (${init.verdict}): ${init.reason} [receipt ${init.receiptId}]`);
    this.verdict = init.verdict;
    this.reason = init.reason;
    this.revertReason = init.revertReason;
    this.revertData = init.revertData;
    this.receiptId = init.receiptId;
    this.dependencySet = init.dependencySet;
    this.doomed = init.doomed;
    this.chainId = init.chainId;
  }

  /** Structured form for logs, MCP results and agent consumption. */
  toJSON(): Record<string, unknown> {
    return {
      error: 'DoomedTxError',
      verdict: this.verdict,
      reason: this.reason,
      revertReason: this.revertReason,
      revertData: this.revertData,
      receiptId: this.receiptId,
      chainId: this.chainId,
    };
  }
}

export const isDoomedTxError = (e: unknown): e is DoomedTxError =>
  e instanceof Error && e.name === 'DoomedTxError';
