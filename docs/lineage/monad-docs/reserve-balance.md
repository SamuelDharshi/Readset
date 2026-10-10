# Reserve balance
URL: https://docs.monad.xyz/developer-essentials/reserve-balance
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- Purpose: "allow[s] Monad to simultaneously support asynchronous execution and EIP-7702". Consensus validates blocks using only k-blocks-old state.
- `user_reserve_balance` = "10 MON" per EOA.
- Execution reverts when an EIP-7702-delegated account's balance "dips below" 10 MON after a tx (decreases AND ends below). Non-senders must keep their starting balance or the reserve, whichever is lower.
- Consensus excludes txs when cumulative gas fees of inflight txs exceed the available reserve budget.
- Exception: "emptying transactions" (first tx in k blocks from undelegated accounts) bypass the constraint, so an account can spend its whole balance about once per 1.2 s.
- Quote: "consensus can safely include a series of transactions whose running gas spend stays below user_reserve_balance, without knowing the latest state."
- The page (as summarised) says nothing about conflicts between txs in execution; it is a consensus/inclusion rule.
