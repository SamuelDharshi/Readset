// Readset "Explain" component (PRD "How it works" #3 and the "Why your bot lost" page, #4).
//
// explainFailedTx(client, txHash) -> which dependency slot moved, who moved it, and whether it was
// knowable before sending. All evidence comes from real Monad RPC calls; see docs/explain.md.
//
// NOTE for the integration owner: packages/core/src/index.ts does not re-export this folder yet.
// Add `export * from './explain/index.js';` there to expose it from @readset/core.

export * from './failed-tx.js';
export * from './writers.js';
export * from './avoidable.js';
export * from './tx.js';
