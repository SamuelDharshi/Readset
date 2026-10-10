# The Gate

Decide, **before signing**, whether a transaction is doomed — and record what the decision depended on.

Why it has to exist on Monad: the chain charges `gas_limit × price_per_gas`, not gas used
(docs.monad.xyz/developer-essentials/gas-pricing, VERIFIED in `docs/facts.md` #1a), so a transaction that
reverts pays its **whole** limit. We confirmed that on 12 real mainnet failures: the sender's balance fell
by exactly `tx.gas × receipt.effectiveGasPrice` in 12 of 12 cases (`docs/facts.md` #10). A simulation that
costs one `eth_call` is therefore worth it.

Files: `packages/core/src/gate/{simulate,dependency,funds,gas,index}.ts`.
Tests: `packages/core/test/gate.test.ts` (real testnet **and** mainnet, read-only).

> Not yet re-exported from `packages/core/src/index.ts` (owned by the integration lead). Import from
> `packages/core/src/gate/index.js`, or ask the lead to add `export * from './gate/index.js'`.

## Exported API

```ts
// index.ts — the whole gate in one call. Never signs, never sends, never writes.
gate(args: GateArgs): Promise<GateResult>
DEFAULT_GATE_POLICY: Policy                      // gasBufferPct 20, failClosed true

interface GateResult {
  verdict: Verdict                               // allowed | refused_doomed | refused_funds | refused_policy
  doomed?: DoomedTx                              // reason + revertData + decoded revertReason
  dependencySet?: DependencySet
  gasLimitChosen?: bigint
  simulation?: SimulationResult
  block?: PinnedBlock                            // the block every check was pinned to
  funds?: FundsCheck
  policy: Policy                                 // defaults merged in
  error?: string                                 // set for refused_policy (incl. fail-closed)
}

// simulate.ts
simulate(client, tx, blockTag = 'latest', opts?): Promise<SimulationResult>
pinBlock(rpc, blockTag = 'latest'): Promise<PinnedBlock>          // { number, hash, timestamp }
createGateRpc(client, opts?): GateRpc                             // failover pool, 2 s per attempt
endpointsFor(client, extra?): string[]
decodeRevertReason(data?): string | undefined
extractRevertData(err) | isExecutionError(err) | errorText(err)
GateInfraError, ERROR_STRING_SELECTOR, PANIC_SELECTOR, PANIC_REASONS

// dependency.ts
buildDependencySet(client, tx, pinnedBlock, opts?): Promise<DependencySet>
scanBytecode(code?): { timestamp, number, size }
timeDependenceFromCode(codes): TimeDependence
TIMESTAMP_OPCODE = 0x42, NUMBER_OPCODE = 0x43

// funds.ts
checkFunds(client, tx, gasLimit, maxFeePerGas, opts?): Promise<FundsCheck>
RESERVE_BALANCE_WEI = 10e18, DELEGATION_PREFIX = '0xef0100'

// gas.ts
chooseGasLimit(simulatedGas, { bufferPct = 20, maxGas, minGas }): bigint
MONAD_TX_GAS_LIMIT = 30_000_000n, MIN_TX_GAS = 21_000n
```

## Order of checks

1. `eth_chainId` must match `tx.chainId`, else `refused_policy` before anything is simulated.
2. Pin the block: one header fetch, then **every** later request addresses it by `blockHash`. `latest` on
   Monad is a Proposed block that can be abandoned (PRD "Honest limits"); pinning keeps one gate decision on
   one state instead of silently straddling two.
3. `simulate`: `eth_call` decides success/revert; `eth_estimateGas` supplies `gasUsed` and **only** when the
   call succeeded. A revert → `refused_doomed` with the raw `revertData` and a decoded reason.
4. `chooseGasLimit(simulatedGas, { bufferPct })`.
5. `checkFunds(gasLimit, maxFeePerGas)` → `refused_funds` when the sender cannot cover
   `gas_limit × price + value`.
6. `buildDependencySet` runs for **every** verdict, allowed or refused, so a refused send still leaves a
   receipt that can be diffed later (PRD component 2). A failure here never changes the verdict.

The circuit breaker (`refused_breaker`) is a separate component and runs *before* this gate.

## Revert decoding

| Input | Output |
| --- | --- |
| `Error(string)` (`0x08c379a0`) | the string, e.g. `Multicall3: call failed` |
| `Panic(uint256)` (`0x4e487b71`) | `Panic(0x11): arithmetic overflow or underflow` (10 documented codes) |
| any other selector | `custom error 0x<selector> (no ABI available to name it), args 0x…` |
| empty revert data | `undefined`; the verdict reason then says "no revert reason" |

Custom errors are **passed through, never guessed**: without the target's ABI we have no honest way to name
`0xfb8f41b2`. A caller with the ABI can decode `doomed.revertData` itself.

## Dependency set (how, and what it cannot see)

Kill test K1 (`docs/kill-tests/K1.md`) decided the shape:

> `prestateTracer` lists read-only slots — **PASS only in non-diff mode**. `diffMode:true` omits them.

So:

| Part | Source |
| --- | --- |
| Storage slots + values seen | **non-diff** `prestateTracer` on `debug_traceCall`, pinned by block hash |
| `readOnly` flag | a second, `diffMode:true` trace of the same call; `readOnly = slot ∉ diff write set` |
| Sender balance / nonce | `eth_getBalance` + `eth_getTransactionCount` at the pinned block hash |
| Other accounts | the trace's own `pre` values; `codeHash = keccak256(code)` when code was reported |
| Time / block dependence | `callTracer` tree → `calleeAddresses` → `eth_getCode` → opcode scan |

`coverage` is `'full'` when the non-diff trace succeeded (read-only slots included) and `'written-only'`
when the endpoint refused it and only the diff trace survived — the K1 fallback, which never actually
triggered on the Monad endpoints we tested.

The test `the dependency set contains the read-only balance slot` proves this end-to-end on both networks:
it computes `keccak256(abi.encode(holder, balancesSlot))` for a real ERC20, finds that slot in the
dependency set with `readOnly: true`, and then shows that a `diffMode` trace of the same call reports
**zero** storage slots.

### Time dependence is a heuristic, and stays one

`scanBytecode` walks runtime bytecode for `TIMESTAMP` (0x42) / `NUMBER` (0x43), skipping PUSH1–PUSH32
immediates so a `0x42` byte *inside* pushed data is not mistaken for the opcode. It over-reports on purpose:
trailing solc metadata and unreachable code are scanned too, and Monad exposes no struct logs, so the
opcodes a call *really executed* are invisible — this says what the code **could** do.

`TimeDependence.confirmedByResim` is **always `undefined`**. Confirming the flag needs the same call re-run
with the block shifted +1, and K1 established that on Monad:

- `eth_call` block overrides (4th param, `time`/`timestamp`/`number`) are **rejected** (`-32602`);
- `debug_traceCall` `blockOverrides` are **silently ignored** (the contract still read the real values).

That differential therefore needs a **local fork**, which the Gate deliberately does not run — and a local
fork would not reproduce Monad's gas pricing or reserve-balance rules anyway (PRD "Honest limits"). The
field is left unset rather than filled with a guess, and `flagged` is reported as the heuristic it is.

## Funds and the reserve balance

Worst case is `gas_limit × max_fee_per_gas + value`, in full, success or revert.

The reserve rule (docs.monad.xyz/developer-essentials/reserve-balance, condensed in
`docs/lineage/monad-docs/reserve-balance.md`): `user_reserve_balance` is **10 MON** per EOA; execution
reverts when an **EIP-7702-delegated** account's balance decreases *and* ends below the reserve; consensus
excludes transactions whose cumulative inflight gas fees exceed the available reserve budget; and
"emptying transactions" (the first tx in k blocks from an **undelegated** account) are exempt.

Implemented as:

- `balance < required` → `ok: false` (hard).
- sender delegated (code starts `0xef0100`) **and** `balance − required < 10 MON` → `ok: false`, citing the
  revert rule.
- sender undelegated and `balance − required < 10 MON` → `ok: true` with `reserveRisk: true` and a reason.
  Refusing here would block the legitimate "spend the whole wallet" case the emptying-tx exception allows;
  the exact consensus budget is not observable from the RPC, so this is surfaced, not decided.

## Gas limit

`chooseGasLimit` = simulated gas + `bufferPct` (default 20, fractional percentages exact, rounded **up**),
clamped to `[21_000, 30_000_000]`. It throws on a non-positive `simulatedGas` rather than defaulting,
because a wrong limit is paid for in full.

**Credit:** the question "what limit should you set on Monad?" was researched by Category Labs,
*Setting your gas limit on Monad* (<https://www.category.xyz/blogs/setting-your-gas-limit-on-monad>): 6.0%
of 8.15M transactions failed over 12–18 Jan 2026 with only 0.58 points out-of-gas, and
"`gas_used` is trivially set to `gas_limit` on Monad in the transaction receipt at the top call level", so a
receipt cannot tell you what the code needed (both re-checked in `docs/facts.md` #2, #3). Readset makes **no
claim** to improve on their buffer research; where their dynamic buffer is available, feed it in as
`bufferPct`.

## Endpoints, timeouts, fail-closed

K1 measured p50 0.2–1 s and p95 up to 15 s on the public endpoints, so `createGateRpc` is a small failover
pool: each endpoint gets **2 s**, then one patient attempt (15 s default) on the primary. Execution errors
are rethrown immediately — the node did its job, there is nothing to fail over to. Only infra errors and
timeouts move on; when every attempt fails it throws `GateInfraError` listing each endpoint and error.

`policy.failClosed` (default **true**) turns that into `verdict: 'refused_policy'` with
`error: "fail-closed: …"`. With `failClosed: false` the `GateInfraError` is rethrown. Argument errors from
our own code are **never** laundered into a verdict — they are always rethrown.

Pass `endpoints` to replace the endpoint list entirely (it is an override, not an addition).

## Tests

`npx vitest run packages/core/test/gate.test.ts` — 34 tests, every network assertion against real Monad
testnet (10143) and mainnet (143), read-only, nothing mocked. If an endpoint is unreachable the affected
tests skip **loudly** (`console.warn` + `ctx.skip`) instead of passing.

On-chain fixtures, all verified live rather than assumed:

- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11`, deployed at the same address on both
  networks (7618 bytes each). `getCurrentBlockTimestamp()` succeeds *and* its bytecode really uses
  `TIMESTAMP`; `aggregate([(self, 0xdeadbeef)])` reverts with `Error(string) "Multicall3: call failed"`.
- **Allowed/doomed sender** `0x…dEaD`: holds MON on both chains, has no code, and nothing is ever signed
  with it. Its balance is asserted, not assumed.
- **Read-only slot**: mainnet WMON `0x3bd359…433A` (balances at slot 3) and the testnet ERC20
  `0x0f1c3b…7b2e` (slot 0) from `results/k1.json`, with the holders K1 used.
- **Unfunded sender** `0xabab…ab`: 0 wei on both networks (asserted in the test).

What the tests prove: a pinned simulation returns the pinned block's own timestamp and is reproducible; a
real revert becomes `refused_doomed` with a decoded reason and a dependency set; a known-good call is
`allowed` with `gasLimitChosen > simulatedGas` and the fee priced off the **limit**; the read-only balance
slot is present while `diffMode` shows nothing; the bytecode scan flags a real `block.timestamp` user and
leaves `confirmedByResim` undefined; an unfunded sender is `refused_funds`; a wrong `chainId` is refused
before simulating; a dead primary endpoint fails over to a real one; and a pool of only-dead endpoints
yields `refused_policy` under `failClosed`, or throws when it is off.

## Honest limits (this component)

- Same-block races are invisible: Monad has no pending feed (`docs/facts.md` #7 — the subscription is
  accepted and never emits).
- `latest` is a Proposed block and can be abandoned; pinning by hash makes a decision self-consistent, not
  guaranteed to be the block that lands.
- Time dependence is a heuristic scan; no `+1`-block confirmation (no block overrides on Monad).
- `eth_estimateGas` is the node's own binary search; it is not a promise about execution in a later block.
- No malicious-contract analysis. That is a different product.
