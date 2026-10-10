import fs from 'node:fs';
import path from 'node:path';
import { encodeAbiParameters, keccak256 } from 'viem';
import { compileSources, type CompiledProject, type StorageLayoutType } from './compile.js';
import type { Hex } from '../types.js';

/** Key of a storage slot: `<lowercase address>:<0x slot>` or `<address>:account`. */
export type SlotKey = string;

/**
 * Slot labelling: SlotKey -> human label using solc storage layouts.
 *
 * Resolution limits (documented, not hidden):
 *  - Base variables, struct members, static array elements, dynamic array length and elements, and the
 *    ERC-7201 OpenZeppelin ReentrancyGuard slot resolve exactly (no guessing).
 *  - Mapping entries live at keccak(pad(key) ++ pad(baseSlot)); a hash cannot be inverted, so entries are matched by
 *    brute force against CANDIDATE keys only: the workload's caller addresses (`accounts`) for address/contract keys and
 *    the small integers 0..`maxInt` (default 255) for uint/int/enum keys (bool: 0 and 1). Nested mappings try the
 *    candidate set at every level. string/bytes/bytesN keys are not enumerated.
 *  - Expansion is capped at `maxEntries` (default 400,000) derived slots; `labeler.truncated` reports a hit cap.
 *  - Unresolved storage slots are labelled `unresolved@<slot>`; a slot that does not belong to the labelled contract is
 *    labelled `<addr>:<slot>`.
 */

export const REENTRANCY_GUARD_SLOT: Hex = '0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00';
export const REENTRANCY_GUARD_LABEL = 'ReentrancyGuard._status (namespaced)';

export interface SlotLabelerOptions {
  /** Foundry project dir (compiled with src/lint). Either this or `compiled`. */
  projectDir?: string;
  /** Explicit root .sol file (absolute or relative to projectDir); default: searched by contract name under projectDir. */
  file?: string;
  /** Already-compiled project (from compileSources). */
  compiled?: CompiledProject;
  contractName: string;
  address: Hex;
  /** Candidate mapping keys (addresses): typically all `caller`s of the workload. */
  accounts?: Hex[];
  /** Largest candidate integer key (default 255). */
  maxInt?: number;
  /** Cap on derived slots (default 400000). */
  maxEntries?: number;
}

export interface SlotLabeler {
  label(slot: SlotKey): string;
  /** True when the mapping expansion hit `maxEntries` (some entries may be unlabelled). */
  readonly truncated: boolean;
}

interface Range {
  base: bigint;
  label: string;
  elem: string; // type id of the element
  kind: 'array' | 'bytes';
}

const MASK = (1n << 256n) - 1n;
const h32 = (n: bigint): Hex => `0x${(n & MASK).toString(16).padStart(64, '0')}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrWord = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;

function splitKey(k: SlotKey): { addr: string; slot: string } {
  const i = k.indexOf(':');
  return { addr: k.slice(0, i).toLowerCase(), slot: k.slice(i + 1) };
}

function findSolFile(dir: string, name: string): string | undefined {
  const skip = new Set(['lib', 'out', 'node_modules', 'cache', '.git', 'test', 'script', 'broadcast']);
  const re = new RegExp(`\\b(contract|abstract\\s+contract)\\s+${name}\\b`);
  const walk = (d: string): string | undefined => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        const r = walk(p);
        if (r) return r;
      } else if (e.name.endsWith('.sol') && re.test(fs.readFileSync(p, 'utf8'))) return p;
    }
    return undefined;
  };
  return walk(dir);
}

export async function buildSlotLabeler(opts: SlotLabelerOptions): Promise<SlotLabeler> {
  let compiled = opts.compiled;
  if (!compiled) {
    if (!opts.projectDir) throw new Error('buildSlotLabeler: provide `projectDir` or `compiled`');
    const dir = path.resolve(opts.projectDir);
    const file = opts.file ?? findSolFile(dir, opts.contractName);
    if (!file) throw new Error(`buildSlotLabeler: no .sol file declaring contract ${opts.contractName} under ${dir}`);
    compiled = await compileSources({ files: [file], basePath: dir });
  }
  const candidates = compiled.contracts.filter((c) => c.name === opts.contractName);
  if (candidates.length === 0) throw new Error(`buildSlotLabeler: contract ${opts.contractName} not found in compiled output`);
  const roots = new Set(compiled.sources.filter((s) => s.isRoot).map((s) => s.name));
  const c = candidates.find((x) => roots.has(x.sourceName)) ?? candidates[0]!;
  return labelerFromLayout(c.storageLayout, opts);
}

/** Pure labeller over a solc storage layout (no compilation). */
export function labelerFromLayout(
  layout: { storage: Array<{ label: string; slot: string; offset: number; type: string }>; types: Record<string, StorageLayoutType> | null },
  opts: Pick<SlotLabelerOptions, 'address' | 'accounts' | 'maxInt' | 'maxEntries'>,
): SlotLabeler {
  const types = layout.types ?? {};
  const address = opts.address.toLowerCase();
  const accounts = [...new Set((opts.accounts ?? []).map((a) => a.toLowerCase()))].sort();
  const maxInt = opts.maxInt ?? 255;
  const maxEntries = opts.maxEntries ?? 400_000;

  const table = new Map<bigint, string[]>();
  const ranges: Range[] = [];
  let entries = 0;
  let truncated = false;

  const add = (slot: bigint, label: string) => {
    const k = slot & MASK;
    const cur = table.get(k);
    if (!cur) table.set(k, [label]);
    else if (!cur.includes(label)) cur.push(label);
  };

  const sizeOf = (t: string) => Number(types[t]?.numberOfBytes ?? 32);

  const keyCandidates = (keyType: string): Array<{ word: Hex; display: string }> => {
    const kl = types[keyType]?.label ?? keyType;
    if (kl === 'address' || kl.startsWith('address ') || kl.startsWith('contract ') || kl === 'address payable')
      return accounts.map((a) => ({ word: addrWord(a), display: short(a) }));
    if (kl === 'bool')
      return [
        { word: h32(0n), display: 'false' },
        { word: h32(1n), display: 'true' },
      ];
    if (/^u?int\d*$/.test(kl) || kl.startsWith('enum ')) {
      const out: Array<{ word: Hex; display: string }> = [];
      for (let i = 0; i <= maxInt; i++) out.push({ word: h32(BigInt(i)), display: String(i) });
      return out;
    }
    return [];
  };

  const expand = (slot: bigint, typeId: string, label: string): void => {
    if (entries > maxEntries) {
      truncated = true;
      return;
    }
    entries++;
    const t = types[typeId];
    if (!t) {
      add(slot, label);
      return;
    }
    if (t.encoding === 'mapping') {
      for (const k of keyCandidates(t.key!)) {
        const derived = BigInt(
          keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [k.word, h32(slot)])),
        );
        expand(derived, t.value!, `${label}[${k.display}]`);
      }
      return;
    }
    if (t.encoding === 'dynamic_array') {
      add(slot, `${label}.length`);
      ranges.push({ base: BigInt(keccak256(h32(slot))), label, elem: t.base!, kind: 'array' });
      return;
    }
    if (t.encoding === 'bytes') {
      add(slot, label);
      ranges.push({ base: BigInt(keccak256(h32(slot))), label, elem: '', kind: 'bytes' });
      return;
    }
    if (t.members) {
      for (const m of t.members) expand(slot + BigInt(m.slot), m.type, `${label}.${m.label}`);
      return;
    }
    if (t.base) {
      // static array
      const b = sizeOf(t.base);
      const total = Number(t.numberOfBytes);
      const per = b < 32 ? Math.floor(32 / b) : 1;
      const slotsPer = b >= 32 ? Math.ceil(b / 32) : 1;
      const count = b >= 32 ? total / b : Math.ceil(total / b);
      if (count > 1024) {
        add(slot, `${label}[0..${count - 1}]`);
        return;
      }
      for (let i = 0; i < count; i += per)
        expand(slot + BigInt((i / per) * slotsPer), t.base, per > 1 ? `${label}[${i}..${Math.min(i + per, count) - 1}]` : `${label}[${i}]`);
      return;
    }
    add(slot, label);
  };

  for (const v of layout.storage) expand(BigInt(v.slot), v.type, v.label);
  add(BigInt(REENTRANCY_GUARD_SLOT), REENTRANCY_GUARD_LABEL);

  const rangeLabel = (r: Range, delta: bigint): string | undefined => {
    if (delta < 0n || delta >= 1n << 40n) return undefined;
    if (r.kind === 'bytes') return `${r.label}.data[+${delta}]`;
    const et = types[r.elem];
    const b = sizeOf(r.elem);
    if (et?.members) {
      const elemSlots = Math.max(1, Math.ceil(b / 32));
      const idx = delta / BigInt(elemSlots);
      const rem = Number(delta % BigInt(elemSlots));
      let best: { label: string; slot: number } | undefined;
      for (const m of et.members) if (Number(m.slot) <= rem && (!best || Number(m.slot) >= best.slot)) best = { label: m.label, slot: Number(m.slot) };
      return `${r.label}[${idx}]${best ? '.' + best.label : ''}`;
    }
    if (b >= 32) return `${r.label}[${delta / BigInt(Math.ceil(b / 32))}]`;
    const per = BigInt(Math.floor(32 / b));
    return `${r.label}[${delta * per}..${delta * per + per - 1n}]`;
  };

  return {
    get truncated() {
      return truncated;
    },
    label(key: SlotKey): string {
      const { addr, slot } = splitKey(key);
      if (slot === 'account') return `account(${short(addr)}) nonce/balance`;
      let n: bigint;
      try {
        n = BigInt(slot);
      } catch {
        return key;
      }
      if (addr !== address && n !== BigInt(REENTRANCY_GUARD_SLOT)) return `${short(addr)}:${slot}`;
      if (addr !== address) return `${short(addr)}:${REENTRANCY_GUARD_LABEL}`;
      const hit = table.get(n);
      if (hit) return hit.join(' / ');
      for (const r of ranges) {
        const l = rangeLabel(r, n - r.base);
        if (l) return l;
      }
      return `unresolved@${slot}`;
    },
  };
}
