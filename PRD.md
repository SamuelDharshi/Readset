# Readset — PRD (evolved from Hotslot)

Oct 7, 2026 · @Samuel Dharshi

## Summary

**Build Readset instead of Hotslot.** Readset is an open-source transaction guard for AI agents and bots on Monad. It refuses to sign a transaction whose inputs have already moved against it, names the storage slot and the transaction that moved them, logs a dependency receipt for every send, and trips a circuit breaker before a broken loop drains the treasury.

- **Tagline:** On Monad, failed transactions pay full price. Readset checks before your agent signs.
- **Track:** 04 Trust, Identity & AI Infrastructure, framed as a spend firewall and audit trail for agent wallets.
- **Bounty:** MetaMask "Best Agent Wallet Plugin" ($2.5k), if a plugin path exists. No other bounties.
- **Delivery:** a MetaMask Agent Wallet plugin, with the same core as a viem wrapper and an MCP server.

**Why it beats Hotslot.** Hotslot's headline claims did not survive fact-checking. Monad re-executes only when the *values* a transaction read have changed, so the ReentrancyGuard finding is probably false and the "1.18x" rounds model describes a scheduler Monad doesn't have. Readset keeps Hotslot's read/write-set engine and points it at a cost Monad documents: reverts pay the full gas limit.

|  | Hotslot | Readset |
| --- | --- | --- |
| Uniqueness | 4 | 4 |
| Honesty of core claim | 2 | 5 |
| Demoability | 3 | 4 |
| Track fit | 2 | 4 |
| Bounty fit | 1 | 4 |

Scores out of 5, from the feature agent's final review. The critic's final call: **go on Readset**. Realistic outcome is a Track 04 placement plus the MetaMask bounty; Grand Champion odds stay low.

## Lineage

This is the story to tell judges: we started profiling contention, the data said that wasn't the pain, and we followed the gas.

1. We started as **Hotslot**, which extracts per-transaction storage read/write sets to find contention in Monad's optimistic parallel execution.
2. The data said contention isn't the pain today. Blocks use a small fraction of capacity, re-execution is value-based and served from cache, and results are identical to serial execution.
3. Following the gas, we found the pain: on Monad **a reverted transaction pays its full gas limit**, and about 6% of transactions fail.
4. Readset reuses Hotslot's read-set engine to tell an agent, before it signs, that state it depends on has moved, and who moved it. Hotslot survives as a small "most-changed dependency slots" table on the benchmark page.

## The problem

Every failed transaction on Monad pays its whole gas limit, and nothing tells an unattended agent why it failed or makes it stop.

### Cited facts

| Fact | Source |
| --- | --- |
| Monad charges `gas_limit × price`, not gas used. A reverted transaction pays the full limit. The same page notes that some wallets like MetaMask set a very high limit when estimation reverts. | [Monad docs: gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing) |
| Receipts report `gasUsed == gasLimit` at the top call level, so a receipt shows what was paid. | [Category Labs blog](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad) |
| In 8.15M transactions sampled 12–18 Jan 2026, 6.0% failed and 0.58% ran out of gas, so about 5.4% were logic reverts (races, slippage, liquidations already taken). | Category Labs, same post |
| An airdrop farmer reportedly burned about $112k on scripted failing transactions. Verify the address on an explorer before using this on stage. | [Cointelegraph](https://cointelegraph.com/news/monad-airdrop-farmer-spends-112k-failed-trades) |
| Monad recommends a hardcoded gas value instead of `eth_estimateGas` when gas usage is static. | [Monad docs: best practices](https://docs.monad.xyz/developer-essentials/best-practices) |
| About 44 TPS and about 7% gas-limit utilisation. This figure counts gas limits, not gas burned. | [SQD, Aug 2026, 20k-block sample](https://sqd.dev/learn/monad-onchain-data/) |
| No pending-transaction feed (`newPendingTransactions` is unsupported). | [Monad docs: websockets](https://docs.monad.xyz/reference/websockets) |

**Our inferences, not facts:**

- Hardcoded gas skips `eth_estimateGas`, which is viem's default revert check. Static-gas transactions are rarely the racing ones, so the data must show where the burn really is.
- We found no Flashbots-Protect-style no-revert relay on Monad.
- Per-transaction loss is small: about 0.03 MON for a 300k-gas call at the minimum base fee. The real risk is loops and unattended agents.

### What we will measure (D0–D2, published whatever it shows)

- **Revert burn:** the sum of `gasLimit × effectiveGasPrice` over failed transactions in 30 days, and the share from the top 50 senders.
- **Avoidable share:** replay 2,000+ failed transactions at N−1, N−2 and N−3 and sort them into knowable (reverts at N−3), latency-sensitive (reverts only at N−1) and unavoidable (same-block race). Reserve-balance reverts are excluded from "avoidable".
- **Loop burn:** MON burned in runs of 10+ consecutive failures by one sender.
- **Hardcoded-gas proxy:** failed transactions whose limit is at least 2× the re-simulated gas. We cannot observe hardcoding directly.
- **Proposed-block abandonment:** how often `latest` gets abandoned, via `monadNewHeads` commitState over 24h.

## Who it's for, and why now

The user is anyone running an agent or bot that holds money and sends transactions with no human watching each one.

- **Operators** of AI trading agents (via MCP or MetaMask Agent Wallet), liquidators, arbitrage bots and automation scripts.
- **Agent platforms** that hand wallets to agents.

**Why now:**

- Agent wallets are shipping now, and MetaMask Agent Wallet already has plugins and policy gating.
- On Monad, a looping agent pays the full limit on every failure.
- 300ms blocks push builders to skip simulation for speed.
- Afterwards, an operator can't see *why* an autonomous send failed.

## How it works

Every send passes through the breaker and a fresh simulation; a doomed send is refused with a slot-level reason, and every decision leaves a receipt.

&#91;embedded content: Readset send flow · 2 checks, 3 outcomes\]

A tripped breaker halts before any simulation; a send that would revert is refused with its cause; only a clean simulation is signed.

### Dependency set: what a transaction relied on

| Part | How we get it |
| --- | --- |
| Storage slots | `prestateTracer` on `debug_traceCall` at `latest`. Kill test K1 confirms read-only slots are included. |
| Sender balance and nonce | Read from the RPC. |
| Time and block dependence | Monad has no struct logs, so opcodes are invisible. (a) Scan the bytecode of every contract in the `callTracer` tree for TIMESTAMP (`0x42`) and NUMBER (`0x43`), skipping PUSH data, and flag "may be time-dependent". (b) For flagged sends, re-simulate on a local fork with the block shifted +1; a changed result confirms it. |

### Components

1. **Gate.** Simulate at `latest`. On revert, refuse to sign and return `DoomedTx { reason, revertData }`. Check the sender can cover the full limit and reserve balance. Set the gas limit from simulated gas plus Category Labs' dynamic buffer, credited, with no claim to improve on it.
2. **Dependency receipt.** Every send, allowed or blocked, writes a JSON record: dependency set, simulated values, block, policy hash and verdict. If the send later reverts, diffing the receipt against chain state gives the exact cause.
3. **Explain.** Diff the dependency set against `diffMode` traces of the blocks in between. Name the slot (labelled from the solc storage layout where source is verified), old→new values, the writer transaction and its sender. An LLM may rephrase this but never decides it.
4. **"Why your bot lost" page.** Paste any failed Monad transaction hash and see its dependency graph, the changed slot in red, the writer, an avoidable-at-N−k verdict and the MON burned. This is the growth loop.
5. **Breaker.** Policy fields `maxConsecutiveReverts`, `maxBurnPerHour` and per-(target, selector) limits. When it trips, sending halts, the operator is notified, and a reset is required. Agent Wallet's own policies decide *what an agent may do*; Readset decides *whether this send is worth doing right now*.
6. **Fast path (stretch).** Cache the simulation and dependency set, invalidate on `monadLogs` events mapped to slots, and audit the miss rate with block traces. This is Monad's optimistic idea applied client-side.

### Honest limits

- Same-block races are invisible, because there's no pending feed.
- `latest` is a Proposed block and can be abandoned; we measure how often.
- Log-based invalidation misses changes that emit no log; we publish the miss rate.
- Time dependence is a heuristic.
- A local-fork fallback doesn't reproduce Monad's gas pricing or reserve-balance rules.
- No protection against malicious contracts; that's Blockaid's job.

## Prior art

Simulation itself is a commodity; Readset's new parts are slot-level causation, receipts and an outcome-based breaker tuned to Monad. Credit each of these openly.

| Prior art | What it does | How Readset differs |
| --- | --- | --- |
| [Category Labs gas-limit research](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad) | Measured failure and unused-gas rates; dynamic per-(to, selector) buffer | Uses and credits their buffer; adds avoidance, causation, receipts and the breaker |
| viem / ethers `estimateGas` | Throws on revert by default | Skipped when gas is hardcoded; gives no reason, receipt or policy |
| [evm-fork-cache](https://docs.rs/evm-fork-cache), reth ExecutionCache | Simulation caching with log/block invalidation for MEV | The fast path borrows the idea; adds wallet policy and a miss-rate audit |
| [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/plugins/) policy gating | Permission rules for agent actions | Complementary: outcome-based gating inside the same flow |
| Blockaid | Malicious-transaction alerts on Monad | Targets attacks, not failures |
| Blocknative pre-flight, Tenderly | Hosted simulation | No slot-level causation, no agent policy |
| Flashbots Protect | No-revert relay on Ethereum | We found none on Monad; Readset is a client-side substitute, not a relay |

## Scope

Ship the plugin with gate, breaker and receipts first; everything else is secondary.

**MVP:**

- MetaMask Agent Wallet plugin with gate, reserve check and breaker. Fallback order: intercept before `wallet-submit`, else a `safe-submit` command agents call instead, else drop the bounty and lead with the MCP server and viem wrapper.
- Dependency receipts
- Explanation and the "Why your bot lost" page
- Replay benchmark on real failed mainnet transactions
- MCP server (`readset_send`, `readset_status`, `readset_policy`)
- viem wrapper from the shared core

**Stretch:**

- Fast path with miss-rate audit
- "Most-changed dependency slots" table per contract (the Hotslot callback)

**Cut:**

- Contention heatmap, ParaLib, attestations, ERC-8004 hooks and reputation scores
- Throughput multipliers, trading-alpha claims and the "phantom gas" capacity pitch
- Beating Category's gas buffer, auto-retry-with-fix, and a separate dashboard

## Metrics, kill tests and fallbacks

Three things must be true by the night of 8 Oct; if two fail, shrink to an MCP `monad_safe_send` tool (gate, breaker, receipts) plus the "Why your bot lost" page.

**Headline metrics:**

| Metric | Target |
| --- | --- |
| Revert burn knowable before sending | ≥30% at N−1, ≥25% at N−3 |
| False blocks on an equal sample of successful sends | <1%, shown next to the abandonment rate |
| Loop burn a default breaker of 5 would stop | Reported in MON |
| Fast path, if kept | ≈0 ms added on cache hits; miss rate <5% |

**Kill tests:**

| Test | What we check | If it fails |
| --- | --- | --- |
| K1 | `debug_traceCall` accepts a historical block number and block hash on our RPC (Alchemy, Quicknode or Dwellir), and `prestateTracer` includes read-only slots | Backtest on a local fork at archive state; if read-only slots are missing, explain written slots only and say so |
| K2 | Knowable-at-N−3 is ≥25% of burned MON, or loop burn is a meaningful share | Reposition as an audit trail (receipts, forensics, breaker) and publish the negative result; don't claim savings |
| K3 | An Agent Wallet plugin can intercept or `safe-submit` a send with a custom gasLimit on testnet; we have the bounty text | Ship as MCP server + viem wrapper, no bounty |
| K4 | `monadLogs` / `monadNewHeads` reachable on a hosted endpoint | Cut the fast path; estimate abandonment from history |

## 3-minute demo

Open with real day-0 numbers, show one refused send and one tripped breaker, and close on the lineage.

| Time | What happens |
| --- | --- |
| 0:00 | Cold open over a wall of red REVERTED rows: "In the last 30 days, \_\_\_ transactions failed on Monad and burned \_\_\_ MON. Every one paid its full gas limit. \_\_\_% was knowable before it was sent." |
| 0:20 | Paste a real failed hash into "Why your bot lost". The graph turns one slot red: old→new value, written by 0xab… in block N−1. Verdict: avoidable at N−1. |
| 0:50 | The most-changed dependency slots for that contract: "This is where Hotslot started." |
| 1:10 | An agent on MetaMask Agent Wallet against a mock lending market we deployed on testnet (labelled as ours). A competitor writes the health factor; Readset refuses the send, explains why, and shows the receipt. |
| 1:50 | The agent loops a broken swap. The breaker trips at 5 and notifies the operator: "\_\_\_ MON saved". Agent Wallet allowed the swap; Readset stopped the burn. |
| 2:25 | Replay results: avoidable share at N−1/N−3, false blocks, abandonment rate, and the same-block share we can't catch. |
| 2:50 | Close: "Monad re-runs a transaction only when its inputs change. Readset gives your agent the same instinct: send fast, and never pay for a transaction that was already lost." |

## 6-day plan

Run the kill tests tonight; by 9 Oct the plugin core and the benchmark must both exist. Assumes 2 devs.

| Day | Dev A: data and engine | Dev B: plugin and product |
| --- | --- | --- |
| 7 Oct (tonight) | K1, K2: replay 2,000 failed transactions | K3: bounty text and plugin spike; K4 |
| 8 Oct | 30-day failed-transaction index; burn and loop numbers | Plugin skeleton: gate, reserve check, receipt |
| 9 Oct | Full replay benchmark and false-block sample; abandonment logger running | Breaker and policy; viem wrapper from shared core |
| 10 Oct | Explain: receipt diff, storage-layout labels, time-dependence scan and re-sim | "Why your bot lost" page |
| 11 Oct | MCP server; most-changed slots table | Testnet agent A/B harness with mock market |
| 12 Oct | Fast path only if everything is green; freeze numbers | Record demo; README with limits |
| 13 Oct | Submit by 23:59 ET |  |

**Cut order:** fast path, then the most-changed slots table, then viem wrapper polish, then the MCP server. **Never cut:** the plugin (or its fallback), gate, breaker, receipts, "why" page and replay benchmark.

**Traction targets:**

- 8 Oct: aggregate revert-burn thread on X and the Monad dev Discord inviting hash pastes; aim for 20+ distinct hashes.
- 9–10 Oct: contact 15 bot and agent builders, aim for 5 replies.
- 10 Oct: list the MCP server in MCP directories.
- 11–12 Oct: 3 integrations running for 24h.
- Proof for judges: npm installs, distinct hashes analysed, and one named quote.

## Who pays

Today this is grant- and bounty-scale, and the pitch should say so; the bet is that agents holding treasuries need a spend firewall.

**Positioning:** a spend firewall and audit trail for agent treasuries. The buyer is the agent platform or wallet provider, not the bot. Their fear isn't 0.03 MON per send; it's an agent stuck in a loop at 3am, and not being able to explain afterwards what it decided and why.

**Why it's small today:** Monad is lightly loaded, per-transaction losses are small, and open-source client guards are hard to charge for.

**Paths if agent volume grows:**

- A hosted policy, alerting and receipt-retention service, priced per agent.
- A node-co-located tier using Monad's Execution Events SDK for exact slot-level invalidation at proposal time.
- Integration into agent platforms' wallet stacks.

## Judge Q&A

The six hardest questions, with answers that concede what's true.

1. **"viem already throws when estimateGas reverts."** Only if you estimate. Monad recommends hardcoding static gas, and fast bots skip simulation; we show a proxy for how much burn had padded limits. Even when estimation catches a revert, it gives no reason, receipt or spend policy.
2. **"Isn't this Category Labs' research?"** No. We use and credit their buffer. They didn't build avoidance, causation, receipts or a breaker.
3. **"Same-block races are the real loss."** Agreed, and they can't be caught without a pending feed. We publish that share and target the knowable share plus loops.
4. **"Why not just use Agent Wallet's policies?"** They gate permission. Readset gates outcome: is the state already against you, and is this agent burning money on failures? It runs inside their flow.
5. **"How do you know time dependence without opcode traces?"** A bytecode scan flags it, and a differential re-simulation confirms it. We label it a heuristic.
6. **"This is a $2.5k-scale business."** Today, yes. The bet is that agents holding treasuries need a firewall and an audit trail, and Monad's full-limit charge makes that matter here first.

## How this plan was made

Three agents (a planner, a critic and a feature ideator) ran 10 rounds; each idea below died to a specific fact.

| Round | Lead idea | What killed or changed it |
| --- | --- | --- |
| 1 | Hotslot as written | Re-execution is value-based, so ReentrancyGuard likely doesn't conflict; no "rounds"; access lists are 128-slot-page granular |
| 2 | Slotproof: agent refactors contracts, proves and attests the fix | Monad is \~7% utilised, so contention has no measured victim today |
| 3 | TightGas / Margin: tight gas limits for agents | Category Labs already published this research, and receipts mask gas used |
| 4–5 | Doomsend: refuse doomed sends | viem already gates by default; value is in loops, causation and hardcoded-gas bots |
| 6 | Optimistic sending fast path | No public slot-level feed without your own node; demoted to stretch |
| 7–10 | Readset | Citations corrected, plugin made primary with fallbacks, ERC-8004 hook dropped |

### Sources

- [Monad docs: parallel execution](https://docs.monad.xyz/monad-arch/execution/parallel-execution)
- [Monad docs: gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing)
- [Monad docs: best practices](https://docs.monad.xyz/developer-essentials/best-practices)
- [Monad docs: RPC differences](https://docs.monad.xyz/reference/rpc-differences)
- [Monad docs: debug\_traceBlockByNumber](https://docs.monad.xyz/reference/json-rpc/debug_traceBlockByNumber)
- [Monad docs: websockets](https://docs.monad.xyz/reference/websockets)
- [Monad docs: block states](https://docs.monad.xyz/monad-arch/consensus/block-states)
- [Monad docs: ERC-8004](https://docs.monad.xyz/guides/erc-8004)
- [Category Labs: setting your gas limit on Monad](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad)
- [SQD: Monad on-chain data](https://sqd.dev/learn/monad-onchain-data/)
- [Cointelegraph: $112k failed trades](https://cointelegraph.com/news/monad-airdrop-farmer-spends-112k-failed-trades)
- [MetaMask Agent Wallet plugins](https://docs.metamask.io/agent-wallet/plugins/)
- [Monad Metropolis](https://monad.xyz/developers/hackathons/metropolis)
