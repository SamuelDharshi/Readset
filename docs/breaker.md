# Circuit breaker

> PRD "How it works", component 5. Policy fields `maxConsecutiveReverts`, `maxBurnPerHour` and
> per-(target, selector) limits. When it trips, sending halts, the operator is notified, and a reset
> is required. **Agent Wallet's own policies decide *what an agent may do*; Readset decides *whether
> this send is worth doing right now*.**

That distinction is the whole design. An Agent Wallet policy is about permission and is evaluated
against the request. The breaker is about outcome and is evaluated against history: has this wallet
been failing, and has it been burning gas doing it? On Monad a reverted transaction pays its whole
gas limit (`docs/facts.md` #1a, #10, mean 0.198 MON per real failure), so a looping agent at 3am is
a spend problem, not a permission problem.

Implementation: `packages/core/src/breaker/{policy,state,index}.ts`.

## Where it sits in the send path

```
agent send(tx)
  -> checkBreaker(ctx)      <- HERE, before anything costs an RPC round trip
       tripped? refuse, write a receipt with verdict 'refused_breaker', stop
  -> simulate at latest
  -> gate                   revert? 'refused_doomed' / funds? 'refused_funds'
  -> sign and send
  -> recordAttempt(...)     one receipt per attempt, allowed or blocked
  -> recordOutcome(...)     when it mines
  -> recordResult(receipt)  counters follow the outcome
```

`checkBreaker` reads only local files, so a tripped breaker halts the send without a single RPC call
(PRD: "A tripped breaker halts before any simulation"). Feed **every** receipt back through
`recordResult`, including blocked ones: a gate refusal for a reverting simulation is exactly the
signal a loop produces before it has spent anything.

## Policy

`<root>/policy.json`, validated by a zod schema, with the PRD's defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConsecutiveReverts` | `5` | consecutive failed sends from one wallet |
| `maxBurnPerHourWei` | `"1000000000000000000"` (1 MON) | wasted fees in the rolling window. 1 MON is about five real mainnet failures at the measured 0.198 MON mean (`docs/facts.md`) |
| `perTarget` | `[]` | `{ to, selector?, maxConsecutiveReverts?, maxBurnPerHourWei? }`, the same two limits scoped to one target |
| `gasBufferPct` | `20` | flat buffer over simulated gas. A placeholder: Category Labs' per-(to, selector) dynamic buffer is the better source and is credited, not improved on |
| `failClosed` | `true` | refuse when simulation infra errors rather than sending blind |

```ts
import { loadPolicy, savePolicy, parsePolicy, DEFAULT_POLICY, policyPath } from '@readset/core';

const policy = loadPolicy({ root: '.readset' });  // DEFAULT_POLICY when the file is absent
savePolicy(parsePolicy({ maxConsecutiveReverts: 3 }), { root: '.readset' });
```

Addresses and selectors are lowercased on parse; a malformed file throws rather than silently
falling back to defaults, because a policy that quietly reverts to 5 is worse than a crash. The
policy's `policyHash` goes into every receipt, so a verdict can always be tied to the rules in force.

A `perTarget` entry with a `selector` is measured against the exact `(to, selector)` counter; an
entry without one is measured against the `to:*` aggregate across selectors.

## Counters are derived from receipts

Counters are not an independent ledger. They are a fold over the receipt log
(`countersFromReceipts`), so state survives a restart, two processes cannot disagree about history,
and every number traces back to a JSONL line an operator can read.

Each receipt is classified by **outcome, not intention** (`classifyReceipt`):

| Receipt | Kind | Effect |
| --- | --- | --- |
| `outcome.status === 'reverted'` | `revert` | +1 consecutive, and its `feePaidWei` enters the burn window |
| `outcome.status === 'success'` | `success` | consecutive reset to 0 for the wallet and for this send's target keys |
| no outcome, `verdict === 'refused_doomed'` | `revert` | +1 consecutive, no burn (nothing was spent — that is the saving) |
| `refused_breaker`, `refused_funds`, `refused_policy`, `allowed` with no outcome yet | `neutral` | nothing |

`refused_breaker` being neutral is load-bearing: the breaker must not be able to feed itself.

A send counts toward two target keys, the exact `to:selector` and the `to:*` aggregate, so per-target
limits isolate targets while still being writable per address. Counter keys are `targetKey(to,
selector)`, with `create:*` for a deployment and `*` for "any selector".

`BreakerCounters` holds `consecutiveReverts`, `targetConsecutiveReverts`, `burnWei`,
`targetBurnWei`, the `burnEvents` that back those sums, the window bounds, `receiptsSeen` and the
last 256 receipt ids (so a replayed `recordResult` cannot double-count).

### Burn is wasted money, and it rolls off by timestamp

`burnWei` is the sum of `feePaidWei` over **reverted** outcomes whose receipt `createdAt` falls inside
the window (default one hour). `pruneWindow` recomputes the sums from `burnEvents` on every read and
write, so the window rolls off purely by timestamp — there is no decay, no cron and nothing to tick.
Successful sends do not count: the breaker measures waste, not spend. Spend limits are Agent
Wallet's job.

The event is timestamped with the attempt's `createdAt` rather than the outcome amendment's, because
on 300 ms blocks the outcome follows within a block or two and the attempt time is what an operator
correlates against.

## Trip state

`<root>/breaker/<chainId>.json`, written by write-then-rename so a reader never sees half a file:

```json
{
  "version": 1,
  "chainId": 10143,
  "updatedAt": "2026-10-07T12:30:00.000Z",
  "wallets": {
    "0x…a11ce": {
      "version": 1, "chainId": 10143, "wallet": "0x…a11ce",
      "tripped": true,
      "reason": "5 consecutive failed sends from 0x…a11ce (limit 5)",
      "trippedAt": "2026-10-07T12:29:58.004Z",
      "targets": { "0x7a3f…c21e:0x38ed1739": { "tripped": true, "reason": "…", "trippedAt": "…" } },
      "counters": { "…": "…" },
      "resets": 0
    }
  }
}
```

The trip flag is the one piece of state that is **not** derived. Rebuilding counters from the log
preserves it; a restart preserves it; the window rolling off does not clear it. Only
`reset()` clears it, and every reset is counted in `resets` with a `resetAt`. A wallet trip halts
every send from that wallet; a target trip halts only sends to that `(to, selector)`.

`reset(wallet)` zeroes the consecutive-revert counters so history cannot immediately re-trip, but it
does **not** forgive the burn window by default: that money was really spent, and it rolls off by
time. Pass `{ clearBurnWindow: true }` to forgive it explicitly, or `{ target }` to clear one target.

`onTrip` fires once per transition into a tripped state — not once per blocked send — and carries
`{ chainId, wallet, scope, target?, reason, at, counters }` for the operator notification the PRD's
demo shows at 1:50.

## API

```ts
import { Breaker, checkBreaker, recordResult, resetBreaker } from '@readset/core';

// before simulating
const { allow, reason, target } = checkBreaker(
  { chainId: 10143, wallet, to, data },
  { root: '.readset' },
);
if (!allow) { /* write a receipt with verdict 'refused_breaker' and stop */ }

// after every attempt, allowed or blocked
recordResult(receipt, { root: '.readset' });
```

- `checkBreaker(ctx, opts) : { allow, reason?, target? }` — local files only; call before simulation. `ctx` is `{ chainId, wallet, to?, data?, selector? }`; `data` is read only for its 4-byte selector.
- `recordResult(receipt, opts) : TripState` — folds the receipt into the counters and trips whatever it broke. Idempotent per receipt id.
- `resetBreaker(wallet, { chainId, root?, target?, clearBurnWindow? })` — the only way a trip clears.
- `new Breaker({ chainId, root?, policy?, receipts?, windowMs?, now?, onTrip? })` — the same four as methods, plus `state(wallet)`, `counters(wallet)`, `rebuild(wallet)` and `violations(counters)`. Prefer this for a long-running agent: it holds one `ReceiptStore` with its file cache.
- Pure helpers for anyone building on top: `classifyReceipt`, `countersFromReceipts`, `applyReceipt`, `pruneWindow`, `evaluateCounters`, `blockingTrip`, `targetKey`, `targetKeysFor`, `selectorOf`, `matchingTargets`.

## Honest limits

- Counters are per `(chainId, wallet)`. An agent spreading failures across several wallets is not caught by the consecutive-revert limit; give each wallet its own policy budget.
- `recordResult` is an incremental fold. If another process wrote receipts that this one never ingested, call `rebuild(wallet)` — the receipt log is always the authority.
- Burn needs an outcome. A tx that is broadcast and never amended with its receipt contributes nothing to the window, so an agent that never calls `recordOutcome` gets consecutive-revert protection but no burn protection.
- The breaker cannot see same-block races, because nothing can: Monad has no pending-transaction feed (`docs/facts.md` #7). It sees the failures afterwards and stops the next one.
- The trip file is per chain and is not locked. Two processes tripping the same wallet at the same instant may each write; the result is still tripped, but the recorded `reason` is whichever landed last.
