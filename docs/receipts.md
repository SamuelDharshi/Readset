# Dependency receipts

> PRD "How it works", component 2. Every send attempt, allowed or blocked, writes one JSON record:
> dependency set, simulated values, block, policy hash and verdict. If the send later reverts,
> diffing the receipt against chain state gives the exact cause.

A receipt is the audit trail half of Readset. The gate stops a doomed send; the receipt is what lets
an operator say, afterwards, what the agent decided at 3am and why. The record is content-addressed,
so an altered log is detectable, and the log is append-only, so nothing can be quietly rewritten.

Implementation: `packages/core/src/receipt/{hash,store,write,index}.ts`. Type: `Receipt` in
`packages/core/src/types.ts` (owned by the integration lead; receipts never add fields to it).

## What is never stored

Private keys, mnemonics and raw signed payloads. `assertNoSecrets` walks every object before it is
hashed or written and throws on a key matching `privateKey`, `secret`, `mnemonic`, `signedTx`,
`rawTransaction`, `signature` and friends (`FORBIDDEN_KEYS`). A receipt holds the *request*
(`from`, `to`, `data`, `value`, chosen gas limit), never the signature or the serialised tx.

## The id: canonical JSON + sha256

`receiptId(receipt)` is the lowercase hex sha256 of `canonicalJson(receiptCore(receipt))`. The
canonical form is frozen, because changing it changes every id ever issued:

| Rule | Why |
| --- | --- |
| Object keys sorted by code point, recursively | key order is not content |
| Keys with an `undefined` value dropped | an absent field and an explicit `undefined` are the same fact |
| `bigint` -> decimal string | wei and block numbers do not fit a double, and `1n` must hash like `"1"` |
| Numbers must be finite | `NaN`/`Infinity` have no JSON form |
| `Date` -> ISO string, `Uint8Array` -> `0x` hex | no implementation detail leaks into the hash |
| No whitespace | the canonical form is byte-stable |

`receiptCore` keeps exactly `RECEIPT_ID_FIELDS`:

```
version, createdAt, chainId, tx, verdict, doomed, dependencySet, policyHash
```

`txHash` and `outcome` are deliberately **outside** the id. The id commits to the decision, not to
what the chain later did with it; that is what makes an amendment possible without re-issuing the
receipt. Determinism is exact: the same content in a different process, with differently ordered
input objects or with `bigint` instead of decimal strings, yields the same 64-hex id.

`policyHash(policy)` is the same construction over the whole `Policy`, so a verdict can always be
tied to the rules that were in force.

`verifyReceipt(r)` recomputes the id and returns `{ ok, id, expected, reason }`; `ok: false` means
the record was altered. `assertReceiptIntact` throws instead, and `ReceiptStore.put` calls it, so a
receipt that does not hash to its own id cannot enter the log.

## Store layout

```
<root>/receipts/<chainId>/<YYYY-MM-DD>.jsonl
```

`<root>` is `READSET_HOME`, else `<cwd>/.readset`. The day comes from the UTC date of the record's
own `createdAt`, so files are time-ordered and `list({ since })` skips whole files.

One line, one record, JSON, no trailing commas, no array wrapper. Two kinds of line share a file:

- a **receipt** line is the `Receipt` object verbatim, with no extra keys, so the line itself
  re-hashes to its own id;
- an **amendment** line carries a `kind` field. That is the only discriminator: `isAmendment(r)`.

### Amendment format

History is never rewritten. When a sent tx mines, or when a tx hash becomes known after the attempt
was written, a new line is appended:

```json
{
  "version": 1,
  "kind": "amendment",
  "id": "9f2c…",
  "receiptId": "4ab1…",
  "createdAt": "2026-10-07T12:00:02.311Z",
  "chainId": 10143,
  "patch": {
    "outcome": {
      "status": "reverted",
      "gasUsed": "1800000",
      "feePaidWei": "198000000000000000",
      "blockNumber": "111218900"
    }
  },
  "note": "optional, e.g. 'from eth_getTransactionReceipt'"
}
```

| Field | Meaning |
| --- | --- |
| `kind` | always `"amendment"`; its presence is what marks the line |
| `id` | sha256 of the canonical amendment content (everything but `id`), so amendments are self-verifying too — `verifyAmendment(a)` |
| `receiptId` | the `Receipt.id` being amended; unchanged by the amendment |
| `createdAt` | when the amendment was written, not when the attempt was made |
| `patch` | `{ txHash? , outcome? }` only. Nothing else is amendable. |

Reads replay amendments over the receipt, oldest first, last writer wins; ties on `createdAt` break
by `id`, so the merge is deterministic. `applyAmendments` is pure. The original line stays exactly as
written: `store.rawReceipt(id)` returns it without the patch, `store.get(id)` returns the merged
view, and `store.amendmentsFor(id)` returns the chain of patches. A merged receipt still verifies,
because its id never covered the amended fields.

Repeated amendments for the same field are allowed and are the audit trail: each one is a new line,
and the newest wins on read.

### Concurrency

Every record is one `write(2)` on a handle opened with `O_APPEND` (`openSync(file, 'a')`,
`writeSync`, `closeSync`). Two processes appending to the same day file interleave by line and never
tear a record. A short write throws rather than leaving a partial line, and a record whose UTF-8
encoding exceeds `MAX_RECORD_BYTES` (1 MiB) is refused rather than written in pieces. There are no
locks, so there is nothing to leak if a writer is killed.

A reader tolerates a torn tail from a `SIGKILL`ed writer: unparsable lines are skipped and counted in
`store.stats().malformed`. They are never repaired, because repairing an append-only log is the thing
this file format exists to prevent. Reads are cached per file by `(size, mtimeMs)`, so a breaker
rebuilding counters does not re-parse unchanged days.

`packages/core/test/receipt.test.ts` asserts this with two real child processes writing 60 receipts
each into one day file: all 120 lines land, parse and verify.

## API

```ts
import {
  recordAttempt, recordOutcome, recordSent, buildReceipt,
  ReceiptStore, verifyReceipt, receiptId, policyHash, canonicalJson, monadFeePaidWei,
} from '@readset/core';   // or '../receipt/index.js' inside core

// one record per attempt, allowed or blocked
const r = recordAttempt({
  chainId: 10143,
  tx: { from, to, data, value: 0n, gasLimitChosen: 1_800_000n },
  verdict: 'refused_doomed',
  doomed: { reason: 'simulation reverted', revertReason: 'SLIPPAGE' },
  dependencySet,
  policy,
}, { root: '.readset' });

// later, when it mines
recordOutcome(r, {
  status: 'reverted',
  gasUsed: receipt.gasUsed,
  feePaidWei: monadFeePaidWei(tx.gas, receipt.effectiveGasPrice),  // Monad charges the LIMIT
  blockNumber: receipt.blockNumber,
});
```

- `buildReceipt(input)` — pure; the receipt an attempt would produce, including its id. Writes nothing.
- `recordAttempt(input, opts)` — `buildReceipt` + `put`. Returns the `Receipt`.
- `recordOutcome(idOrReceipt, outcome, opts)` / `recordSent(idOrReceipt, txHash, opts)` — append an amendment, return the merged receipt.
- `monadFeePaidWei(gasLimit, effectiveGasPrice)` — `gasLimit * price`, because Monad charges the limit, not gas used (`docs/facts.md` #1a, #10). Use it to fill `feePaidWei`; gas *used* from a Monad receipt always equals the limit and is not what you want here.
- `ReceiptStore` — `put`, `get`, `rawReceipt`, `amendmentsFor`, `byTxHash`, `list({ since, until, limit, verdict, from, chainId })`, `attachOutcome`, `attachTxHash`, `amend`, `records`, `files`, `chains`, `stats`, `verifyAll`.

`list` returns merged receipts oldest first; `limit` keeps the most recent N, still chronological.
`verifyAll` re-hashes every receipt and amendment in the log and returns the bad ones — the one
command an operator runs to ask whether the audit trail has been edited.

## Honest limits

- `createdAt` is local wall clock. A machine whose clock jumps writes into a different day file; records stay valid and ordering within a file is still append order.
- The id covers the dependency set as simulated, not the chain. A receipt proves what the gate saw, not that the chain agreed.
- `get(id)` scans day files (cached). This is an operator-scale store, not a database; a long-running agent should retain by day and archive old files.
- Nothing in the store is encrypted. It holds no secrets, but it does hold an agent's full trading history, so treat `<root>` as sensitive.
