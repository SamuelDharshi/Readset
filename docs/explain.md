# Explain: "Why your bot lost"

PRD components 3 (Explain) and 4 (the paste-a-hash page). Given **any failed Monad mainnet transaction hash**,
Readset answers three questions and refuses to answer more than it can prove:

1. **Which dependency moved?** — the storage slots the transaction relied on whose value changed between the
   state a sender could have simulated against and the state it actually executed against.
2. **Who moved it?** — the transaction that *last wrote* that `(address, slot)` before ours ran, with its sender.
3. **Was it knowable before sending?** — re-simulate the exact same call at the end of blocks N-1, N-2 and N-3.

Code: `packages/core/src/explain/{failed-tx,writers,avoidable,index}.ts`. Tests: `packages/core/test/explain.test.ts`
(real mainnet transactions sampled at run time; no fixtures, no mocks).

> The integration owner still needs to add `export * from './explain/index.js';` to
> `packages/core/src/index.ts`. Until then, import from `@readset/core`'s `src/explain/index.js`.

## API

```ts
import { explainFailedTx, classifyBatch } from '@readset/core'; // after the index re-export lands

const e = await explainFailedTx(client, '0x…');   // Promise<FullExplanation> (superset of types.Explanation)
e.avoidableAt;      // 'N-1' | 'N-2' | 'N-3' | 'same-block' | 'unavoidable' | 'unknown'
e.avoidableClass;   // 'knowable' | 'latency-sensitive' | 'same-block' | 'unavoidable' | 'unknown'
e.avoidable;        // true only for knowable / latency-sensitive
e.burnedWei;        // gasLimit x effectiveGasPrice, as a decimal string
e.movedSlots;       // shared Explanation rows: address, slot, label?, from, to, writerTx, writerSender, writerBlock
e.rationale;        // one honest paragraph, built only from observed outcomes

const batch = await classifyBatch(client, hashes, { concurrency: 2 });  // for the benchmark agent
batch.distribution; // { total, byClass, byAvoidableAt }
```

| Export | What it is |
|---|---|
| `explainFailedTx(client, txHash, opts?)` | The whole pipeline. Returns `FullExplanation`. |
| `FullExplanation` | `types.Explanation` plus `avoidableClass`, `avoidable`, `rationale`, `resims`, `executedRevert`, `executedSlots`, `attributedMovements`, `unattributedMovements`, `writerScan`, `burn`, `notes`. |
| `explanationToJson(e)`, `summarize(e)` | JSON-safe view (bigint → string) and a one-line summary. |
| `findSlotWriters(client, slots, opts)` | Writer attribution on its own. |
| `lastWritesInBlock(entries, beforeIndex?)` | Pure: last write per slot in one `debug_traceBlockByNumber` diffMode result. |
| `burnFacts`, `decodeRevert`, `isFundsFailure`, `classifyResims`, `verdictDistribution`, `totalBurnedWei` | Pure helpers. |
| `classifyBatch(client, hashes, opts?)` | Concurrency-capped batch for the replay benchmark. |
| `rankMovements`, `MONAD_SYSTEM_ACCOUNTS` | Movement ordering and the system-account list (below). |

`ExplainOptions`: `maxWriterBlocks` (default 4), `prestateAtEveryK` (default true), `maxStorageReads`
(default 64), `labeler`, `allowSuccess`, `minIntervalMs` (default 120).

## Method, step by step

1. `eth_getTransactionByHash` + `eth_getTransactionReceipt`. A receipt with `status != 0x0` is **refused**
   (`allowSuccess` overrides). Burn is `tx.gas x receipt.effectiveGasPrice`, and `receipt.gasUsed == tx.gas`
   is cross-checked (`burn.receiptGasUsedEqualsLimit`), because Monad charges the limit, not the gas used.
2. `debug_traceTransaction` with **non-diff** `prestateTracer` → the dependency set and the slot values the
   transaction actually executed against, mid-block, at its own index. `callTracer` on the same hash → the
   revert payload of the deepest failing frame, decoded as `Error(string)` / `Panic(uint256)` / custom error.
3. Re-simulation: for k = 1, 2, 3 the **exact same call** (`from`, `to`, `data`, `value`, `gas`) is run against
   the END state of block N-k, pinned by **block hash** (EIP-1898 `{"blockHash":…}`, confirmed by K1) so the
   basis is exact and reproducible. `eth_call` gives the verdict; non-diff `prestateTracer` on
   `debug_traceCall` gives the dependency set it *would* have seen (K1: `diffMode` omits read-only slots, so
   non-diff is mandatory here).
4. A per-slot value timeline over `[N-3, N-2, N-1, executed]`, with gaps filled by `eth_getStorageAt` at the
   same pinned hashes (capped by `maxStorageReads`). A slot **moved** when two adjacent known values differ.
5. Writer attribution (below).
6. Verdict (below).

## Verdict table

| Observation | `avoidableClass` | `avoidableAt` | `avoidable` |
|---|---|---|---|
| Re-sim already reverted at N-3 | `knowable` | `N-3` | yes |
| Reverted at N-2 but not N-3 | `latency-sensitive` | `N-2` | yes |
| Reverted only at N-1 | `latency-sensitive` | `N-1` | yes |
| **Still succeeded at N-1** | `same-block` | `same-block` | **no** |
| Node refused it, or it reverted, for funds / reserve balance | `unavoidable` | `unavoidable` | no |
| N-1 basis unusable (pruned state, RPC error) | `unknown` | `unknown` | no |

Honesty rules, enforced in code and asserted in the tests:

- **If the re-simulation succeeds at N-1, the verdict is `same-block` and nothing is claimed about
  avoidability.** Only an earlier transaction inside block N can explain it, and Monad has **no
  pending-transaction feed** (`newPendingTransactions` accepts the subscription and emits nothing, see
  `docs/facts.md` #7), so it was **not detectable before sending**. `undetectableWithoutPendingFeed` is set
  and the rationale says so.
- **Reserve-balance / insufficient-funds failures are never counted as avoidable** (PRD). The match is
  deliberately narrow (`FUNDS_ERROR_RE`): a contract reverting with "transfer amount exceeds balance" is a
  real dependency move and stays eligible.
- A moved slot reaches `movedSlots` (the shared `Explanation` shape, which requires a writer) **only when a
  real writer transaction was found**. Everything else goes to `unattributedMovements` together with
  `writerScan.blocksScanned`, so a missing writer is visible rather than invented.
- When nothing moved inside the scanned window, a note says the cause moved earlier. This is the normal case
  for `knowable` failures: the state broke more than three blocks before the send.

## Writer attribution

`debug_traceBlockByNumber` with `prestateTracer` + `diffMode:true` returns one `{txHash, result:{pre,post}}`
entry per transaction in block order, listing exactly the slots each transaction changed with both values.
The scan walks **nearest write backwards in time**:

```
block N (only transactions ordered BEFORE the failed one) -> N-1 -> N-2 -> N-3
```

The failed transaction's own entry is located by `txHash` (falling back to the receipt index) to set the
cut-off inside block N. The first hit wins, so the result is the *last* write before our transaction ran. The
writer's sender comes from one `eth_getTransactionByHash` per distinct writer — never from the trace alone.

**Cost, measured on mainnet (K1):** one `debug_traceBlockByNumber` per candidate block, ~0.22–0.35 MB and
0.13–2.7 s each, **independent of how many slots are queried** (one pass builds the whole block's write map).
Default cap `maxWriterBlocks = 4` → at most 4 block traces (~1.4 MB) per explanation. A whole explanation is
~15–20 RPC calls; `capped: true` means slots were still unattributed when the cap was reached.

### Slot labels

Labels come from core's labeller (`buildSlotLabeler`), which needs the contract's **solc storage layout**.
Verified mainnet contracts are not compiled here, so by default **slots are reported raw** and a note says so.
Pass `labeler` to get names like `reserves` or `balances[0xab…]`; unresolved labels are dropped rather than
guessed.

### Monad's system account

Real traces show storage movements at `0x0000000000000000000000000000000000001000`, an account with **no code**
and a very large balance (protocol staking / fee accounting) that moves in nearly every block. Those rows are
flagged `systemAccount: true`, ranked last by `rankMovements`, and never quoted as the cause — but they are
**not deleted**, so the raw evidence stays visible.

## Determinism

Every basis is pinned by block hash and every array is sorted, so the same hash yields the same explanation.
The test asserts a deep equality of two independent runs (ignoring `notes` / `writerScan`, which can mention
transient RPC errors).

## RPC requirements

Mainnet **archive + debug tracing**: `https://rpc2.monad.xyz` (Goldsky) or
`https://rpc-mainnet.monadinfra.com`. `rpc.monad.xyz` keeps only ~1.5M blocks (~7 days) and
`rpc1`/`rpc3.monad.xyz` block `debug_*` entirely (K1). Throttle under ~10 rps: `minIntervalMs` spaces heavy
calls, `withBackoff` retries 429s, and `classifyBatch` caps concurrency (default 2) with a start interval.

## What this cannot do

- **Same-block races stay unexplained ex ante.** We can name the earlier transaction in block N afterwards; no
  client could have seen it coming without a pending feed.
- `knowable` failures whose cause moved before N-3 get no writer: the window is 4 blocks by design.
- Non-diff `prestateTracer` cannot separate reads from writes, so `SlotDependency.readOnly` is reported `true`
  for every slot in a dependency set and `coverage` is `'full'` only in the K1 sense (read-only slots are
  present).
- Account balance / nonce dependencies are not diffed here, only storage slots.
- `eth_call` at an old basis uses that block's fee rules; a transaction that failed purely because of gas
  pricing can therefore come back as `out of gas` rather than a dependency move. The revert reason is reported
  verbatim so this is visible.
- Monad's `latest` is a Proposed block and can be abandoned; all bases used here are historical, so this
  affects the live gate, not Explain.

## Observed on real mainnet data (2026-10-07)

Two independent samples of recent failed mainnet transactions (distinct senders, scanned for `status 0x0`):

| Sample | n | same-block | knowable (N-3) | latency-sensitive | unavoidable | unknown |
|---|---|---|---|---|---|---|
| A (head ≈ 111,332,8xx) | 8 | 6 | 2 | 0 | 0 | 0 |
| B (head ≈ 111,334,1xx) | 10 | 8 | 0 | 2 (N-1, N-2) | 0 | 0 |

Sample B produced 128 attributed movements: **50 written by an earlier transaction inside block N** and **78
written in an earlier block**, so earlier-block writer attribution is real and reproducible, not a special
case. Both samples are small and recent; the 30-day headline numbers belong to the benchmark agent's index,
not here.
