# Tooling and infra / RPC providers
URLs: https://docs.monad.xyz/tooling-and-infra , https://docs.monad.xyz/tooling-and-infra/rpc-providers , https://docs.monad.xyz/developer-essentials/testnet
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

The rpc-providers page (as fetched) lists 18 providers with links only, NO endpoint URLs, rate limits or debug-method support: Alchemy, Ankr, Blockdaemon, BlockPI, BoltRPC, Chainstack, dRPC NodeCloud, Dwellir, Envio, GetBlock, Node101, OnFinality, Quicknode, Spectrum, Tatum, thirdweb, Triton One, Validation Cloud. The docs do not say which allow debug_traceTransaction.

Public testnet endpoints (testnet page; chain id 10143, symbol MON; reset from genesis 2025-12-16, v0.15.2 / MONAD_NINE):

| Provider | URL | Limits | Notes |
|---|---|---|---|
| QuickNode | https://testnet-rpc.monad.xyz | 50 rps; 25 rps for eth_call and eth_estimateGas | batch 100, archive. Per docs/verification.md: debug_traceCall + prestateTracer works live here |
| Ankr | https://rpc.ankr.com/monad_testnet | 300 req/10 s, 12000 req/10 min | batch 100, no archive. docs/verification.md: forbids debug_* |
| Monad Foundation | https://rpc-testnet.monadinfra.com | 20 rps | archive, batch not allowed |

Mainnet RPC (verify page): https://rpc.monad.xyz (chain id 143). Sponsor RPCs (Quicknode, Dwellir, Spectrum, BlockVision, Alchemy rpc1.monad.xyz) are not confirmed for trace support; needs a key to test.
