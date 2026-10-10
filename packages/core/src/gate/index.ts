// The Gate: decide, before anything is signed, whether this transaction is doomed - and record what the
// decision depended on.
//
// Order of checks (PRD "How it works", component 1):
//   1. simulate at the pinned block           -> a revert means refuse, with the decoded cause
//   2. choose the gas limit from simulated gas -> Category Labs' research, credited in gas.ts
//   3. check the sender can cover gas_limit x price + value, and the Monad reserve rule
//   4. capture the dependency set (non-diff prestateTracer), for the receipt and for Explain
//
// The circuit breaker ('refused_breaker') is a separate component and runs BEFORE this gate; it is not
// implemented here.
//
// Not exported from packages/core/src/index.ts yet: that file is owned by the integration lead. Import from
// '@readset/core/gate' path `src/gate/index.js`, or ask the lead to add `export * from './gate/index.js'`.
export * from './simulate.js';
export * from './dependency.js';
export * from './funds.js';
export * from './gas.js';

import type { PublicClient } from 'viem';
import type { DependencySet, DoomedTx, Hex, Policy, SimulationResult, TxRequest, Verdict } from '../types.js';
import type { BlockSelector } from '../trace/index.js';
import type { SlotLabeler } from '../label/index.js';
import {
  createGateRpc,
  errorText,
  GateInfraError,
  pinBlock,
  simulate,
  type FailoverOptions,
  type GateRpc,
  type PinnedBlock,
} from './simulate.js';
import { buildDependencySet } from './dependency.js';
import { checkFunds, type FundsCheck } from './funds.js';
import { chooseGasLimit } from './gas.js';

/** Gate-relevant policy defaults. The breaker fields are defaulted here only so a partial policy is usable. */
export const DEFAULT_GATE_POLICY: Policy = {
  maxConsecutiveReverts: 5,
  maxBurnPerHourWei: '0',
  perTarget: [],
  gasBufferPct: 20,
  failClosed: true,
  // 'warn', not 'any': refusing on every reverting simulation wrongly refuses 8.53% of real
  // sends (docs/benchmark.md). Hard refusal is something an operator opts into.
  refuseOnRevert: 'warn',
  stableRevertLookback: 3,
};

export interface GateArgs extends FailoverOptions {
  client: PublicClient;
  tx: TxRequest;
  policy?: Partial<Policy>;
  /** Block to simulate against. Default 'latest'. */
  blockTag?: BlockSelector;
  /**
   * Price used for the funds check: gas_limit x this + value. Default `eth_gasPrice` from the same
   * endpoint. Pass the max_fee_per_gas the signer will actually set.
   */
  maxFeePerGas?: bigint;
  /** Optional solc-layout labeller for slot labels. */
  labeller?: SlotLabeler;
  /** Reuse an existing failover pool / pinned block (e.g. to gate several txs on one state). */
  rpc?: GateRpc;
  pinnedBlock?: PinnedBlock;
  /** Skip the dependency set (faster; a receipt then has nothing to diff against later). */
  skipDependencySet?: boolean;
}

/**
 * Does the revert reproduce `lookback` blocks earlier?
 *
 * A send whose simulation reverts only at `latest` is usually waiting on state that has not
 * landed yet, and it often succeeds (measured: docs/benchmark.md). One that was already
 * reverting several blocks ago is doomed by something that is not moving. Returns undefined
 * when the older state cannot be read, and the caller then does NOT refuse.
 */
async function revertReproduces(
  rpc: GateRpc,
  client: PublicClient,
  tx: TxRequest,
  block: PinnedBlock,
  lookback: number,
  args: GateArgs,
): Promise<boolean | undefined> {
  if (block.number <= BigInt(lookback)) return undefined;
  try {
    const older = await pinBlock(rpc, block.number - BigInt(lookback));
    const sim = await simulate(client, tx, older.hash, { ...args, rpc, pinnedBlock: older });
    return !sim.success;
  } catch {
    // Pruned state, a throttled endpoint, anything: not evidence of doom.
    return undefined;
  }
}

export interface GateResult {
  verdict: Verdict;
  doomed?: DoomedTx;
  dependencySet?: DependencySet;
  gasLimitChosen?: bigint;
  /** Always present when the simulation itself ran. */
  simulation?: SimulationResult;
  /** The block every check was pinned to. */
  block?: PinnedBlock;
  /** Present once a gas limit and price existed to check against. */
  funds?: FundsCheck;
  /** The policy actually applied (defaults merged in). */
  policy: Policy;
  /** Set when the gate refused because of infra failure or a policy precondition, not because of the EVM. */
  error?: string;
  /**
   * The simulation reverted but `policy.refuseOnRevert` did not refuse (default 'warn').
   * The verdict is 'allowed' and the caller MAY still send; the receipt keeps the evidence.
   */
  warnedDoomed?: DoomedTx;
  /** Under 'stable': did the revert reproduce `policy.stableRevertLookback` blocks back? */
  revertReproduced?: boolean;
}

/**
 * Run the gate. Never signs, never sends, never writes: it reads real chain state and returns a verdict.
 *
 * Fail-closed: when an RPC call cannot be answered on any endpoint and `policy.failClosed` is true
 * (the default), the verdict is 'refused_policy' with `error` set. With `failClosed: false` the
 * GateInfraError is rethrown so the caller can decide.
 */
export async function gate(args: GateArgs): Promise<GateResult> {
  const { client, tx } = args;
  const policy: Policy = { ...DEFAULT_GATE_POLICY, ...args.policy };
  const refusePolicy = (error: string): GateResult => ({ verdict: 'refused_policy' as Verdict, policy, error });

  const rpc = args.rpc ?? createGateRpc(client, args);

  try {
    // Precondition: never simulate a tx against the wrong chain.
    const chainId = await rpc.request<Hex>('eth_chainId', []);
    if (Number(BigInt(chainId)) !== tx.chainId) {
      return refusePolicy(
        `tx.chainId ${tx.chainId} does not match the endpoint's chain ${Number(BigInt(chainId))}; refusing to simulate`,
      );
    }

    const block = args.pinnedBlock ?? (await pinBlock(rpc, args.blockTag ?? 'latest'));
    const simulation = await simulate(client, tx, block.hash, { ...args, rpc, pinnedBlock: block });

    // The dependency set is captured for every verdict, allowed or refused: a refused send still needs a
    // receipt that says what it was looking at (PRD component 2). A failure here never changes the verdict.
    let dependencySet: DependencySet | undefined;
    if (!args.skipDependencySet) {
      try {
        dependencySet = await buildDependencySet(client, tx, block, { ...args, rpc, simulation, labeller: args.labeller });
      } catch {
        dependencySet = undefined;
      }
    }

    if (!simulation.success) {
      const doomed: DoomedTx = {
        reason: simulation.revertReason
          ? `simulation reverted at block ${block.number}: ${simulation.revertReason}`
          : `simulation reverted at block ${block.number} with no revert reason`,
      };
      if (simulation.revertData !== undefined) doomed.revertData = simulation.revertData;
      if (simulation.revertReason !== undefined) doomed.revertReason = simulation.revertReason;

      // Monad charges the gas limit, so signing this would burn the whole limit for nothing --
      // but a revert at `latest` is NOT proof the send is doomed. Measured on 1,207 real mainnet
      // txs (docs/benchmark.md): refusing on any revert here wrongly refuses 8.53% of sends that
      // actually succeeded, because their precondition lands in their own block, ahead of them.
      // So what a revert DOES is policy, and the default only warns.
      const stable =
        policy.refuseOnRevert === 'stable'
          ? await revertReproduces(rpc, client, tx, block, policy.stableRevertLookback, args)
          : undefined;

      const refuse =
        policy.refuseOnRevert === 'any' || (policy.refuseOnRevert === 'stable' && stable === true);

      if (refuse) {
        if (stable === true) doomed.reason += '; still reverts ' + policy.stableRevertLookback + ' blocks back';
        return {
          verdict: 'refused_doomed',
          doomed,
          ...(stable === undefined ? {} : { revertReproduced: stable }),
          dependencySet,
          simulation,
          block,
          policy,
        };
      }

      // 'warn': let it through, but the receipt records the doomed simulation and the breaker
      // sees the repetition. One wasted send is cheap; a loop is what actually drains a wallet.
      //
      // No gas limit is chosen here: the call reverted, so there is no honest simulated gas to
      // build one from, and guessing would be the padding that causes the burn in the first
      // place. The caller keeps its own limit and `warnedDoomed` says why we could not improve it.
      return {
        verdict: 'allowed',
        warnedDoomed: doomed,
        ...(stable === undefined ? {} : { revertReproduced: stable }),
        dependencySet,
        simulation,
        block,
        policy,
      };
    }

    const gasLimitChosen = chooseGasLimit(simulation.gasUsed, { bufferPct: policy.gasBufferPct });
    const maxFeePerGas = args.maxFeePerGas ?? BigInt(await rpc.request<Hex>('eth_gasPrice', []));
    const funds = await checkFunds(client, tx, gasLimitChosen, maxFeePerGas, { rpc, pinnedBlock: block });

    if (!funds.ok) {
      return { verdict: 'refused_funds', dependencySet, gasLimitChosen, simulation, block, funds, policy };
    }
    return { verdict: 'allowed', dependencySet, gasLimitChosen, simulation, block, funds, policy };
  } catch (e) {
    // Only infra failures are fail-closed. A bug in our own argument checking must not be laundered into a
    // verdict, so anything else is rethrown.
    if (e instanceof GateInfraError && policy.failClosed) return refusePolicy(`fail-closed: ${errorText(e)}`);
    throw e;
  }
}
