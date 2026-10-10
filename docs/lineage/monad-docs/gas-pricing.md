# Gas pricing
URL: https://docs.monad.xyz/developer-essentials/gas-pricing
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- "The gas charged for a transaction is the **gas limit**" rather than gas used (supports asynchronous execution).
- "price_per_gas = min(base_price_per_gas + priority_price_per_gas, max_price_per_gas)"; "fee = gas limit x price per gas".
- Min base fee 100 MON-gwei; block gas limit 150M; tx gas limit 30M.
- "Typical 200,000-gas transaction costs about $0.0005" at min base fee (0.02 MON). Transfer 21,000 gas ~ $0.00005.
- Base fee controller "increases more slowly and decreases more quickly" than Ethereum; max step 1/28; target "160M (80% full)".
- Hotslot consequence: gas LIMIT is charged, so the ReentrancyGuard 2->1 refund gives no fee saving; compare gas using gasLimit, not gasUsed.
