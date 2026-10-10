# MERA
URL: https://docs.monad.xyz/guides/mera
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- Passkey-based account system: "derives EVM accounts from a passkey" (Face ID / Touch ID / security keys), no seed phrase.
- Not about parallel execution or conflicts. The hackathon index (docs.md) glosses it as "Monad execution and runtime architecture guide", which does not match the page.
- Only relevant line: "Monad charges the `gasLimit` you declare, not the gas used. Pass an explicit `gas` value, such as `21_000n` for a native transfer" rather than relying on estimates.
- Hotslot consequence: workload txs should set explicit gas limits.
