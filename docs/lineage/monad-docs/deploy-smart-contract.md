# Deploy a smart contract (Foundry)
URLs: https://docs.monad.xyz/guides/deploy-smart-contract/index , .../foundry
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

The index page only links to the Foundry guide. Foundry guide: RPC https://testnet-rpc.monad.xyz, chain id 10143, `network = monad` in foundry.toml.

```sh
cast wallet import monad-deployer --private-key $(cast wallet new | grep 'Private key:' | awk '{print $3}')
cast wallet address --account monad-deployer
forge create src/Counter.sol:Counter --account monad-deployer --broadcast
# not recommended:
forge create --private-key <your_private_key> src/Counter.sol:Counter --broadcast
```
Quote: "Using a private key is not recommended. You should not be copying and pasting private keys into your terminal. Please use a keystore instead." No verification flags on this page; see verify-smart-contract.md. (forge create needs an RPC from foundry.toml or --rpc-url.)
