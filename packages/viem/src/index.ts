/**
 * @readset/viem — a drop-in guard around a viem WalletClient.
 *
 * ```ts
 * const guarded = createGuardedWalletClient({ walletClient, publicClient });
 * await guarded.writeContract({ address, abi, functionName: 'transferFrom', args });
 * // same viem call, except it can throw DoomedTxError instead of signing.
 * ```
 */
export { createGuardedWalletClient } from './guarded-client.js';
export type {
  CreateGuardedWalletClientOptions,
  GuardableTx,
  GuardedExtras,
  GuardedWalletClient,
} from './guarded-client.js';

export { guard, attachOutcome, refusalError } from './guard.js';
export type { GuardDecision, GuardOptions } from './guard.js';

export { DoomedTxError, isDoomedTxError } from './errors.js';
export type { DoomedTxErrorInit } from './errors.js';

export { loadCoreBindings, DEFAULT_POLICY } from './core-bridge.js';
export type {
  BreakerStatus,
  CoreBindings,
  GateInput,
  GateOutcome,
  Outcome,
  Policy,
  Receipt,
  TxRequest,
  Verdict,
  DoomedTx,
  DependencySet,
  Explanation,
  Hex,
} from './contract.js';

/** Receipt/policy file locations used by the temporary stand-in (see fallback.ts TODO). */
export { stateDir, receiptsPath, policyPath, policyHash, decodeRevert } from './fallback.js';
