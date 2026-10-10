// The Gate, step 4: pick the gas limit to sign.
//
// CREDIT: the question "what limit should you actually set on Monad?" was researched and answered by
// Category Labs in "Setting your gas limit on Monad"
// (https://www.category.xyz/blogs/setting-your-gas-limit-on-monad). Their measurements are the reason
// this is a deliberate step at all: over 8.15M Monad transactions (12-18 Jan 2026) they found 6.0% failed
// and only 0.58 points of that was out-of-gas, and they showed that "`gas_used` is trivially set to
// `gas_limit` on Monad in the transaction receipt at the top call level", so a receipt cannot tell you what
// the code really needed (both quotes re-checked in docs/facts.md #2, #3).
//
// Readset makes NO claim to improve on their buffer research. This function is the plain, boring policy:
// simulated gas plus a configurable percentage, clamped to Monad's limits. Where their dynamic buffer is
// available, prefer it and pass the result in as `simulatedGas`/`bufferPct`.
//
// Why the buffer has to be paid for honestly: Monad charges gas_limit x price (docs/facts.md #1a), so
// every unused point of buffer is money spent. A bigger buffer is not free insurance.

/** Monad's per-transaction gas limit (docs.monad.xyz/developer-essentials/gas-pricing: "tx gas limit 30M"). */
export const MONAD_TX_GAS_LIMIT = 30_000_000n;

/** Intrinsic cost of the cheapest transaction; no limit below this can be included. */
export const MIN_TX_GAS = 21_000n;

export interface ChooseGasLimitOptions {
  /** Percent added over simulated gas. Default 20. May be fractional (e.g. 12.5). */
  bufferPct?: number;
  /** Hard ceiling; default Monad's 30M per-tx limit. */
  maxGas?: bigint;
  /** Floor; default 21000. */
  minGas?: bigint;
}

/**
 * simulated gas + buffer, clamped to [minGas, maxGas].
 *
 * `simulatedGas` must come from a real `eth_estimateGas` (see simulate.ts); passing 0 or a negative number
 * is an error rather than a silent default, because a wrong limit is paid for in full on Monad.
 */
export function chooseGasLimit(simulatedGas: bigint, opts: ChooseGasLimitOptions = {}): bigint {
  if (simulatedGas <= 0n) {
    throw new Error('chooseGasLimit: simulatedGas must be positive (simulate the tx first; do not guess a limit)');
  }
  const bufferPct = opts.bufferPct ?? 20;
  if (!Number.isFinite(bufferPct) || bufferPct < 0) {
    throw new Error(`chooseGasLimit: bufferPct must be a finite number >= 0, got ${bufferPct}`);
  }
  const maxGas = opts.maxGas ?? MONAD_TX_GAS_LIMIT;
  const minGas = opts.minGas ?? MIN_TX_GAS;
  if (minGas > maxGas) throw new Error(`chooseGasLimit: minGas ${minGas} exceeds maxGas ${maxGas}`);

  // Scale by 1e6 so a fractional percent stays exact in integer arithmetic; round up, never down.
  const scale = 1_000_000n;
  const factor = scale + BigInt(Math.round(bufferPct * 10_000));
  const withBuffer = (simulatedGas * factor + scale - 1n) / scale;

  if (withBuffer < minGas) return minGas;
  if (withBuffer > maxGas) return maxGas;
  return withBuffer;
}
