import type { ChainId, Receipt } from '../types.js';
import { ReceiptStore } from './store.js';

/**
 * The most recent receipts, newest first, with amendments already applied.
 *
 * This is the read side used by `readset_status` and by the viem wrapper's breaker display.
 * `list()` returns receipts chronologically; callers here want newest first, so we reverse
 * after taking the tail.
 */
export function recentReceipts(
  input: { limit?: number; chainId?: ChainId; root?: string } = {},
): Receipt[] {
  const limit = input.limit ?? 20;
  const store = new ReceiptStore({ root: input.root, chainId: input.chainId });
  const rows = store.list({ limit });
  return [...rows].reverse();
}
