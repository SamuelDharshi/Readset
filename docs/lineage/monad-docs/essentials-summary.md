# Developer essentials (summary page)
URL: https://docs.monad.xyz/developer-essentials/summary
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

- Block frequency: "300 ms". Block gas limit 150M. Per-tx gas limit 30M. Throughput 500M gas/sec.
- Min base fee "100 MON-gwei (100 * 10^-9 MON)". "The gas limit is what is charged". EIP-1559 compatible.
- Max contract size "128 kb". Opcodes as of Fusaka. Precompiles: P256 (0x0100), staking (0x1000).
- Finality: "after two blocks (600 ms)"; speculative after one block (300 ms); state root three blocks after finalization.
- Storage warming "a page of 128 consecutive slots at a time". Cold account access 10,100 gas (Ethereum 2,600).
- Tx types 0,1,2,4 supported; type 3 not. Foundry, Viem, Tenderly, Safe, Monadscan supported.
