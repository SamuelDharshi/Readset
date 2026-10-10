# Opcode pricing
URL: https://docs.monad.xyz/developer-essentials/opcode-pricing
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

| Op | Monad cost |
|---|---|
| SLOAD, first access to a page | 8,100 (cold) |
| SLOAD, same page again | 100 (warm) |
| SSTORE | sum of: 100 base; +8,000 page load (first access to page); +2,800 page write (first value-changing write to page); +17,000 state growth (page reaches new high-water mark) |
| Cold account access (BALANCE, EXTCODE*, CALL*, STATICCALL, SELFDESTRUCT) | 10,100 (Ethereum 2,600) |
| Warm account access | 100 |

Precompiles: ecRecover 6,000; ecAdd 300; ecMul 30,000; ecPairing 225,000 + 170,000/point; blake2f rounds x 2; point eval 200,000. Memory: "w / 2" per 32-byte word, 8 MB cap (131,072 gas max).

Hotslot consequence (gas vs parallel): cold SLOAD is ~4x Ethereum's 2,100, and a first-time SSTORE adds 17,000 state growth. Per-caller guard/shard mappings (first write to a fresh keccak slot = new page) pay page load + state growth on first touch, so the "parallel" twins cost MORE gas on a caller's first call than shared-slot twins. Keccak-derived mapping slots land in different pages, so no page-sharing benefit. Page warming is a gas rule only; the page says nothing about conflict granularity.
