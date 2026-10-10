# Verification of PRD claims

Date 2026-10-06. forge 1.6.0-nightly (157a971, 2026-04-23), OpenZeppelin
contracts 5.7.0, Monad client category-labs/monad `main` @ e7143ff.
Verdicts: VERIFIED / PARTIALLY / FALSE / UNVERIFIED.

| # | Claim | Verdict | Evidence | Consequence for Hotslot |
|---|---|---|---|---|
| 1 | Monad is optimistic and parallel; re-executes txs whose inputs were invalidated by earlier txs (§4) | VERIFIED | https://docs.monad.xyz/monad-arch/execution/parallel-execution.md ; `BlockState::can_merge`, category/execution/ethereum/state2/block_state.cpp | Keep the OCC framing. |
| 2 | Conflict = read(j) ∩ write(i) (§4) | PARTIALLY | `State::set_storage` loads the original slot value into `original_` before every SSTORE, so writes are also observations. §16's formula (with write-write) is the right superset. | Define conflict as observed(j) ∩ netwrite(i). Fix §4 wording. |
| 3 | Granularity is the storage slot | PARTIALLY | Storage compared per (address,key) by VALUE. Accounts compared as a whole `Account` record (nonce, balance, code_hash, incarnation): `account != it->second.account.second`. | Add account-level pseudo-slots (rows 4-5). |
| 4 | Only storage slots matter (implicit) | FALSE | Same-sender txs conflict via nonce (`set_nonce(sender, n+1)`, execute_transaction.cpp ~72). Any balance change to an account is a conflict: `add_to_balance` snapshots the account into `original_`. Relaxed balance merge (`try_fix_account_mismatch`) exists but `relaxed_validation` defaults to false and is not enabled where State is constructed (execute_transaction.cpp ~458, ~484). Testnet binary not diffed. | Add pseudo-slots `acct:<addr>` for sender nonce and for every native-value recipient (incl. payable contracts). Workloads must use distinct senders, or same-sender edges appear (real behaviour). New lint rule: payable hot sink. |
| 5 | Coinbase / fee recipient is a conflict source | FALSE | Priority fee credited in `execute_final`, which runs after `can_merge` succeeds (execute_transaction.cpp ~410; also `staking::collect_priority_fee`). Sender gas refund likewise. | Do not model coinbase. |
| 6 | Every written slot (as reported by vm.accesses) is a conflicting write | FALSE | `can_merge` compares the observed value to the committed value; `merge` stores final slot values only. A write that restores or equals the old value does not invalidate readers. | Write set must be NET value changes: values before vs after the tx (vm.load, or prestateTracer diffMode). |
| 7 | OZ ReentrancyGuard writes one shared slot per guarded call, ENTERED at entry, NOT_ENTERED at exit | VERIFIED (as a fact about the code) | lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol: slot constant `0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00` (ERC-7201), NOT_ENTERED=1, ENTERED=2, entry `SSTORE 2`, exit `SSTORE 1`; package.json 5.7.0. Foundry: guard slot value 1 before, 1 after one call. | The PRD's example "slot 0x…0003" is illustrative; the real slot is the namespaced constant. Lint must match it plus hand-rolled `_status` slots. |
| 8 | "...so it serialises the entire contract" (§1, §12, §20) | FALSE per client source; UNVERIFIED on chain | Net committed value of the guard slot is unchanged (1 → 2 → 1), so a later tx's observed value (1) equals the committed value (1) and `can_merge` passes. No on-chain throughput measurement was made; testnet is v0.15.2 vs source `main`. | **Headline claim must change.** Classify the guard as "gas only, no parallel penalty". Report it as a myth-busting finding, ideally with a testnet measurement (N distinct senders calling a nonReentrant function vs a shared counter). A vm.accesses-only Hotslot would false-positive here. |
| 9 | ReentrancyGuardTransient uses transient slots; Monad treats them as per-tx | VERIFIED (source), no docs | `AccountState::transient_storage_` lives in the per-tx `State` (state3/account_state.hpp); `BlockState::merge` copies only `account_` and `storage_` (block_state.cpp). Docs have no page on transient storage. Foundry vm.accesses records nothing for TSTORE. | Both guards are conflict-neutral; they differ only in gas. |
| 10 | `vm.record()` and `vm.accesses(address)` signatures | VERIFIED | lib/forge-std/src/Vm.sol:871 `function record() external;` and :753 `function accesses(address target) external view returns (bytes32[] memory readSlots, bytes32[] memory writeSlots);` | Use as in PRD §5.1. |
| 11 | reads = SLOADed, writes = SSTOREd; written slots also appear in reads | VERIFIED | Probe: onlyRead reads=[0] writes=[]; `b=5` reads=[1] writes=[1]; `c=c+1` reads=[2,2] writes=[2]. SSTORE adds a read entry. Lists contain duplicates (two calls: reads=[1,2,2] writes=[1,2]). | Dedupe. pure-read = reads minus writes. |
| 12 | Same-value / no-op SSTOREs | FINDING | Setting b=5 when b==5 still recorded (1 read, 1 write). A guard call recorded as a write while its value is unchanged. (`a = a` was removed by the optimiser: nothing recorded.) | vm.accesses over-reports writes relative to Monad's value-based check; compute net writes. |
| 13 | Recording covers nested calls; filter is per address | VERIFIED | `callOther`: accesses(t) reads [5,0] writes [0]; accesses(o) reads [1] writes [1]. An address never called returns empty. A repeated `accesses` on an address already queried returned 0/0, so results appear to be consumed on read. | Harness: vm.record() before each tx; call accesses once per address of interest (contract plus callees). |
| 14 | A write inside a reverted call is recorded | VERIFIED (empirical) | `writeThenRevert` in try/catch: reads=[1] writes=[1]; nested via `tryRevert`: same. | Reverted-frame writes inflate the write set; another reason to use before/after values. |
| 15 | Mapping slots are keccak-derived | VERIFIED | `m[0xBEEF]` recorded slot 19390803…148106 (keccak256(key . 3)), a single read and write. | Per-caller mapping entries are disjoint; attribute via storage layout. |
| 16 | Testnet facts | VERIFIED | https://docs.monad.xyz/developer-essentials/testnet.md: chain id 10143, token MON, RPC https://testnet-rpc.monad.xyz (QuickNode, 50 rps, 25 rps eth_call), https://rpc-testnet.monadinfra.com (Foundation, 20 rps), faucet https://faucet.monad.xyz, explorers https://testnet.monadvision.com and https://testnet.monadscan.com. Live: eth_chainId → 0x279f (10143); net_version → 10143. Testnet reset 2025-12-16; v0.15.2 / MONAD_NINE. Mainnet chain id 143. | Config defaults. |
| 17 | Block time and gas | VERIFIED | Docs changelog: block time 400 ms; txs charged by gas LIMIT. Live block gasLimit 0x8f0d180 = 150,000,000. 34 blocks seen in about 10 s. | Remember gas-limit charging in any gas comparison. |
| 18 | `eth_createAccessList` on the public RPC | VERIFIED | Docs: supported, "Storage keys deduplicated by page". Live: WMON.balanceOf(0x..01) → `{"accessList":[{"address":"0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541","storageKeys":["0xa15bc60c955c405d20d9149c709e2460f1c2d9a497496a7f46004d1772c3054c"]}],"gasUsed":"0x657e"}`; EOA→precompile call → `[]`. | Label as a conservative union; it has no read/write split or values. |
| 19 | `debug_traceTransaction` / `prestateTracer` | PARTIALLY | Docs: debug_traceTransaction and debug_traceCall supported, options parameter required, no opcode struct logs; Ankr forbids `debug_*`. Live on testnet-rpc.monad.xyz: `debug_traceCall` + prestateTracer returned `pre` incl. `storage` (key a15bc6… = 0); with `diffMode` returned `pre` and `post` (WMON deposit: post storage value 1); callTracer works; `debug_traceTransaction` is recognised (unknown hash → "transaction not found"). A successful trace of a real mined tx was not run. | Primary remote path: prestateTracer diffMode gives true before/after values and so net(i). Prefer it over access lists. |
| 20 | Alchemy supports these methods | UNVERIFIED | No API key available. Docs list Alchemy (rpc1.monad.xyz) with 200M eth_call gas and a 1,000-block getLogs range; nothing on trace methods. | Test with the user's key before claiming. |
| 21 | Testnet binary matches the `main` source analysed | UNVERIFIED | Source is `main` @ e7143ff; testnet is v0.15.2. Not diffed. | Row 8 needs a testnet measurement before publication. |

## Probe output (forge 1.6.0-nightly, optimiser on; throwaway test deleted)

```
onlyRead reads=[0] writes=[]
onlyWrite(b=5) reads=[1] writes=[1]
rw(c=c+1) reads=[2,2] writes=[2]
z=0 (noop zero) reads=[4] writes=[4]
a=a (noop) reads=[] writes=[]            (SSTORE elided by solc)
revertedCall reads=[1] writes=[1]
tryRevert(nested revert) reads=[1] writes=[1]
callOther: t reads=[5,0] writes=[0]
callOther: o reads=[1] writes=[1]
tstore reads=[] writes=[]
two calls accumulate reads=[1,2,2] writes=[1,2]
OZ ReentrancyGuard.f  guard slot 0x9b77..5f00 in 3 reads and 2 writes, plus x
OZ ReentrancyGuardTransient.f reads=[0] writes=[0]   (only x; no guard slot)
same-value write: reads/writes 1 1
guard before 1 / guard after 1 ; reads/writes 5 3 (incl. x)
other addr reads/writes 0 0
```

## Design changes required

1. Write set = net value change across the tx (vm.load before/after for the Foundry path; prestateTracer diffMode for the RPC path), not SSTORE occurrences.
2. Observed set = reads ∪ writes.
3. Add account pseudo-slots: sender nonce, native-value recipients, payable contracts. Exclude coinbase.
4. Reentrancy rule: downgrade from CRITICAL to INFO ("gas only, no parallel penalty") for both OZ guards; keep CRITICAL only for locks that do not restore. Rewrite PRD §1, §12, §20 headline; replace with a measured result.
5. State in docs that efficiency is a proxy (re-execution, not serial rounds) and that edges are conservative.
