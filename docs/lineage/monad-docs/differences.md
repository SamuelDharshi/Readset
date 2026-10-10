# Differences from Ethereum
URL: https://docs.monad.xyz/developer-essentials/differences
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- Contract code size 128 KB (Ethereum 24 KB). Memory expansion "priced linearly rather than quadratically", 8 MB tx limit. P256 precompile added.
- Storage warming is page-based: "the first `SLOAD` or `SSTORE` to a page pays the cold cost, and every other slot of that page is warm".
- "Transactions are charged based on gas limit rather than gas usage".
- Reserve Balance mechanism "ensures transactions included in consensus can be paid for".
- "Reverting transactions are included on-chain and pay gas fees".
- EIP-7702: delegated EOAs cannot have balances below 10 MON; CREATE/CREATE2 banned for delegated accounts.
- Blob (type 3) txs unsupported. "There is no global mempool". Full nodes have no arbitrary historical state access.
