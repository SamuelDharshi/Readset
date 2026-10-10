# Readset

**On Monad, a failed transaction pays its full gas limit. Readset checks before your agent signs.**

Readset is a spend firewall and audit trail for autonomous wallets on Monad. Before an AI agent or
bot signs anything, Readset simulates it against live chain state, records every storage slot the
transaction depended on, and decides. After a failure, it names the slot that moved and the
transaction that moved it. If the agent starts looping, a circuit breaker stops it.

Every number in this README was measured against real Monad mainnet. Nothing is modelled, mocked
or estimated, and the things that did not work are reported next to the things that did.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [The problem, measured](#the-problem-measured)
- [How it works](#how-it-works)
- [The three pillars](#the-three-pillars)
- [Sequence: a guarded send](#sequence-a-guarded-send)
- [Sequence: explaining a failure](#sequence-explaining-a-failure)
- [What does not work](#what-does-not-work)
- [Quickstart](#quickstart)
- [Using Readset](#using-readset)
- [The website](#the-website)
- [Reproducing the measurements](#reproducing-the-measurements)
- [Architecture](#architecture)
- [Environment](#environment)
- [Kill tests](#kill-tests)
- [Lineage](#lineage)
- [Prior art and credits](#prior-art-and-credits)

---

## Why this exists

An agent holds 10 MON and runs unattended. It reads a market, decides to act, and prepares a
transaction. Between preparing and executing, somebody else moves the state it depended on.

```
    AGENT READS                     SOMEONE ELSE WRITES              AGENT SENDS ANYWAY
   ┌──────────────┐                 ┌──────────────┐                ┌──────────────┐
   │ healthFactor │                 │ healthFactor │                │   the plan   │
   │    = 1.20    │  ─────────────► │    = 0.95    │ ─────────────► │  is already  │
   │   looks ok   │    block N-1    │  liquidated  │    block N     │    stale     │
   └──────────────┘                 └──────────────┘                └──────┬───────┘
                                                                           │
                                                                           ▼
                                                                    ✕  REVERTED
                                                               full gas limit charged
```

On most chains that costs you the gas you used. **On Monad it costs the whole limit you asked
for**, whether the transaction accomplished anything or not. A human notices and stops. An agent
retries, and retries, and retries.

---

## The problem, measured

We took a census, not a sample: **every one of 8,568,000 blocks** in a 30-day window
(blocks 102,660,000–111,227,999).

| | |
|---|---|
| Failed transactions | **6,257,528** (3.73% of 167.6M user txs) |
| Burned on failure | **1,161,443 MON** (38,715 per day) |
| Failed txs where `gasUsed != gasLimit` | **0 of 6,257,528** |
| Share of burn from the top 50 senders | **69.7%** |
| Burn inside loops (≥10 consecutive failures) | 73,556 MON — a breaker of 5 stops **53,592** |
| Gas bought by failed txs that was never needed | **47.8%** (600 traced failures) |

That third row is the premise, measured rather than assumed: on **every single failure**, the fee
charged equalled the full gas limit.

The last row was the surprise. A third of failed transactions carry a limit at least twice their
real need, and those carry **63.2% of all burn**. Padded limits, not just bad luck, are where the
money goes.

Method and caveats: [`docs/kill-tests/K2.md`](docs/kill-tests/K2.md).

---

## How it works

Five checks, in order, before anything is signed. The breaker runs **first**, so a halted agent
does not even spend an RPC round trip.

```
                               AI AGENT
                                  │
                                  │  "send this transaction"
                                  ▼
             ┌────────────────────────────────────────────┐
             │                 READSET                    │
             └────────────────────────────────────────────┘
                                  │
          ┌───────────────────────┴───────────────────────┐
          │                                               │
          ▼                                               │
   ① BREAKER                                              │
   has this agent been                                    │
   burning money?                                         │
          │                                               │
    tripped?  ──── yes ──────────────────────────────────►│──►  ✕ HALT
          │                                               │     (no RPC spent)
          no                                              │
          ▼                                               │
   ② SIMULATE                                             │
   eth_call at latest                                     │
          │                                               │
          ▼                                               │
   ③ READ SET                                             │
   debug_traceCall + prestateTracer                       │
   → which slots did it depend on?                        │
          │                                               │
          ▼                                               │
   ④ FUNDS                                                │
   can it cover gas_limit × price + value?                │
   (and Monad's reserve balance)                          │
          │                                               │
    cannot? ──── yes ─────────────────────────────────────►│──►  ✕ REFUSE
          │                                               │     refused_funds
          no                                              │
          ▼                                               │
   ⑤ RECEIPT                                              │
   write the decision down — allowed or not               │
          │                                               │
          ▼                                               │
      ✓ SIGN, with a gas limit chosen from simulated gas
```

### What a dependency set looks like

A transaction's **read set** is every piece of state it relied on to reach its result.

```
  tx 0x3409dd8d…
        │
        ├── 0xc8689a47… slot 0xd4cee0ab…   value 0x…b6c1     ← read
        ├── 0xc8689a47… slot 0x000000c9…   value 0x…79a4     ← read
        ├── 0x37db7fbf… slot 0x00000000…   value 0x…4db4     ← read
        ├── sender nonce                                     ← read
        └── sender balance                                   ← read

  Readset records all of it. When the transaction later fails, each of these is
  checked against what the chain actually did, and the ones that MOVED are the
  answer to "why did my bot lose?"
```

---

## The three pillars

```
                            READSET
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
      GUARD                 BREAKER               RECEIPT
   before the send     during operation      after the failure
         │                     │                     │
   "is this already      "has this agent        "what exactly
    doomed right          started burning        changed, who
    now?"                 money?"                changed it?"
         │                     │                     │
   simulate + read set   count outcomes,        tamper-evident
   + funds + reserve     halt at a threshold    append-only log
         │                     │                     │
         └─────────────────────┴─────────────────────┘
                               │
                   one engine, three surfaces
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
   MetaMask plugin        MCP server           viem wrapper
   mm readset …        readset_send …     createGuardedWalletClient
```

Every surface calls the same `gate()`, writes the same receipts and obeys the same policy, so a
decision never depends on which door it came through. The bridge **fails loudly** if a core export
goes missing rather than silently falling back — a guard must never quietly run on different logic
than the one that was audited.

---

## Sequence: a guarded send

```
  Agent          Readset          Breaker        Monad RPC        Receipt log
    │               │                │               │                 │
    │  send(tx)     │                │               │                 │
    ├──────────────►│                │               │                 │
    │               │  check()       │               │                 │
    │               ├───────────────►│               │                 │
    │               │  allow / halt  │               │                 │
    │               │◄───────────────┤               │                 │
    │               │                │               │                 │
    │               │        (halted) │               │                 │
    │  ✕ HALT       │                │               │                 │
    │◄──────────────┤   ─────────────────────────────────────────────► │ write
    │               │                │               │                 │
    │               │  eth_call at latest            │                 │
    │               ├───────────────────────────────►│                 │
    │               │  revert / ok                   │                 │
    │               │◄───────────────────────────────┤                 │
    │               │                │               │                 │
    │               │  debug_traceCall (prestateTracer, non-diff)      │
    │               ├───────────────────────────────►│                 │
    │               │  slots the call read           │                 │
    │               │◄───────────────────────────────┤                 │
    │               │                │               │                 │
    │               │  balance + nonce, reserve check │                 │
    │               ├───────────────────────────────►│                 │
    │               │◄───────────────────────────────┤                 │
    │               │                │               │                 │
    │               │  record decision + dependency set                │
    │               ├────────────────────────────────────────────────► │ write
    │               │                │               │                 │
    │  verdict      │                │               │                 │
    │◄──────────────┤                │               │                 │
    │               │                │               │                 │
    │  (if allowed) sign + broadcast with chosen gas limit             │
    ├───────────────────────────────────────────────►│                 │
    │               │                │               │                 │
    │               │  watch receipt, attach outcome │                 │
    │               ├────────────────────────────────────────────────► │ amend
    │               │                │               │                 │
    │               │  feed outcome back to breaker  │                 │
    │               ├───────────────►│               │                 │
```

The outcome is attached as a **separate amendment line**, never by rewriting the original receipt.
The receipt's id commits to the decision, not to what happened afterwards.

---

## Sequence: explaining a failure

Paste any failed Monad mainnet hash into `/tx/<hash>` and this runs:

```
  You            Readset              Archive RPC
   │                │                      │
   │  hash          │                      │
   ├───────────────►│                      │
   │                │  tx + receipt        │
   │                ├─────────────────────►│
   │                │◄─────────────────────┤   status 0? burned = limit × price
   │                │                      │
   │   (if it SUCCEEDED → say so and stop; nothing to explain)
   │                │                      │
   │                │  trace the tx (prestateTracer)
   │                ├─────────────────────►│   what it depended on
   │                │◄─────────────────────┤
   │                │                      │
   │                │  re-simulate at N-1  │
   │                ├─────────────────────►│
   │                │  re-simulate at N-2  │
   │                ├─────────────────────►│
   │                │  re-simulate at N-3  │
   │                ├─────────────────────►│
   │                │◄─────────────────────┤   reverted at each? → verdict
   │                │                      │
   │                │  traceBlockByNumber (diffMode) over the blocks between
   │                ├─────────────────────►│
   │                │◄─────────────────────┤   who wrote each moved slot
   │                │                      │
   │                │  CONFIRM each writer against its own trace
   │                ├─────────────────────►│
   │                │◄─────────────────────┤   unconfirmed → unattributed
   │                │                      │
   │  verdict + moved slots + writers      │
   │◄───────────────┤                      │
```

### The verdicts

```
   reverts at N-3 ────────────────────►  KNOWABLE
                                         a gate would have caught it long before

   reverts only at N-1 ───────────────►  LATENCY-SENSITIVE
                                         only detectable moments before sending

   succeeds at N-1, failed at N ──────►  SAME-BLOCK RACE
                                         broken from inside its own block.
                                         No client-side guard can see this.

   refused for funds / reserve ───────►  EXCLUDED-FUNDS
                                         not a race; excluded from "avoidable"
```

---

## What does not work

Stated before the flattering numbers, because the measurements forced two of these.

**A gate that refuses on any revert wrongly refuses 8.53% of sends that actually succeed.**
Measured on 1,207 real successful mainnet transactions. Requiring the revert to reproduce three
blocks back halves it to 4.31% (4.3–7.5% once unmeasurable cases are bounded) at almost no cost in
detection — but that still misses the 1% bar we set.

Those are not oracle bugs. Such a transaction's precondition is written by an earlier transaction
*in its own block*, which no client-side guard can see without a pending feed — and Monad does not
expose one. So **`refuseOnRevert` defaults to `warn`**: record it, feed the breaker, let the send
through. Hard refusal is opt-in, per target. A guard that silently blocked one good send in twelve
would be worse than no guard.

What survives unconditionally is the half that predicts nothing: **every attempt leaves a receipt**
and **the breaker stops the loop**. That 53,592 MON needs only counting.

| Limit | Detail |
|---|---|
| Same-block races are invisible | 47.4% of burn in the replay sample. No pending feed exists on Monad. |
| `latest` is a Proposed block | It can be abandoned. Measured: 0 of 1,724 in 10.7 min, 95% upper bound 0.22%. |
| Time dependence is a heuristic | Monad has no struct logs and rejects block overrides, so we flag `TIMESTAMP`/`NUMBER` in bytecode and cannot confirm by re-simulation without a local fork. |
| The MetaMask plugin cannot intercept | Agent Wallet rejects plugins declaring hooks. `mm readset safe-submit` is cooperative, not enforced. |
| Re-execution is unobservable | Monad's conflict/retry counts are node-local; no RPC exposes them. |
| No malicious-contract detection | That is Blockaid's job, not ours. |

Claims removed for lack of proof, including the widely quoted "$112k airdrop farmer" (the address
was never published and the source cites a Solana explorer): [`docs/facts.md`](docs/facts.md).

---

## Quickstart

```sh
git clone https://github.com/SamuelDharshi/Readset.git
cd Readset
npm install
cp .env.example .env     # every var is optional; public endpoints work with no key

npm run dev              # the site on http://localhost:3000
```

Then open <http://localhost:3000> and paste a failed Monad mainnet hash, or click one of the three
real examples on the Forensics page.

```sh
npm run build                       # production build
npx vitest run                      # 194 tests against live Monad RPC
READSET_OFFLINE=1 npx vitest run    # 147 of them from recorded fixtures, no network
npx tsc --noEmit -p tsconfig.json   # typecheck
```

> **Windows note.** vitest 5 runs on rolldown and npm does not always pull the platform binding.
> If the suite will not start: `npm i --no-save @rolldown/binding-win32-x64-msvc`.

---

## Using Readset

### 1. viem wrapper — drop-in guarded client

```ts
import { createGuardedWalletClient } from '@readset/viem';

const readset = createGuardedWalletClient({ walletClient, publicClient, policy });

try {
  await readset.sendTransaction({ to, data, value });
} catch (e) {
  if (isDoomedTxError(e)) {
    console.log(e.reason);      // why it was refused
    console.log(e.receiptId);   // the audit record of that decision
  }
}
```

Keeps viem's API shape. The one behavioural difference: **it can refuse.**

### 2. MCP server — for an agent that speaks MCP

```jsonc
{
  "mcpServers": {
    "readset": {
      "command": "node",
      "args": ["packages/mcp/bin/readset-mcp.mjs"],
      "env": { "READSET_NETWORK": "testnet" }
    }
  }
}
```

| Tool | What it does |
|---|---|
| `readset_send` | Gate a transaction, optionally sign and send it |
| `readset_status` | Breaker state, recent receipts, rolling burn |
| `readset_policy` | Get or set the policy |

A refusal comes back as **data** (`ok: false` with a reason), not as a tool error, so an agent can
act on it.

### 3. MetaMask Agent Wallet plugin

```sh
mm config set experimentalPlugins true     # plugins are beta
mm plugins link ./packages/plugin

mm readset gate --from 0x… --to 0x… --data 0x…   # dry run, no auth needed
mm readset safe-submit --to 0x… --data 0x…       # gate, then submit
mm readset status                                 # breaker + recent decisions
```

> **Honest status.** `mm readset gate` has run on Monad testnet and refuses correctly.
> `safe-submit` compiles and is wired but has **never been executed end to end**: it needs Node
> ≥22.18 and `mm login` with a real MetaMask account. Agent Wallet also has no interception hook,
> so an agent that calls `mm transfer` directly is unguarded. See
> [`docs/kill-tests/K3.md`](docs/kill-tests/K3.md).

### 4. Policy

```jsonc
{
  "maxConsecutiveReverts": 5,          // halt after N failures in a row
  "maxBurnPerHourWei": "1000000000000000000",
  "refuseOnRevert": "warn",            // "warn" | "stable" | "any"
  "stableRevertLookback": 3,           // blocks back that "stable" re-checks
  "gasBufferPct": 20,
  "failClosed": true,                  // refuse rather than send blind on infra failure
  "perTarget": []                      // tighter limits for one (contract, selector)
}
```

Lives at `.readset/policy.json`, editable from the Policy page or `readset_policy`.

---

## The website

```
  /                 landing — the claim, the measurement, the mechanism, the limits
  /tx/<hash>        forensics on any failed mainnet transaction (shareable URL)
  /why              the same tool without a hash; ?hash=X redirects to /tx/X
  /playground       run the gate live; watch a looping bot hit the breaker
  /benchmark        census, replay results, the four kill tests, deleted claims
  /receipts         the audit trail, with integrity re-verified on read
  /policy           breaker thresholds and refusal mode
  /docs             the repo's own markdown, rendered
```

| API | Purpose |
|---|---|
| `GET /api/tx/[hash]` | Full analysis of a failed transaction |
| `POST /api/simulate` | Gate a call (never signs) |
| `POST /api/breaker` | Evaluate the breaker against supplied counters |
| `GET /api/benchmark` | The measurement output |
| `GET /api/receipts` | Recent receipts + integrity check |
| `GET /api/policy` | Get or set the policy |

---

## Reproducing the measurements

Every figure on the site is read from `results/`. Each command below regenerates one.

```sh
npx tsx scripts/k2-sample.ts --full        # 30-day census (43s cached, ~43min cold)
npx tsx scripts/replay-benchmark.ts --blocks 1700 --seed 20261007
npx tsx scripts/stable-revert-check.ts     # the false-block rule comparison
npx tsx scripts/run-abandonment.ts --network mainnet --hours 24
npx tsx scripts/k1-probe.ts                # per-endpoint history + tracing support
```

All resumable and checkpointed; each output records its block range and a `generatedAt`. If a
results file is missing, the site shows "—" and prints the command instead of inventing a number.

---

## Architecture

```
readset/
├── packages/
│   ├── core/          the engine — everything decides through here
│   │   ├── gate/        simulate → dependency set → funds → gas limit
│   │   ├── explain/     burn, replay at N-k, classify, writer attribution
│   │   ├── breaker/     policy, durable trip state, evaluation
│   │   ├── receipt/     tamper-evident append-only store + amendments
│   │   ├── chain/       Monad chains, clients, capability probes
│   │   └── label/       storage-layout slot labelling via solc
│   ├── viem/          guarded WalletClient
│   ├── mcp/           MCP server (stdio)
│   ├── plugin/        MetaMask Agent Wallet commands
│   └── bench/         census, replay benchmark, abandonment logger
├── apps/web/          the site (Next.js, Tailwind, React Three Fiber)
├── scripts/           re-runnable measurement scripts
├── results/           committed measurement output — the site reads this
└── docs/              rendered at /docs
```

---

## Environment

`READSET_RPC_URL` is primary; `MONAD_RPC_URL` / `MONAD_TESTNET_RPC_URL` are accepted as fallbacks
so an existing Monad setup needs no renaming. Full list in [`.env.example`](.env.example).

Forensics needs **archive** state plus `debug_*`. Measured per-endpoint windows are in
[`docs/kill-tests/K1.md`](docs/kill-tests/K1.md):

| Endpoint | Archive | Tracing |
|---|---|---|
| `rpc-mainnet.monadinfra.com` | full | yes — the default |
| `rpc2.monad.xyz` (Goldsky) | full, but has answered "not found" for blocks monadinfra serves | yes |
| `rpc.monad.xyz` | ~7 days | yes |
| `rpc1.monad.xyz` (Alchemy) | archive for `eth_call` only | **no `debug_*`** |
| `rpc3.monad.xyz` (Ankr) | ~0.44M blocks | **no `debug_*`** |

Set `READSET_ARCHIVE_RPC` to pin your own. Without it Readset tries the public archive endpoints in
order and fails over between them.

---

## Kill tests

The build was gated on four checks, with instructions to publish the negative result if they did
not hold. Two came back PARTIAL.

| | Question | Verdict |
|---|---|---|
| [K1](docs/kill-tests/K1.md) | Historical `debug_traceCall`; do read-only slots appear? | **PASS** — two free archive endpoints; read-only slots only in non-diff mode; block overrides unsupported |
| [K2](docs/kill-tests/K2.md) | Is the avoidable loss real and large? | **PARTIAL** — burn and loops confirmed; 36% of burn knowable; false-block rate failed its target |
| [K3](docs/kill-tests/K3.md) | Can an Agent Wallet plugin gate a send? | **PARTIAL** — no interception; `safe-submit` built but unproven |
| [K4](docs/kill-tests/K4.md) | Are `monadNewHeads`/`monadLogs` reachable keyless? | **PASS** — yes on the public endpoints |

---

## Lineage

Readset began as **Hotslot**, a profiler for storage contention under Monad's parallel execution.
Fact-checking killed its premise:

```
   Hotslot
      │   "one shared slot serialises your contract"
      ▼
   ✕ FALSE — Monad re-executes only when the VALUES read have changed.
             OpenZeppelin's guard goes 1 → 2 → 1, so it nets to no change.
             Re-execution is not observable over RPC either, and mainnet runs
             at ~12% of its gas limit, so contention has no victim today.
      │
      │   follow the gas instead
      ▼
   ✓ MEASURABLE — a reverted transaction pays its FULL gas limit, and that is
                  documented, large, and concentrated in bots.
      │
      ▼
   Readset — the read-set engine survives as the dependency set.
```

The evidence that killed it:
[`docs/lineage/monad-execution-verification.md`](docs/lineage/monad-execution-verification.md).

---

## Prior art and credits

| Project | What it does | How Readset differs |
|---|---|---|
| [Category Labs gas-limit research](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad) | Measured failure and unused-gas rates; dynamic per-(to, selector) buffer | We use and credit it. We do not claim to beat it. |
| viem / ethers `estimateGas` | Throws on revert | Skipped when gas is hardcoded; gives no reason, receipt or policy |
| evm-fork-cache, reth ExecutionCache | Simulation caching with log invalidation | The (unbuilt) fast path borrows the idea |
| MetaMask Agent Wallet | Permission rules for agent actions | Complementary: they gate *what*, we gate *whether now* |
| Blockaid | Malicious-transaction alerts | Targets attacks, not failures |
| Tenderly, Blocknative | Hosted simulation | No slot-level causation, no agent policy |

Monad documentation throughout. None of these projects endorse Readset.

## Licence

MIT.
