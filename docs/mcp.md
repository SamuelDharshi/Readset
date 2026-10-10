# `@readset/mcp` — the Readset MCP server

An MCP server (official `@modelcontextprotocol/sdk`, stdio transport) that puts Readset's
gate, breaker and receipts in front of an agent's sends. On Monad a reverted transaction pays
`gas_limit × price` in full, so the agent is told *before* signing.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `readset_send` | `to`, `data?`, `value?` (wei, decimal string), `from?`, `gas?`, `send?` (default `false`) | Runs breaker → gate → receipt. `send=false` checks only and signs nothing. `send=true` signs and broadcasts **only if allowed**, with the gas limit the gate chose. Result: `{ok, sent, txHash?, verdict, allowed, reason, revertReason, revertData, gasLimit, receiptId, policyHash, breaker, dependencySet, source}`. |
| `readset_status` | `limit?` (1–100, default 10) | `{ok, chain:{chainId,network,rpcUrl,blockNumber}, signerConfigured, breaker:{tripped,reason,consecutiveReverts,burnLastHourWei,limits}, rollingBurn, receiptCount, receipts[], coreBindings}`. Read-only. |
| `readset_policy` | `action:'get'\|'set'`, plus `maxConsecutiveReverts?`, `maxBurnPerHourWei?`, `gasBufferPct?`, `failClosed?`, `perTarget?` | `{ok, policy, updated?}`. `set` merges the given fields and persists them. |
| `readset_explain` | `txHash` | `{ok, explanation}`: slots that moved, who wrote them, avoidable-at-N−k, MON burned. **Registered only when `@readset/core` exports `explain`.** It did not at the time of writing, so the tool is absent and the server says so on stderr at startup; nothing else changes. |

Every result is one JSON object in a single text block.

### Errors an agent can act on

- A **refusal** is an answer, not a fault: `isError` is `false` and the body is
  `{ok:false, verdict:'refused_doomed'|'refused_funds'|'refused_breaker'|'refused_policy', reason, receiptId, ...}`.
  Nothing was signed. The agent should fix the cause (or stop), not retry blindly.
- A **fault** sets `isError: true` with `{ok:false, error:{code, message, hint}}`. Codes:
  `NO_SIGNER` (asked to send with no `READSET_PRIVATE_KEY`), `NO_FROM`, `SIGNER_INVALID`,
  `GATE_ERROR`, `STATUS_ERROR`, `POLICY_ERROR`, `EXPLAIN_ERROR`.
- Malformed arguments are rejected by the input schema before any RPC call.

### Secrets

The server reads `READSET_PRIVATE_KEY` from its own environment and **never returns it, logs
it, or accepts a key as a tool argument**. `readset_status` only reports
`signerConfigured: true|false`, and RPC URLs are printed with the API key redacted. Without a
key, `readset_send` still gates (pass `from`); only `send=true` is refused, with `NO_SIGNER`.

## Environment

| Variable | Meaning |
| --- | --- |
| `READSET_NETWORK` | `testnet` (default) or `mainnet`. |
| `READSET_RPC_URL` | Explicit RPC URL; wins over Alchemy. |
| `ALCHEMY_API_KEY` | Used to build an Alchemy URL when no explicit RPC URL is set. |
| `READSET_PRIVATE_KEY` | `0x` + 64 hex. Required only for `readset_send` with `send=true`. |
| `READSET_STATE_DIR` | Where receipts and `policy.json` live (default `<cwd>/.readset`). |

## Run it

```bash
# from the repo
node packages/mcp/bin/readset-mcp.mjs
# or
npx tsx packages/mcp/src/bin.ts
```

The bin entry is `readset-mcp` (`packages/mcp/bin/readset-mcp.mjs`). The repo ships
TypeScript sources with no build step, so the shim registers `tsx`'s ESM loader and then
imports `src/bin.ts`. stdout carries MCP frames only; all diagnostics go to stderr.

## Register with Claude Code

Project-scoped, in `.mcp.json` at the repo root (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "readset": {
      "command": "node",
      "args": ["D:/Monad/readset/packages/mcp/bin/readset-mcp.mjs"],
      "env": {
        "READSET_NETWORK": "testnet",
        "READSET_STATE_DIR": "D:/Monad/readset/.readset"
      }
    }
  }
}
```

Or in one command:

```bash
claude mcp add readset --env READSET_NETWORK=testnet -- node D:/Monad/readset/packages/mcp/bin/readset-mcp.mjs
```

Then `/mcp` in Claude Code lists `readset` with its four (or three) tools.

## Register with Claude Desktop

`claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`;
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "readset": {
      "command": "node",
      "args": ["D:/Monad/readset/packages/mcp/bin/readset-mcp.mjs"],
      "env": {
        "READSET_NETWORK": "testnet",
        "READSET_RPC_URL": "https://testnet-rpc.monad.xyz",
        "READSET_STATE_DIR": "D:/Monad/readset/.readset"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. Use absolute paths — the app does not inherit your shell's
`PATH` or working directory. To let the agent actually send, add
`"READSET_PRIVATE_KEY": "0x…"` to that `env` block (a test key, on testnet, funded with as
little as you can).

Once published to npm the same config works with
`"command": "npx", "args": ["-y", "@readset/mcp"]`.

## Honest limits

- The gate simulates at `latest`, which on Monad is a **Proposed** block that can be
  abandoned, and same-block races are invisible (there is no pending-transaction feed).
- `readset_explain` exists only if core exports `explain`.
- The server is cooperative, like the MetaMask Agent Wallet plugin (see
  `docs/kill-tests/K3.md`): it guards the sends an agent routes through `readset_send`. It
  cannot intercept a send the agent makes with some other tool.
- While `@readset/core`'s `gate`/`recordAttempt`/`checkBreaker` are still being written, a
  thin real-RPC stand-in in `packages/viem/src/fallback.ts` fills the gaps;
  `readset_status.coreBindings` reports, per function, whether you got `core` or `fallback`.
  **TODO(core):** that file is deleted once core lands.

## Tests

`npx vitest run packages/mcp` spawns the real binary over stdio with the official MCP client,
against live Monad testnet: lists tools, calls `readset_status` and `readset_policy`
(get/set/get), asserts a structured `refused_doomed` from `readset_send` on a real doomed
`transferFrom` and that its receipt shows up in `readset_status`, and asserts the `NO_SIGNER`
refusal. `READSET_PRIVATE_KEY` is stripped from the child env, so the test can never sign.
Skips loudly if the RPC is unreachable.
