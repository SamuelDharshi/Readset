# `@readset/viem` — drop-in guard for a viem WalletClient

Wraps a viem `WalletClient` so every send runs **breaker → gate → receipt before signing**.
On Monad a reverted transaction pays `gas_limit × price` in full, so a send that is already
lost is refused rather than signed.

## Install / import

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from '@readset/core';
import { createGuardedWalletClient, isDoomedTxError } from '@readset/viem';

const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.READSET_PRIVATE_KEY as `0x${string}`),
  chain: monadTestnet,
  transport: http(),
});

const client = createGuardedWalletClient({ walletClient, publicClient });
```

`client` **is** the viem client: same methods, same parameters, same return types (it is a
Proxy over the original, so `client.chain`, `client.account`, `client.signMessage`,
`client.extend`, everything, still work).

## The one behavioural difference

`sendTransaction` and `writeContract` can **refuse**. They throw `DoomedTxError` and nothing
is signed, broadcast or paid for:

```ts
try {
  const hash = await client.writeContract({
    address: token, abi, functionName: 'transferFrom', args: [holder, me, 1n],
  });
} catch (e) {
  if (isDoomedTxError(e)) {
    e.verdict;       // 'refused_doomed' | 'refused_funds' | 'refused_breaker' | 'refused_policy'
    e.reason;         // human-readable cause
    e.revertReason;   // decoded revert, when decodable
    e.revertData;     // raw revert data
    e.receiptId;      // id of the dependency receipt written for this refusal
    e.toJSON();       // structured form for logs / MCP results
  } else throw e;     // ordinary viem error, unchanged
}
```

Everything else is unchanged, with two side effects you can observe:

- the **gas limit** on the send is the one the gate chose (simulated gas plus
  `policy.gasBufferPct`), unless you passed `gas` yourself, in which case yours is used;
- after a successful broadcast the transaction is watched and its outcome (`status`,
  `gasUsed`, `feePaidWei`, `blockNumber`) is attached to its receipt. This happens in the
  background; pass `awaitOutcome: true` to wait for it, or await `client.readset.lastOutcome`.

## Options

```ts
createGuardedWalletClient({
  walletClient,          // required
  publicClient,          // optional: derived from walletClient.chain if omitted
  policy,                // optional: pinned Policy; otherwise loaded on every send
  awaitOutcome: false,   // await the mined outcome before returning the hash
  onDecision: (d) => {}, // called with every decision, allowed or refused
});
```

## Extra API

| Member | What it does |
| --- | --- |
| `client.guard(tx)` | Breaker → gate → receipt **without sending**. Returns a `GuardDecision` (`allowed`, `verdict`, `reason`, `gasLimit`, `doomed`, `dependencySet`, `breaker`, `receipt`, `source`). Never throws on a refusal. |
| `client.readset.policy()` | The policy in force. |
| `client.readset.breaker()` | Breaker state: `tripped`, `reason`, `consecutiveReverts`, `burnLastHourWei`, `limits`. |
| `client.readset.receipts(limit?)` | Recent dependency receipts, newest first. |
| `client.readset.lastDecision` | Decision for the most recent send/guard. |
| `client.readset.lastOutcome` | Promise for the last send's attached outcome. |
| `client.readset.source()` | Per function: `'core'` or `'fallback'` (see below). |

Standalone exports: `guard({ tx, publicClient, policy?, record? })` for a check with no wallet
at all, `attachOutcome({ publicClient, receiptId, txHash })`, `refusalError(decision)`,
`DoomedTxError`, `isDoomedTxError`, `loadCoreBindings`, `DEFAULT_POLICY`, and the state-file
helpers `stateDir` / `receiptsPath` / `policyPath`.

## Where the gate comes from

The wrapper programs against `@readset/core`'s `gate`, `recordAttempt`, `checkBreaker`,
`recordOutcome`, `recentReceipts`, `loadPolicy`, `savePolicy` (and `explain`). Whichever core
exports are present are used; the rest come from a deliberately thin stand-in in
`packages/viem/src/fallback.ts` (real RPC, real files, nothing mocked) so this package is
usable and testable while core's gate is still being written. `client.readset.source()` tells
you which you got. **TODO(core):** delete `fallback.ts` once core exports the full set — the
stand-in does *not* implement core's real work (prestateTracer dependency sets, slot
labelling, the Category Labs per-(to,selector) gas buffer, Monad reserve-balance rules,
per-target policy limits).

State for the stand-in lives in `READSET_STATE_DIR` (default `<cwd>/.readset`):
`receipts.jsonl` and `policy.json`.

## Honest limits (from the PRD)

- Same-block races are invisible: Monad has no pending-transaction feed, so a send can still
  revert because of a transaction that lands in the same block.
- The gate simulates at `latest`, which on Monad is a **Proposed** block that can be abandoned.
- The stand-in's revert decoding covers `Error(string)` and `Panic(uint256)`; other custom
  errors are reported by selector until core's decoder is wired in.
- No protection against malicious contracts — that is Blockaid's job, not Readset's.

## Tests

`npx vitest run packages/viem` runs against **real Monad testnet** (chain 10143). It refuses a
real doomed `transferFrom` (no allowance) and refuses a send the unfunded project wallet
cannot cover at `gas_limit × price`; both assert a receipt was written. Nothing is signed, so
no funded key is needed. The tests skip loudly if the RPC is unreachable.
