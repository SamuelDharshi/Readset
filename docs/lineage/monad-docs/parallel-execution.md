# Parallel execution
URL: https://docs.monad.xyz/monad-arch/execution/parallel-execution
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- "Monad blocks are the same as Ethereum blocks - a linearly ordered set of transactions."
- Optimistic execution: txs start before predecessors finish; "If they differ, we have detected that transaction 2 used incorrect data while executing and it needs to be executed again."
- State updates are merged sequentially; analogies to optimistic concurrency control and software transactional memory (Wikipedia links only).
- Re-execution reuses signature recovery and cached state. "there are other opportunities to avoid re-executing transactions which are still being explored."
- No separate optimistic-execution page is linked (only llms.txt and two Wikipedia articles). Granularity (slot vs account, value vs touch) is not stated; see docs/model.md (client source).
