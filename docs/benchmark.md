# Replay benchmark (K2): how much Monad revert burn was knowable before sending?

Real Monad **mainnet** (chain 143) transactions only. Nothing on this page is simulated data, a fork or an estimate: every row is a live re-execution of a real transaction against real archived state. Generated 2026-10-07T18:13:11.174Z by `npx tsx scripts/replay-benchmark.ts`. Raw rows: `results/replay/2026-10-07T18-13-11-174Z.json` (and `results/replay/latest.json`).

## Headline

| Metric | PRD target | Measured | Met? |
|---|---|---|---|
| Revert **burn** knowable at N-1 | >=30% | 36.41% (95% CI 28.64%-44.31%) | YES |
| Revert **burn** knowable at N-3 | >=25% | 36.34% (95% CI 29.48%-43.77%) | YES |
| False blocks on successful sends | <1% | 8.53% (95% CI 7.09%-10.24%) | NO |

**K2 verdict: PARTIAL.**

n = 1207 failed transactions (179.66 MON of real burn) and 1207 successful transactions, drawn from 1700 randomly sampled blocks.

## Sampling frame, seed and windows

- **Frame:** every user transaction mined in Monad mainnet blocks **102,648,000 – 111,215,999** (8,568,000 blocks, 30.0 days: 2026-09-07T03:35:12.000Z to 2026-10-07T03:25:24.000Z). This is the same 30-day, grid-aligned window as the failed-transaction index (`results/k2-sample.json`), so the burn denominators line up. Monad system/staking syscalls (gas limit 0) are not user sends and are excluded.
- **Primary sampling unit: the block.** 1700 distinct block numbers were drawn uniformly at random without replacement from the frame with seed **20261007** (mulberry32, the same generator and seed convention as `scripts/k2-sample.ts`). 1700 were harvested successfully.
- **Failed sample:** *every* failed transaction in each sampled block, taken from the cached SQD `monad-mainnet` index (`.readset/cache/failed/sqd/*.jsonl.gz`, built by `packages/bench/src/failed-index.ts`). Burn per failure = `gasLimit x effectiveGasPrice`, because Monad charges the gas limit (verified on 12 real failures in `docs/facts.md`).
- **Successful sample:** 1 successful transaction per sampled block, drawn uniformly at random *inside* the block with a per-block seed derived from the run seed, then randomly trimmed to exactly the size of the failed sample. Same blocks, same frame, same seed: the two samples are directly comparable.
- **Reproducible:** the seed fixes the block list, the within-block successful draw and the bootstrap. Re-running the command reproduces the identical sample; the JSONL checkpoint under `.readset/replay/` makes a partial run resumable without re-drawing.

## Method

For a transaction that failed in block N, the **exact same call** (`from`, `to`, `data`, `value`, `gas`) is re-executed against committed state at **N-1, N-2 and N-3**, each pinned by **block hash** via EIP-1898 (kill test K1 verified that Monad accepts a historical block number and a block hash on these endpoints). A revert at N-k means the state that doomed the transaction had already moved k blocks before it landed, so a gate that simulated at `latest` would have refused it.

- **Oracle:** `eth_call` at the pinned block hash, which is exactly what a client-side gate does (viem's `estimateGas`/`simulateContract` path). Cross-checked against `debug_traceCall` + `callTracer` on a seeded subsample of 40 rows: **100.00% agreement** (40/40).
- **Endpoints:** https://rpc2.monad.xyz, https://rpc-mainnet.monadinfra.com — the only free Monad mainnet endpoints that are full archive *and* allow `debug_*` (K1). Round-robin with failover, globally rate-limited to 9 requests/second (under the 10 rps self-imposed cap; documented public caps are 15-25 rps). 8,564 RPC calls in 16.5 minutes of wall time.
- **Reserve balance / insufficient funds** re-simulation failures are classified `excluded-funds` and removed from the "avoidable" numerator, as the PRD requires. They are reported as their own share so nothing is hidden.

### Classes

| Class | Meaning |
|---|---|
| `knowable` | already reverting at **N-3**: a gate catches it even with a 3-block-stale simulation |
| `latency-sensitive` | clean at N-3, reverting at N-2 or N-1: only a simulation immediately before signing catches it |
| `same-block` | clean at N-1, N-2 and N-3: whatever doomed it moved inside block N. Monad has no pending-transaction feed, so **no client-side gate can catch this** |
| `unavoidable` | clean at N-1 but the sender had an earlier transaction in block N, so state at N-1 is not what the transaction actually saw; or N-1 could not be re-simulated |
| `excluded-funds` | sender funds / Monad reserve-balance condition; excluded from "avoidable" per the PRD |

## Results

### (a) Knowable share of revert burn

Denominator: all sampled revert burn. Burn shares use a 95% percentile **cluster bootstrap over sampled blocks** (2,000 resamples); count shares use the 95% **Wilson** score interval. Burn is the metric the PRD targets; the count share is shown next to it because they differ a lot.

| Re-simulated at | Share of burn (95% CI) | Burn (MON) | Share of txs (Wilson 95%) |
|---|---|---|---|
| N-1 | 36.41% (95% CI 28.64%-44.31%) | 65.41 of 179.66 | 43.33% (95% CI 40.56%-46.14%) (523/1207) |
| N-2 | 36.74% (95% CI 29.61%-44.69%) | 66 of 179.66 | 44.74% (95% CI 41.96%-47.56%) (540/1207) |
| N-3 | 36.34% (95% CI 29.48%-43.77%) | 65.28 of 179.66 | 47.31% (95% CI 44.50%-50.13%) (571/1207) |

Excluding sender-funds / reserve-balance reverts from the denominator as well (the PRD's strict "avoidable" base):

| Re-simulated at | Share of eligible burn (95% CI) | Share of eligible txs (Wilson 95%) |
|---|---|---|
| N-1 | 36.71% (95% CI 29.41%-44.30%) | 44.32% (95% CI 41.51%-47.17%) (523/1180) |
| N-2 | 37.04% (95% CI 29.37%-45.43%) | 45.76% (95% CI 42.94%-48.61%) (540/1180) |
| N-3 | 36.63% (95% CI 29.78%-44.18%) | 48.39% (95% CI 45.55%-51.24%) (571/1180) |

The three depths are measured **independently**, and the result is not perfectly monotone: 133 of 1207 failed transactions reverted at N-3 but were clean again at N-1 (state moved back). They satisfy the PRD's definition of `knowable` ("reverts at N-3") but a gate simulating at `latest` would not have caught them, which is why the N-1 column, not the class label, is the number to quote for what Readset actually stops. 0 rows could not be re-simulated at all three depths.

### Class distribution

| Class | Txs | Share of txs (Wilson 95%) | Burn (MON) | Share of burn (95% CI) |
|---|---|---|---|---|
| `knowable` | 571 | 47.31% (95% CI 44.50%-50.13%) | 65.28 | 36.34% (95% CI 29.60%-43.53%) |
| `latency-sensitive` | 92 | 7.62% (95% CI 6.26%-9.26%) | 22.88 | 12.73% (95% CI 6.70%-19.90%) |
| `same-block` | 483 | 40.02% (95% CI 37.29%-42.81%) | 85.11 | 47.37% (95% CI 40.00%-55.01%) |
| `unavoidable` | 34 | 2.82% (95% CI 2.02%-3.91%) | 4.94 | 2.75% (95% CI 1.62%-4.13%) |
| `excluded-funds` | 27 | 2.24% (95% CI 1.54%-3.24%) | 1.45 | 0.81% (95% CI 0.36%-1.33%) |

**The share we cannot catch:** `same-block` is 47.37% (95% CI 40.09%-54.80%) of revert burn by burn and 40.02% (95% CI 37.29%-42.81%) by transaction count. Monad accepts a `newPendingTransactions` subscription but never emits on it (`docs/facts.md` #7), so this share is invisible to any client-side guard, including Readset. **Excluded (funds / reserve balance):** 0.81% (95% CI 0.37%-1.31%) of burn, 2.24% (95% CI 1.54%-3.24%) of transactions.

### (b) False blocks

On an equal-size sample of transactions that actually **succeeded** on chain, re-simulated at N-1: a revert there is a transaction Readset would have wrongly refused. Every candidate false block had its receipt re-read on chain to confirm the transaction really succeeded.

| Measure | Rate (Wilson 95%) |
|---|---|
| False-block rate (headline) | 8.53% (95% CI 7.09%-10.24%) (103/1207) |
| Excluding sends whose sender had an earlier tx in the same block | 8.98% (95% CI 7.43%-10.82%) (99/1102) |
| Upper bound: counting funds / reserve-balance refusals too | 11.60% (95% CI 9.91%-13.53%) (140/1207) |
| Gas-limit-weighted (cluster bootstrap) | 2.12% (95% CI 1.35%-3.00%) |


Every successful send that re-simulated as a revert at N-1:

| Tx | Receipt re-check | Sender had an earlier tx in block N | Reason |
|---|---|---|---|
| `0xd8dc6acac45f0a28963de153223f7d4eb3f466510953bf2c36776b1eb302bc8f` | success | no | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain |
| `0xf56405b110fd9b8233eb390c0736c5b44e0230f0c6a5648febd07a11046ad246` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0xc4792d192d19315ae2d1648d25ef487537060078460301161c960884a46e4bba` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x9797b64771850346000fb6836d14c13efdbe3405f140b5595bc3cac2d129e686` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0xd895831bebe36e23ee3307ae23a3511fc96cb6d5288b461e72f2ec5264a64ffc` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x2dcaa86fb7d7e79755ee620b27149065f936c2de039b209e36139120658039db` | success | no | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain |
| `0x5c5755a747e778e63493f5e97a4ad3430921606d982f1d50c7b185f66d99f5ca` | success | yes | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain (sender had an earlier tx in block N, so N-1 state is stale for it) |
| `0x7a8d31937b9a0bd90a974c8009baf910efc6371c81bad9935bc6208903c65f0a` | success | no | FALSE BLOCK: reverts at N-1 (out of gas) although the tx succeeded on chain |
| `0x293c7e40983858319f2f5543eac7b637f48ce93b0a0d1edd163acbf4d5c1ff7b` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x89d4e006f60eb286a7585fe533b9b46488feb5a15e6f3c7782ab097b736dae5b` | success | no | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain |
| `0x92c0287a45cacc408e94e45f4801e7d8d26d7f360afd1821543e8a23f703c3c4` | success | no | FALSE BLOCK: reverts at N-1 (out of gas) although the tx succeeded on chain |
| `0xa2cbda668a785de3fc109a9b71fb0d0d1da68f8595291e65058e3ec5dcfc75ca` | success | no | out of gas at the sender's own limit (29584) but clean with headroom: the gate raises the limit instead of refusing, so not a false block |
| `0x42d96973f56b7e8170a7424fc48370dede08044691fdb524dc91463c17fa6b54` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x5d735d43cbcdf8e2d0ba8e7647e97a01e0c8f69fda073d6254ead39bc9468dff` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x57c34533cfa0d301bc23700d184b7a384a5f42311f76307982b3a265e241b997` | success | no | FALSE BLOCK: reverts at N-1 (out of gas) although the tx succeeded on chain |
| `0xd7a06f9ae489750e6b3009df2b82d12e8766f6de7f28db9cd16a476000ae4bb3` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x65995bf31cf61f93ecc8c5b6ef86e7fa7948b0b4cbbf6979a4ce7b4171e03684` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0xb24e46c1f1bba3e0f3be51f9dac5ca4070b103a8e068b5181f14e1af9bc06a16` | success | no | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain |
| `0xfd2ec87c0f3e4329865811d017bb74ea6d5b4d7ce0a7fc0287dd387c8db4f4c6` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0x9a2d53e2127c30a6bdb97bcbd74c08f441274c1dd4197cabd63da60653232110` | success | no | FALSE BLOCK: reverts at N-1 (out of gas) although the tx succeeded on chain |
| `0xb8be45d46b06f281506c64584492a51d06d5487518debc3ef95487b6918438ba` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0xc23b964cc5070cfa8804f993152c8abe29c7cf8da6283c6e7e62b588445d1225` | success | yes | out of gas at the sender's own limit (29584) but clean with headroom: the gate raises the limit instead of refusing, so not a false block |
| `0xd96a8a1be29340668edb7cb452336d198b9f0655f1e0f3b24d6b427b6147b858` | success | no | FALSE BLOCK: reverts at N-1 (user-specified gas exceeds provider limit) although the tx succeeded on chain |
| `0x0102036b3907421a1007f2289195ad3c10c34c2bc29eee6eb10c69a2feab75f7` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |
| `0xdf71364fa9131e69eb767d9904e8f9f26cd8af0f37549bbe4a532f2a0b913ec4` | success | no | FALSE BLOCK: reverts at N-1 (execution reverted) although the tx succeeded on chain |

### Where the knowable burn is

| `to` | selector | knowable failures | burn (MON) |
|---|---|---|---|
| `0x81b8e2832d00381449223d9874f041114ebd36b8` | `0x41a8f47c` | 46 | 14.67 |
| `0x37db7fbf671c3de8f6beafbdfc6e6633353eec7b` | `0x5acec890` | 44 | 6.81 |
| `0x34ae4d081c0d46b23ebf5292c1be4e45f8a73fc5` | `0x4297b034` | 25 | 4.66 |
| `0x0bc188ba77851d2d80aa0c692ea1d523475ba36d` | `0x0756e95c` | 2 | 3.91 |
| `0x21114915ac6d5a2e156931e20b20b038ded0be7c` | `0x04e45aaf` | 18 | 2.76 |
| `0x0bc188ba77851d2d80aa0c692ea1d523475ba36d` | `0xcf7468f4` | 1 | 2.58 |
| `0x37db7fbf671c3de8f6beafbdfc6e6633353eec7b` | `0x3e2e8792` | 15 | 2.52 |
| `0x553037bac82741e7ca05afb48e8538996fd70eca` | `0x09c5eabe` | 3 | 1.75 |
| `0x0d97dc33264bfc1c226207428a79b26757fb9dc3` | `0x3593564c` | 11 | 1.69 |
| `0x1ab25d77e5979fa3bbafcd1b070d932dbc0231db` | `0x50a0b275` | 3 | 1.59 |

## Limits (read these before quoting the numbers)

1. **Re-simulating at N-1 approximates, but is not, the real pre-send moment.** A bot may have signed many blocks earlier, or microseconds before inclusion. N-1 is the closest *observable* proxy for "the last state a gate could have seen". It is an upper bound on what a gate simulating at `latest` sees, and a lower bound on what a gate simulating long before sending sees.
2. **`latest` on Monad is a Proposed block and can be abandoned.** Our N-1/N-2/N-3 states are finalized history; a live gate reads a block that may be rolled back. The abandonment rate is measured separately (`packages/bench/src/abandonment-report.ts`) and must be read next to the false-block rate.
3. **No pending-transaction feed.** Same-block races cannot be seen by any client-side guard; that share is reported above and is not claimed as savings.
4. **Self-ordering.** A transaction whose sender had an earlier transaction in the same block is re-simulated against stale own-state. Those rows are flagged, classed `unavoidable` on the failed side, and reported separately on the false-block side rather than silently counted.
5. **Gas is replayed as sent on the failed side, gate-mode on the successful side.** Failed transactions are re-simulated with their own gas limit, so an out-of-gas failure shows up as a revert and counts as knowable; that is correct for that question, but it means the "knowable" bucket is not purely state races. Successful transactions get a second look: Readset's gate simulates with headroom and then *chooses* the limit (`packages/core/src/gate/gas.ts`), so an out-of-gas at the sender's own tight limit is something Readset fixes, not something it refuses. Re-checking those with headroom removed 37 of 140 apparent false blocks (11.59% → 8.53%). Counting them would have measured the sender's padding and called it our error.
6. **Burn shares are cluster-bootstrapped over blocks, not Wilson.** Wilson assumes a binomial count; burn is a heavily skewed sum dominated by a few large-gas senders (the top-50 senders carry ~71% of burn, `results/k2-sample.json`), so the burn interval is wider and honest about that.
7. **One sampling frame, one chain.** Mainnet only, one 30-day window. Results will move with mainnet activity; re-run before quoting.

## Reproduce / scale up

```sh
# exactly this run (resumes from .readset/replay/<run> if present)
npx tsx scripts/replay-benchmark.ts --blocks 1700 --seed 20261007 --rps 9

# scale up: ~5 RPC calls per failed tx (2 block fetches amortised + 3 re-simulations) and 1 per successful tx.
# At 9 rps, wall time ~= (2 x blocks + 3 x failedTxs + successfulTxs) / 9 seconds.
npx tsx scripts/replay-benchmark.ts --blocks 3000 --budget-min 60   # ~2,500 failed txs, ~35 min
npx tsx scripts/replay-benchmark.ts --blocks 6000 --budget-min 150  # ~5,000 failed txs, ~70 min
```

Observed cost for this run: 8,564 RPC calls for 1207 failed + 1207 successful transactions (7.1 calls per failed tx), 16.5 min at 9 rps. Reaching the PRD's 2,000 failed transactions needs about 2817 sampled blocks, about 25 minutes at 9 rps (linear, and resumable: the checkpoint means several short runs add up to one big sample). A paid archive key removes the rps cap and the whole 2,000-tx run finishes in a few minutes.


---

## The false-block rate decides the product's default

This is the result that changed Readset's design, so it is stated before the flattering numbers.

The PRD's target was **under 1% false blocks**. Measured on 1,207 real successful mainnet
transactions, a gate that refuses whenever the simulation reverts at `latest` would have refused:

| Rule | False blocks | Rate |
|---|---|---|
| Refuse on any revert at N-1 (`refuseOnRevert: 'any'`) | 103 / 1207 | **8.53%** [7.09, 10.24] |
| Require the revert to reproduce at N-3 (`'stable'`) | 52 / 1207 | **4.31%** |

The stable rule is measured by `scripts/stable-revert-check.ts`, which re-simulates each
false-block candidate three blocks back. Of 103 candidates: 52 still reverted, 12 were clean,
and **39 could not be measured** (pruned state or a throttled endpoint). Those 39 are not
assumed away: the true stable rate is between **4.31%** (all unmeasurable cases benign) and
**7.54%** (all of them genuine), so the honest claim is "4-8%, and still far above 1%".

Requiring stability costs almost nothing in detection, which is why it is worth having at all:
knowable burn is 36.41% at N-1 and 36.34% at N-3 — statistically the same number.

### Why these are not bugs in the oracle

A transaction that reverts against block N-1 and then succeeds inside block N is not a
measurement error. Its precondition was written by an earlier transaction *in its own block* —
a router being funded, an auction being opened, an allowance being set. A client-side gate
simulating at `latest` genuinely cannot see that state, and would genuinely refuse the send.
This is the same blind spot as the same-block race on the failed side, seen from the other
direction, and no amount of RPC access fixes it without a pending-transaction feed (which
Monad does not expose).

### What we therefore shipped

`policy.refuseOnRevert` defaults to **`'warn'`**: a reverting simulation is recorded in the
receipt and fed to the breaker, and the send still goes out. Hard refusal is opt-in, per
operator and per target, for the places where a wasted gas limit costs more than a missed
opportunity. `'stable'` is offered for operators who want refusal with the lower error rate.

A guard that silently blocked 1 in 12 of an agent's good transactions would be worse than no
guard at all, and we would rather say that than ship the 36% headline on its own. What survives
unconditionally is the part that does not depend on predicting a revert: **every attempt leaves
a receipt**, and **the breaker stops a loop** — 53,592 MON of the 30-day loop burn would have
been stopped by a breaker of 5 (`docs/kill-tests/K2.md`), and that figure needs no prediction at
all, only counting.
