// Shared contracts for every Readset package. Change only via the integration owner (the lead); report needed changes instead.

export type Hex = `0x${string}`;

/** Monad chain ids: testnet 10143, mainnet 143. */
export type ChainId = number;

export interface TxRequest {
  from: Hex;
  to: Hex | null;           // null = contract creation
  data?: Hex;
  value?: bigint;           // wei
  gas?: bigint;             // gas LIMIT (Monad charges gas_limit x price)
  nonce?: number;
  chainId: ChainId;
}

/** One storage slot a simulated tx relied on. */
export interface SlotDependency {
  address: Hex;             // lowercase
  slot: Hex;                // 0x + 64 hex, lowercase
  valueSeen: Hex;           // value at simulation block (32 bytes)
  readOnly: boolean;        // true if the tx did not change it (read-only dependency)
  label?: string;           // e.g. "totalDeposits" or "balances[0xabc…]" when source/layout known
}

export interface AccountDependency {
  address: Hex;
  balance: bigint;
  nonce: number;
  codeHash?: Hex;
}

export interface TimeDependence {
  /** true if any contract in the callTracer tree contains TIMESTAMP (0x42) or NUMBER (0x43) opcodes outside PUSH data */
  flagged: boolean;
  contracts: Hex[];
  opcodes: ('TIMESTAMP' | 'NUMBER')[];
  /** set only after a differential re-simulation with the block shifted +1: true = result changed */
  confirmedByResim?: boolean;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: bigint;
  returnData?: Hex;
  revertData?: Hex;
  revertReason?: string;    // decoded Error(string)/Panic/custom error when decodable
  block: { number: bigint; hash: Hex; timestamp: bigint };
}

export interface DependencySet {
  simulation: SimulationResult;
  slots: SlotDependency[];  // sorted by (address, slot)
  accounts: AccountDependency[];
  time: TimeDependence;
  /** incomplete when the tracer omitted read-only slots (kill test K1 fallback): then only written slots are listed */
  coverage: 'full' | 'written-only';
}

export type Verdict =
  | 'allowed'
  | 'refused_doomed'        // simulation reverts
  | 'refused_breaker'       // circuit breaker tripped
  | 'refused_funds'         // cannot cover gas_limit x price / reserve balance
  | 'refused_policy';

export interface DoomedTx {
  reason: string;
  revertData?: Hex;
  revertReason?: string;
}

export interface PerTargetPolicy {
  to: Hex;
  selector?: Hex;           // 4-byte
  maxConsecutiveReverts?: number;
  maxBurnPerHourWei?: string;
}

export interface Policy {
  maxConsecutiveReverts: number;        // default 5
  maxBurnPerHourWei: string;            // decimal wei
  perTarget: PerTargetPolicy[];
  gasBufferPct: number;                 // buffer over simulated gas when setting the limit
  failClosed: boolean;                  // refuse when simulation infra errors
  /**
   * What a reverting simulation does. Default 'warn', because refusing on any revert at `latest`
   * wrongly refuses ~8.5% of real sends (docs/benchmark.md). See breaker/policy.ts for the data.
   */
  refuseOnRevert: 'warn' | 'stable' | 'any';
  /** Blocks back that 'stable' re-checks before refusing. */
  stableRevertLookback: number;
}

/** Written for EVERY send attempt, allowed or blocked. */
export interface Receipt {
  version: 1;
  id: string;               // deterministic: sha256 of canonical content, hex
  createdAt: string;        // ISO
  chainId: ChainId;
  tx: { from: Hex; to: Hex | null; data: Hex; value: string; gasLimitChosen?: string };
  verdict: Verdict;
  doomed?: DoomedTx;
  dependencySet?: DependencySet;
  policyHash: string;
  txHash?: Hex;             // present if signed & sent
  outcome?: { status: 'success' | 'reverted'; gasUsed: string; feePaidWei: string; blockNumber: string };
}

/** Explanation of why a mined tx failed / which dependency moved. */
export interface Explanation {
  txHash: Hex;
  failedBlock: bigint;
  /** per-slot movement between the tx's simulation/inclusion basis and its execution */
  movedSlots: {
    address: Hex; slot: Hex; label?: string;
    from: Hex; to: Hex;
    writerTx: Hex; writerSender: Hex; writerBlock: bigint;
  }[];
  avoidableAt: 'N-1' | 'N-2' | 'N-3' | 'same-block' | 'unavoidable' | 'unknown';
  burnedWei: string;
  gasLimit: string;
}
