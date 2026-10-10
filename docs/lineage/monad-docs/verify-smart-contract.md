# Verify a smart contract (Foundry)
URLs: https://docs.monad.xyz/guides/verify-smart-contract/index , .../foundry
> Fetched 2026-10-06 via WebFetch (page converted to markdown, then condensed by a small model). Quotes are as returned by that pass; re-check against the live page before citing in a submission.

Testnet (10143), MonadVision via Sourcify:
```sh
forge verify-contract <contract_address> <contract_name> --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```
Testnet, Monadscan via Etherscan:
```sh
forge verify-contract <contract_address> <contract_name> --chain 10143 \
  --verifier etherscan --etherscan-api-key YourApiKeyToken --watch
```
Mainnet is identical with `--chain 143`. RPCs: https://rpc.monad.xyz (mainnet), https://testnet-rpc.monad.xyz (testnet). Explorers (docs/verification.md): https://testnet.monadvision.com, https://testnet.monadscan.com.
