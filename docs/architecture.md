# Readset architecture

Status: in progress. This describes the intended layout and which parts exist today. See `PRD.md` for the product case.

## Packages (npm workspaces, `packages/*`)

| Package | Role | State |
| --- | --- | --- |
| `@readset/core` | Shared foundation: types, Monad chain layer, tracing helpers, slot labeller. Everything else depends on it. | chain, trace, label implemented and tested against live Monad RPC |
| `@readset/bench` | Benchmarks: failed-transaction index, avoidability and abandonment measurements. | in progress (other workstream) |
| `@readset/plugin` | MetaMask Agent Wallet plugin (gate + receipt + breaker). | spike in progress |
| `@readset/viem` | viem wrapper exposing the same gate for ordinary viem users. | stub |
| `@readset/mcp` | MCP server exposing gate / explain to agents. | stub |
| `@readset/api` | HTTP API behind the "why your bot lost" page. | stub |

Each package's `main`/`types` point at `src/index.ts`, so consumers run straight from source via `tsx` or vitest; there is no build step yet.

### `@readset/core` layout

```
packages/core/src/
  types.ts          shared contracts (TxRequest, DependencySet, Receipt, Explanation, Policy, ...)
  chain/            monad.ts (chains 143 / 10143), clients.ts (env config, viem clients), capabilities.ts (RPC probes)
  trace/tracer.ts   prestateTracer + callTracer helpers
  label/            labeller.ts (storage-layout slot labels), compile.ts (solc-js compile for layouts)
  index.ts          re-exports all of the above
```

Environment: `READSET_NETWORK` (`testnet`|`mainnet`), `READSET_RPC_URL`, `ALCHEMY_API_KEY`, `READSET_PRIVATE_KEY`. The legacy `HOTSLOT_*` names are accepted as fallbacks. Precedence for the RPC URL: explicit URL, then Alchemy key, then the first public endpoint.

Tracing API: `traceCallPrestate(client, tx, blockNumberOrTagOrHash, { diffMode })`, `traceTxPrestate`, `parsePrestate`, `traceCallTree` / `traceTxCallTree`, `walkCallTree`, `calleeAddresses`, plus key helpers (`normalizeSlot`, `accountKey`, `slotKey`, `splitKey`). A 32-byte block hash is sent as an EIP-1898 `{blockHash}` selector.

## Data flow

### 1. Send path: gate -> simulate -> dependency set -> receipt -> breaker

```
agent send(tx)
  -> breaker check          tripped? halt, write receipt (refused_breaker)
  -> simulate               debug_traceCall at latest (prestateTracer, callTracer)
  -> gate                   revert? refuse, DoomedTx {reason, revertData}
                            cannot cover gas_limit x price / reserve balance? refused_funds
  -> dependency set         slots from prestate (value seen, read-only flag, label),
                            accounts, time-dependence flag from bytecode scan of callTracer tree
  -> sign and send          gas limit = simulated gas + buffer
  -> receipt                one JSON record per attempt (allowed or blocked): dependency set,
                            block, policy hash, verdict, later outcome
  -> breaker update         consecutive reverts and burn per hour feed the policy
```

`coverage: 'written-only'` is recorded when the node's tracer omits read-only slots (kill test K1 fallback).

### 2. Explain path: receipt -> trace diff

```
failed tx hash (or a receipt)
  -> load dependency set (receipt) or re-derive from the tx's own prestate trace
  -> diffMode traces (traceTxPrestate) of the blocks between basis and inclusion
  -> find slots in the set whose value moved; the writer tx, sender and block come from the trace
  -> label slots (label/) from the solc storage layout where source is known
  -> Explanation { movedSlots, avoidableAt, burnedWei, gasLimit }
```

Explanations are computed from traces; an LLM may only rephrase them.

### 3. Bench path: bench -> failed-tx index

```
block scan (core clients) -> failed txs with gasLimit x price burn
  -> replay at N-1 / N-2 / N-3 (traceCallPrestate with block selectors) -> avoidability bucket
  -> index of failed txs, sender concentration, abandonment stats  (packages/bench)
  -> feeds the "why your bot lost" page and the published numbers
```

## Honest limits

Same-block races are invisible (no pending feed); `latest` can be a Proposed block that gets abandoned; time dependence is a heuristic; the slot labeller resolves mapping entries only for candidate keys it is given (callers and small integers). See PRD "Honest limits".
