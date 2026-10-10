/**
 * @readset/plugin — the Readset decision path for the MetaMask Agent Wallet CLI (`mm`).
 *
 * WHAT THIS CAN AND CANNOT DO (verified in docs/kill-tests/K3.md):
 * Agent Wallet plugins are oclif command packages, and the host REJECTS a package that declares
 * `oclif.hooks`. There is no interception point, so Readset cannot sit in front of an agent's
 * `mm transfer`. What it offers instead is `mm readset safe-submit`, which an agent calls in
 * place of a raw send. That is cooperative, not enforced: an agent that calls `mm transfer`
 * directly bypasses Readset entirely. Say so plainly rather than implying a guarantee.
 *
 * Every rule lives in @readset/core, so this plugin, the viem wrapper and the MCP server refuse
 * for the same reasons and write the same receipts.
 */
export { decide, attachHash, type Decision, type DecideInput } from './decide.js';
export { buildTx, type BuildTxInput } from './tx.js';
