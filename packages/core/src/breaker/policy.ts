// Breaker policy: schema, defaults, and load/save from <root>/policy.json.
//
// Agent Wallet policies gate WHAT an agent may do. This policy gates WHETHER a send is worth doing
// now: how many failures in a row, how much wasted gas per hour, and the same two limits scoped to
// a single (to, selector) pair.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Hex, PerTargetPolicy, Policy } from '../types.js';
import { defaultRoot } from '../receipt/store.js';

/** 1 MON. Measured mean burn per failed mainnet tx is ~0.2 MON (docs/facts.md), so this is ~5 failures. */
export const DEFAULT_MAX_BURN_PER_HOUR_WEI = '1000000000000000000';

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte 0x address')
  .transform((v) => v.toLowerCase() as Hex);

const selectorSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, 'expected a 4-byte 0x selector')
  .transform((v) => v.toLowerCase() as Hex);

/** Decimal wei, as a string: wei does not fit a double. */
const weiSchema = z.string().regex(/^\d+$/, 'expected decimal wei as a string');

export const PerTargetPolicySchema = z.object({
  to: addressSchema,
  selector: selectorSchema.optional(),
  maxConsecutiveReverts: z.number().int().min(1).optional(),
  maxBurnPerHourWei: weiSchema.optional(),
});

export const PolicySchema = z.object({
  maxConsecutiveReverts: z.number().int().min(1).default(5),
  maxBurnPerHourWei: weiSchema.default(DEFAULT_MAX_BURN_PER_HOUR_WEI),
  perTarget: z.array(PerTargetPolicySchema).default([]),
  /** Flat buffer over simulated gas. Category Labs' per-(to, selector) buffer is the better source. */
  gasBufferPct: z.number().min(0).max(1000).default(20),
  /** Refuse to send when simulation infra errors rather than sending blind. */
  failClosed: z.boolean().default(true),
  /**
   * What a reverting simulation DOES, measured rather than assumed (docs/benchmark.md).
   *
   * On a 1,207-tx mainnet sample, refusing on any revert at `latest` would have wrongly refused
   * 8.53% of txs that actually succeeded: their precondition was written by an earlier tx in
   * their own block, which `latest` does not have yet. Requiring the revert to reproduce three
   * blocks back halves that to 4.31% (4.3-7.5% once unmeasurable cases are bounded) and costs
   * almost no detection, because knowable burn is 36.41% at N-1 and 36.34% at N-3.
   *
   * Even 4% is too high to block an agent's traffic by default, so the default is `warn`:
   * write the receipt, feed the breaker, and let the send through. Hard refusal is opt-in,
   * per target, where the operator knows the cost of a wasted send beats a missed one.
   *
   *  - 'warn'   : never refuse on a revert; record it and let the breaker catch repetition.
   *  - 'stable' : refuse only when the revert reproduces at an older block too.
   *  - 'any'    : refuse on any reverting simulation (highest false-refusal rate).
   */
  refuseOnRevert: z.enum(['warn', 'stable', 'any']).default('warn'),
  /** How many blocks back `refuseOnRevert: 'stable'` re-checks. 3 is what docs/benchmark.md measured. */
  stableRevertLookback: z.number().int().min(1).max(32).default(3),
});

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

/** Validates and normalises (addresses/selectors lowercased, defaults filled). Throws on bad input. */
export function parsePolicy(input: unknown): Policy {
  return PolicySchema.parse(input ?? {});
}

export function policyPath(root?: string): string {
  return path.join(path.resolve(root ?? defaultRoot()), 'policy.json');
}

export interface PolicyFileOptions {
  root?: string;
  /** Default: fall back to DEFAULT_POLICY when the file is missing. */
  createIfMissing?: boolean;
}

/** Reads <root>/policy.json, or DEFAULT_POLICY when absent. A malformed file throws. */
export function loadPolicy(opts: PolicyFileOptions = {}): Policy {
  const file = policyPath(opts.root);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    if (opts.createIfMissing) savePolicy(DEFAULT_POLICY, opts);
    return DEFAULT_POLICY;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parsePolicy(json);
}

export function savePolicy(policy: Policy, opts: PolicyFileOptions = {}): Policy {
  const normalised = parsePolicy(policy);
  const file = policyPath(opts.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8');
  return normalised;
}

/** Counter key for a (to, selector) pair. `create` for a deployment, `*` for "any selector". */
export type TargetKey = string;

export function targetKey(to: Hex | null | undefined, selector?: Hex | null): TargetKey {
  const addr = to === null || to === undefined ? 'create' : to.toLowerCase();
  return `${addr}:${selector ? selector.toLowerCase() : '*'}`;
}

/** The 4-byte selector of a calldata blob, or undefined when there is none. */
export function selectorOf(data?: Hex | null): Hex | undefined {
  if (!data || data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase() as Hex;
}

/**
 * Counter keys a (to, selector) send belongs to: the exact pair, plus the `to:*` aggregate when a
 * selector is known. Per-target limits therefore isolate targets but can still be written per
 * address only.
 */
export function targetKeysFor(to: Hex | null | undefined, selector?: Hex | null): TargetKey[] {
  const wildcard = targetKey(to, null);
  if (!selector) return [wildcard];
  return [targetKey(to, selector), wildcard];
}

/** Policy entries that apply to a send, each with the counter key it is measured against. */
export function matchingTargets(
  policy: Policy,
  to: Hex | null | undefined,
  selector?: Hex | null,
): { entry: PerTargetPolicy; key: TargetKey }[] {
  if (to === null || to === undefined) return [];
  const addr = to.toLowerCase();
  const sel = selector?.toLowerCase();
  const out: { entry: PerTargetPolicy; key: TargetKey }[] = [];
  for (const entry of policy.perTarget) {
    if (entry.to.toLowerCase() !== addr) continue;
    if (entry.selector === undefined) {
      out.push({ entry, key: targetKey(to, null) });
    } else if (sel !== undefined && entry.selector.toLowerCase() === sel) {
      out.push({ entry, key: targetKey(to, sel as Hex) });
    }
  }
  return out;
}
