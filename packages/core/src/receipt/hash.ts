// Canonical JSON + sha256 content addressing for dependency receipts.
//
// Rules (frozen; changing any of them changes every id):
//  - object keys are sorted by Unicode code point, recursively;
//  - keys whose value is `undefined` are dropped (they are absent in JSON anyway);
//  - bigint is serialised as a decimal string, so 1n and "1" hash alike and no precision is lost;
//  - numbers must be finite; non-integer numbers are allowed but discouraged in hashed content;
//  - Date is serialised as its ISO string; Uint8Array as 0x-hex;
//  - no whitespace, so the canonical form is byte-stable.

import { createHash } from 'node:crypto';
import type { Policy, Receipt } from '../types.js';

/** Keys that must never reach a receipt, a store or a hash. */
export const FORBIDDEN_KEYS = [
  'privatekey',
  'private_key',
  'privkey',
  'secret',
  'secretkey',
  'mnemonic',
  'seedphrase',
  'seed_phrase',
  'signedtx',
  'signedtransaction',
  'rawtransaction',
  'rawtx',
  'serializedtransaction',
  'signature',
] as const;

/** Throws if `value` contains a key that looks like a private key or a raw signed payload. */
export function assertNoSecrets(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const norm = k.toLowerCase().replace(/[-\s]/g, '');
    if ((FORBIDDEN_KEYS as readonly string[]).includes(norm)) {
      throw new Error(`receipt content may not contain secret-bearing key "${k}" at ${path}`);
    }
    assertNoSecrets(v, `${path}.${k}`);
  }
}

function canon(value: unknown, out: string[], path: string): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'bigint':
      out.push(JSON.stringify(value.toString(10)));
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`cannot canonicalise non-finite number at ${path}`);
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new Error(`cannot canonicalise ${typeof value} at ${path}`);
  }
  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(JSON.stringify(`0x${Buffer.from(value).toString('hex')}`));
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    value.forEach((v, i) => {
      if (i > 0) out.push(',');
      canon(v === undefined ? null : v, out, `${path}[${i}]`);
    });
    out.push(']');
    return;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  out.push('{');
  keys.forEach((k, i) => {
    if (i > 0) out.push(',');
    out.push(JSON.stringify(k), ':');
    canon(rec[k], out, `${path}.${k}`);
  });
  out.push('}');
}

/** Deterministic JSON text for any receipt-shaped value. Same content, same bytes. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  canon(value, out, '$');
  return out.join('');
}

/** JSON.stringify replacement used when persisting (bigint-safe, key order as given). */
export function toJsonLine(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v));
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Fields bound by `Receipt.id`. `txHash` and `outcome` are post-decision facts (see amendments). */
export const RECEIPT_ID_FIELDS = [
  'version',
  'createdAt',
  'chainId',
  'tx',
  'verdict',
  'doomed',
  'dependencySet',
  'policyHash',
] as const;

export type ReceiptCore = Omit<Receipt, 'id' | 'txHash' | 'outcome'>;

/** The subset of a receipt that its id commits to, with nothing else along for the ride. */
export function receiptCore(r: ReceiptCore | Receipt): Record<string, unknown> {
  const src = r as unknown as Record<string, unknown>;
  const core: Record<string, unknown> = {};
  for (const k of RECEIPT_ID_FIELDS) if (src[k] !== undefined) core[k] = src[k];
  assertNoSecrets(core);
  return core;
}

/** sha256 of the canonical core, lowercase hex, no prefix. Deterministic across processes. */
export function receiptId(r: ReceiptCore | Receipt): string {
  return sha256Hex(canonicalJson(receiptCore(r)));
}

/** sha256 of the canonical policy. Receipts store this so a verdict can be tied to the rules in force. */
export function policyHash(policy: Policy): string {
  return sha256Hex(canonicalJson(policy as unknown));
}

export interface VerifyResult {
  ok: boolean;
  /** The id recorded on the receipt. */
  id: string;
  /** The id recomputed from its content. */
  expected: string;
  reason?: string;
}

/** Recomputes `Receipt.id` from content; `ok: false` means the record was altered. */
export function verifyReceipt(r: Receipt): VerifyResult {
  let expected: string;
  try {
    expected = receiptId(r);
  } catch (e) {
    return { ok: false, id: r?.id ?? '', expected: '', reason: (e as Error).message };
  }
  const id = r.id ?? '';
  if (id === expected) return { ok: true, id, expected };
  return { ok: false, id, expected, reason: 'content does not hash to the recorded id' };
}

/** Throws unless the receipt's id matches its content. */
export function assertReceiptIntact(r: Receipt): Receipt {
  const v = verifyReceipt(r);
  if (!v.ok) throw new Error(`receipt ${v.id || '(no id)'} failed verification: ${v.reason} (expected ${v.expected})`);
  return r;
}
