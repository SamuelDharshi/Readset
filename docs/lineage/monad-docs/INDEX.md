# Monad docs index: what each page implies for Hotslot

Source pages ingested 2026-10-06 (one file each in this folder; the essentials summary page is essentials-summary.md). Summaries come from WebFetch's condensing pass, so verify quotes on the live page before publishing.

| Topic (file) | What it implies for Hotslot |
|---|---|
| parallel-execution.md | Confirms optimistic execute-then-merge with re-execution on differing inputs. Docs never state granularity or value-vs-touch; that rests on client source (model.md). No dedicated optimistic page exists to link. |
| reserve-balance.md | A consensus/inclusion rule, not an execution conflict source: no new conflict edge. Impact on workloads: each sender must hold MON for cumulative inflight gas-limit x price; a funded-but-low sender can be dropped from a block, silently shrinking the measured block. Only EIP-7702-delegated accounts revert on dipping below 10 MON, so keep workload senders plain EOAs. "Emptying transaction" exception means a sender draining its balance is allowed about once per 1.2 s. Fund each sender with headroom (a few MON suffices at 0.02 MON per 200k gas). |
| gas-pricing.md | Gas LIMIT is charged: any gas comparison (serial vs parallel twin) must use limit, and refunds (ReentrancyGuard 2->1) save nothing in fees. Workload txs should pass an explicit gas limit. Tx limit 30M, block 150M. |
| opcode-pricing.md | SLOAD 8,100 first page touch / 100 warm; SSTORE 100 + 8,000 page load + 2,800 page write + 17,000 state growth. Sharded/per-caller twins touch fresh pages per caller, so their first-call gas is HIGHER than the shared-slot twin. Hotslot's "same gas" claim (PRD §12) is false in general: report gas for both twins. Cold account access 10,100 makes cross-contract twins (HotErc20Serial's token call) costlier. |
| differences.md | Page-based warming (128 slots) is gas-only. Reverting txs still pay gas and are included on-chain, so a parallel twin that reverts (e.g. SingletonNonceParallel NonceUsed) still costs gas and still occupies a block slot. No global mempool: ordering on testnet is leader-local; measure conflicts from mined block order, not submission order. |
| essentials-summary.md | Block time 300 ms (see contradictions). Gas 150M/block, 30M/tx. Types 0,1,2,4 only: workload tx builders must not send type 3. |
| mera.md | Passkey accounts; irrelevant to conflicts. Index glosses it wrongly as an execution guide. Only useful line: pass explicit gas. |
| tooling-and-infra.md | Docs list 18 RPC providers but no URLs, limits or trace support. Only the 3 public testnet RPCs have limits (QuickNode 50 rps / 25 rps eth_call; Ankr 300 req/10 s; Foundation 20 rps, no batch). Trace-capable per our own live test: testnet-rpc.monad.xyz; Ankr forbids debug_*; others unconfirmed. Rate limits cap how many txs a scan can trace per second. |
| deploy-smart-contract.md | `forge create ... --account <keystore> --broadcast`, RPC https://testnet-rpc.monad.xyz, chain 10143. For 16 contracts prefer `forge script --broadcast`. |
| verify-smart-contract.md | `forge verify-contract <addr> <name> --chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/` or `--verifier etherscan --etherscan-api-key ... --watch`. |

## Contradictions with docs/model.md and docs/verification.md (nothing fixed)

1. Block time: summary.md says "300 ms" (blocks finalise at 600 ms); docs/verification.md row 17 says "block time 400 ms" from the changelog, and its "34 blocks in about 10 s" implies about 300 ms. model.md itself states no block time. verification.md row 17 should be reconciled (likely stale changelog).
2. docs.md describes MERA as "Monad execution and runtime architecture guide"; the page is a passkey account guide. Not a model.md claim, but do not cite it as architecture.
3. PRD §12 "Same gas" (and the serial/parallel pitch): opcode-pricing shows first-touch SSTORE of fresh keccak slots costs +17,000 state growth and a new page load, so per-caller twins are not same gas. model.md section 4 only says the guard costs gas; it does not cover the extra first-touch cost of per-caller guards.
4. Not contradictions but unaddressed by model.md: page-based warming (128-slot pages) and reserve-balance. Docs give no sign that page granularity affects conflicts (model.md says per slot, from source); this remains source-only, untested on chain.
5. Docs tooling page gives no Ankr debug_* restriction; verification.md's "Ankr forbids debug_*" came from a live test, not from this page. Consistent, just not documented here.
