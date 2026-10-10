# Validation plan: can "model vs measured" be done from outside Monad?

Date 2026-10-06. Evidence tags: [DOC] docs.monad.xyz, [SRC] category-labs/monad `main`
(tree sha e7143ff, fetched via raw.githubusercontent.com), [PROBE] our scripts (outputs in
`results/probes/`), [UNVERIFIED].

Short verdict: **the real re-execution count of a transaction is not observable from outside
a Monad node, on any RPC we can reach.** Block-level observables (gasUsed, ordering, block
interval) are by construction independent of re-execution. What we can do honestly is
(1) validate that Hotslot computes the footprint the client actually compares, and
(2) run one latency experiment that has a real chance of showing a serialisation signal
and can falsify the model's direction. Everything else must be labelled a model.

## (a) What is observable and what is not

### a1. Execution events (the only first-party instrumentation)

- Docs: https://docs.monad.xyz/execution-events/overview.md , `/event-ring.md`,
  `/getting-started/snapshot`, `/c-api.md`, `/guides/execution-events/consume-rust.md`.
- It is a **shared-memory ring buffer on the node's own host**, mapped with `mmap(2)`; the node
  is started with `--exec-event-ring`. Readers use `libmonad_event` (C) or the Rust crate
  `monad-exec-events`. Docs: readers must be "on the same host". No network protocol, and the
  docs never mention a hosted provider exposing it. [DOC]
- Event set, from `category/execution/ethereum/event/exec_event_ctypes.h`, 25 types: [SRC]
  `BLOCK_START, BLOCK_REJECT, BLOCK_PERF_EVM_ENTER, BLOCK_PERF_EVM_EXIT, BLOCK_END, BLOCK_QC,
  BLOCK_FINALIZED, BLOCK_VERIFIED, TXN_HEADER_START, TXN_ACCESS_LIST_ENTRY,
  TXN_AUTH_LIST_ENTRY, TXN_HEADER_END, TXN_REJECT, TXN_PERF_EVM_ENTER, TXN_PERF_EVM_EXIT,
  TXN_EVM_OUTPUT, TXN_LOG, TXN_CALL_FRAME, TXN_END, ACCOUNT_ACCESS_LIST_HEADER,
  ACCOUNT_ACCESS, STORAGE_ACCESS, EVM_ERROR` (+ NONE, RECORD_ERROR).
- **There is no `TXN_EXEC_*` or re-execution/retry event.** `TXN_REJECT` is for *invalid*
  transactions (payload is a validation error code, `record_txn_error_event`), not for OCC
  conflicts. The task brief's guess of those names is not in the source.
- What is there that is useful: `ACCOUNT_ACCESS` (prestate balance/nonce, `is_balance_modified`,
  `modified_balance`, `modified_nonce`) and `STORAGE_ACCESS` (`key`, `start_value`, `end_value`,
  `modified`, `transient`) per transaction, and `TXN_PERF_EVM_ENTER/EXIT` per transaction. Every
  event descriptor carries `record_epoch_nanos`. [SRC exec_event_ctypes.h,
  category/core/event/event_ring.h]. Those access events are the same data as
  `prestateTracer` diffMode, which we already get over RPC (a3 below). The ENTER/EXIT pair
  brackets the worker-thread job, which includes the stall waiting for the previous tx and any
  retry (see a2), so a per-tx duration is an indirect retry signal. It cannot be obtained
  without running a node.
- Snapshots (`exec-events-emn-30b-15m.zst`) are 30 Ethereum **mainnet** blocks replayed as a
  conformance test, not Monad traffic. [DOC snapshot page] Useless for this.

### a2. Where the real retry count lives: node log only

The executor counts retries per block and prints them. [SRC]
`category/execution/ethereum/execute_transaction.cpp`: after `can_merge` fails,
`++block_metrics_.num_retries;` then `StartRetry` and a second `execute_impl2`, with
`MONAD_ASSERT_THROW(block_state_.can_merge(state), ...)` (a retry cannot fail again).
`category/execution/runloop/runloop_monad.cpp` (~line 381) logs, per block:

    __exec_block,bl=<number>,id=..,ts=..,tx=<count>,rt=<num_retries>,rtp=<rt/tx %>,
    sr=..,txe=<tx_exec_time us>,cmt=..,tot=..,tpse=..,tps=..,gas=..,gpse=..,gps=..

So `rt` (retries) and `txe` (parallel-execution wall time) exist per block, as a text log line
at INFO level on the node operator's machine. It is aggregate per block, not per transaction,
and is not exported over RPC. Only someone running a node (or an operator who shares logs)
can read it. Hotslot cannot, on testnet, without running its own full node (hardware
requirements: see docs.monad.xyz node docs [UNVERIFIED, not read]). Whether the hosted
testnet nodes run at INFO and whether the line is shipped anywhere public: [UNVERIFIED], no
evidence of it.

Structure of the executor (same file): each transaction runs in its own job; after the first
speculative execution it does `prev_.get_future().wait()` (the `StartStall` trace) so merging
and any retry happen strictly in block order. Consequence for the proxy: the retry of tx j
starts only after tx j-1 is finished, so retries form a chain. Cost model that follows from
source: `block time ~ max(first executions) + sum(retry executions that were needed)`, i.e.
linear in the number of retried transactions (weighted by their execution cost), not in
greedy-colouring "rounds".

### a3. RPC probes, live [PROBE results/probes/rpc.json, scripts/probe-rpc.ts]

Both https://testnet-rpc.monad.xyz and https://rpc-testnet.monadinfra.com, `Monad/0.16.3`.

| Probe | Result |
|---|---|
| `monad_getBlockMetrics`, `monad_getExecutionStats`, `monad_blockStats`, `monad_getBlockRetries`, `monad_syncing`, `debug_metrics`, `txpool_status`, `rpc_modules`, `trace_block` | all `-32601 Method not found` |
| `admin_peers` | `-32604 this request method is not supported` |
| `eth_getBlockReceipts` | works (array); standard fields |
| `debug_traceBlockByNumber` (callTracer `{}`, and prestateTracer incl. `diffMode`) | **works** on both; per-tx results. This is a real, usable per-block footprint source |
| `eth_getBlockByNumber` fields | exactly the standard Ethereum set (`baseFeePerGas, blobGasUsed, difficulty, excessBlobGas, extraData, gasLimit, gasUsed, hash, logsBloom, miner, mixHash, nonce, number, parentBeaconBlockRoot, parentHash, receiptsRoot, requestsHash, sha3Uncles, size, stateRoot, timestamp, totalDifficulty, transactions, transactionsRoot, uncles, withdrawalsRoot`). No millisecond timestamp, no execution/retry/metrics field. `extraData` is all zeros |
| Receipts | standard. No per-tx execution metadata |

Block interval (timestamp is integer seconds, so measure over spans; plus a wall-clock poll):

| Method | testnet-rpc.monad.xyz | rpc-testnet.monadinfra.com |
|---|---|---|
| 100-block timestamp span | 31 s -> 310 ms (+/-10) | 30 s -> 300 ms (+/-10) |
| 1,000 blocks | 306 s -> 306 ms | 305 s -> 305 ms |
| 5,000 blocks | 1523 s -> **304.6 ms** | 1523 s -> **304.6 ms** |
| wall clock, ~30 s of polling | 102 blocks / 31.03 s = 304.2 ms | 99 blocks / 30.41 s = 307.1 ms |

**Measured block time: about 305 ms. The 300 ms of the docs is right (about 1.5 % slower in
practice); the "400 ms" in verification.md row 17 (changelog) is stale.** (Per-block timestamp
deltas in the 100-block window are 0 s in 69 and 1 s in 31 cases: whole-second resolution,
as expected for ~3.3 blocks per second.)

Gas vs limit [PROBE]: `gasLimit` 150,000,000. Over the last 100 testnet blocks the maximum
`gasUsed` was 6.1M (4.1 % of the limit; the other endpoint saw 7.1M, 4.8 %), mean 1.1-1.4M
(about 1 %), at most 8 txs per block, mean 2.3-2.5. Testnet is nearly empty.

### a4. Passive model run on real blocks [PROBE results/probes/passive-retries.json]

`scripts/probe-passive-retries.ts` applies the model.md rule (obs(j) intersect union of net(i), i<j; miner and
gas-0 system txs excluded; conservative, ignores restore-by-later-tx) to per-tx prestateTracer
output of 150 consecutive blocks (68,747,994 to 68,748,143). Result: 282 user txs, 65 blocks
with at least 2 user txs, **61 txs (21.6 %) in 45 blocks predicted re-executed** (135
storage-slot hits, 13 account nonce/balance hits). So organic testnet traffic already
contains conflicts, which a real-node log (`rt=`) would confirm or refute, but we cannot
read `rt=`. This is a prediction, not a measurement. It also proves the tooling works at
block granularity at zero cost.

### a5. Why block-level observables cannot expose re-execution

1. **Ordering and inclusion are decided before execution.** "Nodes come to consensus ... without
   ever executing those transactions"; execution lags consensus by D = 3 blocks. [DOC
   https://docs.monad.xyz/monad-arch/consensus/asynchronous-execution.md] A leader does not
   know whether a transaction will conflict, so conflicts cannot change inclusion or order.
2. **gasUsed and receipts are deterministic functions of the ordered tx list.** Re-execution
   re-computes the same result against committed state (that is the point of OCC); a retry
   changes wall time only. gasUsed per tx is identical whether or not it was retried, and
   fees are charged on gas LIMIT. [DOC gas-pricing]
3. **Throughput is gas-limit bound, not execution bound, at any load we can afford.** Block
   gas cap 150M per ~305 ms; testnet uses about 1 % of it. A 64-tx fixture burst of about 60k
   gas each is 3.8M gas, 2.6 % of a block, executed in far less than a block interval whether
   or not it conflicts. Serialisation would only change throughput if total execution time
   per block exceeded the block interval, which needs on the order of tens of millions of
   gas of *compute* per block, far beyond fixture workloads, and then only appears as growing
   execution lag, not as lower gasUsed.
4. **Block time is consensus-bound** (305 ms measured, independent of load in our window).

Hence: a shared-counter burst and a sharded burst of equal size are expected to be
indistinguishable in block number, tx order, gasUsed, tx count per block and block timestamps.
Any difference we saw there would be noise or a leader-ordering effect, not an executor effect.

### a6. The one indirect observable that can carry signal: execution lag

`latest` maps to the *Proposed* state [DOC block-states.md]. The RPC node serves block
headers with `gasUsed` and receipts, which come from executing the block, so the time at
which a block becomes retrievable through RPC includes that node's execution time
[UNVERIFIED that RPC withholds a block until executed; it must be tested: poll
`eth_getBlockByNumber(n)` at 10-20 ms intervals and record first successful `gasUsed`
and `eth_getBlockReceipts` times]. If execution of block n is slower than the block interval,
head arrivals show a gap followed by a catch-up burst. A block made of compute-heavy,
fully conflicting transactions has execution time of roughly the sum of its txs; the same
block with disjoint footprints about the max. That difference is the only external effect
we can imagine, and it is only visible if per-block execution time approaches 100 ms or
more. EVM speed is not known to us for Monad's executor [UNVERIFIED]; the experiment must
first calibrate it.

## (b) Recommended validation design

Three layers, ordered by how strong a claim each supports.

**Layer 1: footprint equivalence (the other agent's work, docs/validation.md).** Hotslot's
net(i)/obs(j) from Foundry vs the same from `debug_traceTransaction`/`debug_traceBlockByNumber`
prestateTracer on the deployed fixture. It validates the input to the model against what
the client compares per source (account record and per-slot values). Cost: gas for real
fixture calls only, a few hundredths of a MON. This is the strongest claim we can make.

**Layer 2: on-chain fixture burst, block-level null test (cheap, honest).** Purpose: show
that the product does not claim a block-level throughput effect, and show the model's
*prediction of retries* on real mined blocks.
- Setup: K distinct sender EOAs (K = 32; funded with 0.06 MON each = 1.9 MON, mostly
  recoverable; reserve-balance needs headroom of limit x price per in-flight tx), plus
  GlobalAccumulatorSerial vs GlobalAccumulatorParallel (`act(1)`), and optionally the
  ReentrancyMutex pair. Explicit gas limit 60,000 per tx (estimateGas x 1.15; Monad bills the
  limit). Send all 32 txs for one arm concurrently with distinct nonces per sender; wait for
  receipts; repeat 10 times alternating arms (ABBA order).
- Record per tx from receipts: block number, `transactionIndex`, `gasUsed`; per block:
  `gasUsed`, tx count; and the model's predicted retries from the *mined order* (reuse
  `probe-passive-retries` logic on those block numbers).
- Expected: Serial arm: predicted retries = (txs in block) - 1 per block (every tx reads
  and changes `total`). Parallel arm: predicted 0 except txs whose
  `sender % 64` shards collide (birthday collisions; model predicts them exactly from
  addresses). gasUsed per tx: Serial ~ warm SSTORE after the first call in a block;
  Parallel higher on first touch of a fresh shard (per docs/monad opcode-pricing). Inclusion
  latency, block count to include 32 txs, and ordering: no difference.
- What would **falsify** the model-as-a-gas/footprint-tool: a difference between arms in
  inclusion blocks or gasUsed that is not explained by opcode pricing. What it can NOT
  falsify: that retries happen (not observable here). State this explicitly in the README.
- Cost, from gas limits at the observed gas price of 102 gwei (`eth_gasPrice` = 0x17bfac7c00
  on 2026-10-06; base fee 100 gwei): 32 txs x 60,000 = 1.92M gas = 0.196 MON per burst;
  20 bursts = 3.9 MON, plus funding 32 senders at 21k gas each = 0.07 MON, plus 1.9 MON
  float (not spent). **Total about 4 MON spent, 6 MON to hold.** The deployer held 0 MON at
  last check (docs/deploy.md; confirmed `eth_getBalance` = 0 on 2026-10-06) so it needs the
  faucet first; faucet drip size [UNVERIFIED].

**Layer 3: execution-lag experiment (the only test with a real chance of showing
serialisation; needs a new compute-heavy fixture, not in the current set).**
- New contract `ConflictBurn` (to be written by whoever owns contracts/; not created
  here): `act(uint256 burn)` = SLOAD slot s, loop burning `burn` gas, SSTORE s+1, where `s` is
  one global slot (conflict arm) or `keccak(msg.sender)` (disjoint arm). The read happens
  *before* the burn so the speculative first execution is stale and wasted, then the retry
  pays the whole burn again after the previous tx (per the StartStall/StartRetry structure).
  In the conflict arm model.md predicts rt = M-1 for M txs in a block.
- Calibration first (cost about 1 MON): one tx burning 5M gas; measure how long the RPC
  takes to expose the block relative to the neighbour blocks, to learn Monad's speed.
- Main run: M = 8 txs x G = 4M gas (limit 4.2M) = 33.6M gas. Cost at 102 gwei: **3.4 MON
  per burst**; 2 arms x 10 paired repetitions (ABBA) = **about 69 MON**. If calibration shows
  4M gas executes in under ~5 ms, the effect (about 7 x 5 ms = 35 ms) is within RPC jitter
  and the experiment should be cancelled rather than run; scale G up to 20M (M=5: 100M
  gas, 10.2 MON per burst) only if the budget exists (too expensive for a hackathon;
  hence "optional").
- Measurement: poll head every 10-20 ms from a machine near the RPC; record for each
  burst block the first-visibility time and the inter-arrival gap versus the median gap of
  the 20 surrounding blocks; compare arms with a paired permutation test on that gap.
- Predictions: conflict-arm gap exceeds disjoint-arm gap by roughly (M-1) x t_exec(G) minus
  parallelism noise; disjoint-arm gap near zero excess. **Falsified** if, with t_exec(G) well
  above jitter (calibrated), the two arms show no gap difference: then either retries are
  cheaper than modelled (e.g., cached reads), execution is not on the RPC visibility path, or
  the testnet binary differs from `main` (also [UNVERIFIED], v0.16.3 vs source `main`).
  A null result must be reported as "not observable", not as support for the model.

**Layer 0 (only if a node is available): direct counts.** Run a Monad full node with
`--exec-event-ring` and parse the `__exec_block ... rt=` log lines (and optionally
TXN_PERF_EVM_ENTER/EXIT via `monad-exec-events`). Then compare per block: model predicted
retries (`probe-passive-retries` or Hotslot on the block) vs `rt`. This is the real validation
and is cheap in MON (free, passive, works on organic traffic: a4 shows about 22 % of user
txs are predicted retried) but needs infrastructure we do not have. Offer it as the
follow-up/"ask the Monad team for one log excerpt" path.

## (c) Honest wording for README and demo

Use:
> Hotslot's efficiency number is a conflict-graph **proxy**, not a measured throughput.
> Monad does not serialise conflicting transactions; it executes all transactions of a block
> optimistically in parallel and **re-executes** any whose inputs were changed by an earlier
> transaction in the block, merging in block order. Hotslot predicts which transactions
> would be re-executed from per-slot value changes; it does not count how many times Monad
> actually did so, because that count is not exposed by Monad's RPC, only by a node-local
> log line and a node-local shared-memory event stream.
> We validated (1) that our read/write sets match what `prestateTracer` reports for real
> transactions, and (2) [Layer 2 result]. Block time, gas used and transaction ordering are
> decided by consensus and gas, so they are identical for conflicting and non-conflicting
> workloads; Monad's gas-limit-bound throughput on testnet (about 1 % utilisation) cannot reveal
> serialisation.

Avoid: "measured speedup", "validated against on-chain throughput", "serialises" (use
"forces re-execution"), "execution events show re-execution counts", "ReentrancyGuard
serialises the contract" (model.md section 4: false per source). The risk-table line "validate
the model against measured on-chain throughput for at least one contract" cannot be met
literally; replace with "validated footprint equivalence on-chain, predicted retry rate on
real blocks, and (optionally) an execution-lag experiment".

## (d) Contradictions and refinements for docs/model.md and verification.md

1. **Block time:** verification.md row 17 says 400 ms (changelog). Measured 304.6 ms over 5,000
   blocks on both endpoints; docs essentials say 300 ms. Fix row 17.
2. **Retry cost proxy:** model.md section 5 calls greedy-colouring "rounds" a proxy. Source
   (`execute_transaction.cpp`, StartStall then StartRetry) shows retries are chained in block
   order and each retry waits for the previous tx, so the better-grounded cost proxy is
   "number of predicted-retried txs (and their gas share)", and the colouring rounds may
   understate serial cost for a long conflict chain and overstate it for sparse conflicts.
   Report `predictedRetries / txs` alongside rounds.
3. **No re-execution event exists** in the execution-event stream (25 types listed above); the
   only retry count is `num_retries` in the per-block `__exec_block` log line. model.md
   makes no claim here, but verification/PRD must not imply a direct on-chain count.
4. model.md section 5, last bullet ("testnet runs v0.15.2"): live `web3_clientVersion` is
   `Monad/0.16.3` (testnet) on both public endpoints (chain.md already says 0.16.3), so the
   "v0.15.2 not diffed" caveat should say v0.16.3 not diffed against `main` @ e7143ff.
5. Nothing found contradicts the conflict condition itself (the retry path asserts
   `can_merge`, consistent with "retry cannot fail the same way").

## Re-running

    npx tsx scripts/probe-rpc.ts --wallSeconds 30       # results/probes/rpc.json
    npx tsx scripts/probe-passive-retries.ts --blocks 150   # results/probes/passive-retries.json

Both are read-only (no key, no MON). Public RPCs are rate limited (50 rps and 20 rps); the
second endpoint dropped some blocks in the 100-block sample (64 of 100 retrieved, 429s), so the
interval numbers rely on the span and wall-clock methods, which agree.
