// Append-only JSONL receipt store.
//
// Layout:  <root>/receipts/<chainId>/<YYYY-MM-DD>.jsonl      (root defaults to <cwd>/.readset)
// The day comes from the UTC date of the record's own `createdAt`, so files are time-ordered and
// `list({ since })` can skip whole files.
//
// Two record kinds share a file:
//   receipt    the Receipt object verbatim, no extra keys (so a line re-hashes to its own id)
//   amendment  { version, kind: 'amendment', id, receiptId, createdAt, chainId, patch }
// A line is an amendment iff it has a `kind` field. History is never rewritten: an outcome that
// arrives after the attempt is a new amendment line, and reads replay amendments over the receipt.
//
// Concurrency: every record is one `write(2)` on a file opened with O_APPEND, so two processes
// appending to the same file interleave by line and never tear one. A record whose UTF-8 encoding
// exceeds `MAX_RECORD_BYTES` is refused rather than written in pieces.

import fs from 'node:fs';
import path from 'node:path';
import type { ChainId, Hex, Receipt, Verdict } from '../types.js';
import { assertNoSecrets, assertReceiptIntact, canonicalJson, sha256Hex, toJsonLine, verifyReceipt } from './hash.js';

/** A single POSIX append is atomic for a write this size; larger records are rejected. */
export const MAX_RECORD_BYTES = 1024 * 1024;

export type AmendmentPatch = {
  txHash?: Hex;
  outcome?: NonNullable<Receipt['outcome']>;
};

export interface ReceiptAmendment {
  version: 1;
  kind: 'amendment';
  /** sha256 of the canonical amendment content (everything but `id`). */
  id: string;
  receiptId: string;
  createdAt: string;
  chainId: ChainId;
  patch: AmendmentPatch;
  /** Free-form note, e.g. 'outcome from eth_getTransactionReceipt'. */
  note?: string;
}

export type StoredRecord = Receipt | ReceiptAmendment;

export function isAmendment(r: StoredRecord): r is ReceiptAmendment {
  return (r as ReceiptAmendment).kind === 'amendment';
}

export function amendmentId(a: Omit<ReceiptAmendment, 'id'>): string {
  const { version, kind, receiptId, createdAt, chainId, patch, note } = a;
  return sha256Hex(canonicalJson({ version, kind, receiptId, createdAt, chainId, patch, note }));
}

export function verifyAmendment(a: ReceiptAmendment): boolean {
  const { id, ...rest } = a;
  return amendmentId(rest) === id;
}

export interface ReceiptStoreOptions {
  /** Base directory; default `READSET_HOME` or `<cwd>/.readset`. */
  root?: string;
  /** Restrict reads to one chain. Writes always use the record's own chainId. */
  chainId?: ChainId;
  /** Clock for amendment timestamps (tests inject it). */
  now?: () => Date;
}

export interface ListQuery {
  /** Inclusive lower bound on `createdAt`. */
  since?: Date | string;
  /** Exclusive upper bound on `createdAt`. */
  until?: Date | string;
  /** Keep the most recent N (result stays chronological). */
  limit?: number;
  verdict?: Verdict | Verdict[];
  /** Filter by sender. */
  from?: Hex;
  chainId?: ChainId;
}

export interface ScanStats {
  files: number;
  receipts: number;
  amendments: number;
  /** Lines that would not parse (a torn tail from a killed writer); skipped, never repaired. */
  malformed: number;
}

/**
 * Where receipts, the policy and breaker state live.
 *
 * Both names are honoured: READSET_HOME, and READSET_STATE_DIR which @readset/viem and the MCP
 * server already use. A test or a sandbox that sets either one must get real isolation —
 * silently falling back to <cwd>/.readset would rewrite the operator's live policy.
 */
export function defaultRoot(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const home = env.READSET_HOME?.trim() || env.READSET_STATE_DIR?.trim();
  return home ? path.resolve(home) : path.resolve(process.cwd(), '.readset');
}

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid createdAt: ${iso}`);
  return d.toISOString().slice(0, 10);
}

function toIso(v: Date | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();
}

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  records: StoredRecord[];
  malformed: number;
}

export class ReceiptStore {
  readonly root: string;
  readonly chainId?: ChainId;
  private readonly now: () => Date;
  private readonly cache = new Map<string, FileCacheEntry>();
  private lastStats: ScanStats = { files: 0, receipts: 0, amendments: 0, malformed: 0 };

  constructor(opts: ReceiptStoreOptions = {}) {
    this.root = path.resolve(opts.root ?? defaultRoot());
    this.chainId = opts.chainId;
    this.now = opts.now ?? (() => new Date());
  }

  get receiptsDir(): string {
    return path.join(this.root, 'receipts');
  }

  dirFor(chainId: ChainId): string {
    return path.join(this.receiptsDir, String(chainId));
  }

  fileFor(chainId: ChainId, createdAt: string): string {
    return path.join(this.dirFor(chainId), `${dayOf(createdAt)}.jsonl`);
  }

  /** Appends a receipt. Throws if its id does not match its content. */
  put(receipt: Receipt): Receipt {
    assertReceiptIntact(receipt);
    assertNoSecrets(receipt);
    this.append(this.fileFor(receipt.chainId, receipt.createdAt), receipt);
    return receipt;
  }

  /** Records a mined outcome for an earlier attempt as an appended amendment. */
  attachOutcome(id: string, outcome: NonNullable<Receipt['outcome']>, note?: string): Receipt {
    return this.amend(id, { outcome }, note);
  }

  /** Records the hash of a tx that was broadcast after the attempt was written. */
  attachTxHash(id: string, txHash: Hex, note?: string): Receipt {
    return this.amend(id, { txHash: txHash.toLowerCase() as Hex }, note);
  }

  /** Appends one amendment for `id` and returns the receipt with all amendments applied. */
  amend(id: string, patch: AmendmentPatch, note?: string): Receipt {
    const base = this.rawReceipt(id);
    if (!base) throw new Error(`no receipt ${id} under ${this.receiptsDir}`);
    if (patch.outcome === undefined && patch.txHash === undefined) throw new Error('amendment patch is empty');
    const createdAt = this.now().toISOString();
    const body: Omit<ReceiptAmendment, 'id'> = {
      version: 1,
      kind: 'amendment',
      receiptId: id,
      createdAt,
      chainId: base.chainId,
      patch,
      ...(note === undefined ? {} : { note }),
    };
    const rec: ReceiptAmendment = { ...body, id: amendmentId(body) };
    assertNoSecrets(rec);
    this.append(this.fileFor(base.chainId, createdAt), rec);
    return this.get(id)!;
  }

  /** The receipt with its amendments applied, or undefined. */
  get(id: string): Receipt | undefined {
    const { receipts, amendments } = this.index();
    const base = receipts.get(id);
    return base ? applyAmendments(base, amendments.get(id) ?? []) : undefined;
  }

  /** Receipt as written, without amendments. */
  rawReceipt(id: string): Receipt | undefined {
    return this.index().receipts.get(id);
  }

  amendmentsFor(id: string): ReceiptAmendment[] {
    return sortAmendments(this.index().amendments.get(id) ?? []);
  }

  /** Every receipt that carries this tx hash (chronological). Normally one. */
  byTxHash(txHash: Hex): Receipt[] {
    const want = txHash.toLowerCase();
    return this.list().filter((r) => r.txHash?.toLowerCase() === want);
  }

  /** Receipts with amendments applied, oldest first. */
  list(q: ListQuery = {}): Receipt[] {
    const since = toIso(q.since);
    const until = toIso(q.until);
    const verdicts = q.verdict === undefined ? undefined : new Set(Array.isArray(q.verdict) ? q.verdict : [q.verdict]);
    const from = q.from?.toLowerCase();
    const { receipts, amendments } = this.index({ chainId: q.chainId, sinceDay: since?.slice(0, 10) });
    let out: Receipt[] = [];
    for (const [id, base] of receipts) {
      if (since !== undefined && base.createdAt < since) continue;
      if (until !== undefined && base.createdAt >= until) continue;
      if (verdicts && !verdicts.has(base.verdict)) continue;
      if (from !== undefined && base.tx.from.toLowerCase() !== from) continue;
      out.push(applyAmendments(base, amendments.get(id) ?? []));
    }
    out.sort(byTime);
    if (q.limit !== undefined && q.limit >= 0 && out.length > q.limit) out = out.slice(out.length - q.limit);
    return out;
  }

  /** Raw records in file order, for auditing. */
  records(opts: { chainId?: ChainId; sinceDay?: string } = {}): StoredRecord[] {
    const out: StoredRecord[] = [];
    for (const file of this.files(opts)) out.push(...this.readFile(file));
    return out;
  }

  /** Stats from the most recent read. */
  stats(): ScanStats {
    return { ...this.lastStats };
  }

  /** Verifies every stored receipt and amendment. */
  verifyAll(opts: { chainId?: ChainId } = {}): { checked: number; bad: { id: string; reason: string }[] } {
    const bad: { id: string; reason: string }[] = [];
    let checked = 0;
    for (const rec of this.records(opts)) {
      checked++;
      if (isAmendment(rec)) {
        if (!verifyAmendment(rec)) bad.push({ id: rec.id, reason: 'amendment content does not hash to the recorded id' });
      } else {
        const v = verifyReceipt(rec);
        if (!v.ok) bad.push({ id: rec.id ?? '', reason: v.reason ?? 'id mismatch' });
      }
    }
    return { checked, bad };
  }

  chains(): ChainId[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.receiptsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((id) => this.chainId === undefined || id === this.chainId)
      .sort((a, b) => a - b);
  }

  /** Day files in chronological order. */
  files(opts: { chainId?: ChainId; sinceDay?: string } = {}): string[] {
    const chains = opts.chainId === undefined ? this.chains() : this.chains().filter((c) => c === opts.chainId);
    const out: { day: string; file: string }[] = [];
    for (const chain of chains) {
      const dir = this.dirFor(chain);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const m = DAY_RE.exec(name);
        if (!m) continue;
        if (opts.sinceDay !== undefined && m[1]! < opts.sinceDay) continue;
        out.push({ day: m[1]!, file: path.join(dir, name) });
      }
    }
    out.sort((a, b) => (a.day === b.day ? a.file.localeCompare(b.file) : a.day.localeCompare(b.day)));
    return out.map((e) => e.file);
  }

  private append(file: string, record: StoredRecord): void {
    const line = `${toJsonLine(record)}\n`;
    const buf = Buffer.from(line, 'utf8');
    if (buf.byteLength > MAX_RECORD_BYTES) {
      throw new Error(`record is ${buf.byteLength} bytes, over the ${MAX_RECORD_BYTES}-byte atomic-append limit`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      // One write() on an O_APPEND handle: the record lands whole, at the end, even if another
      // process is appending to the same file.
      const written = fs.writeSync(fd, buf, 0, buf.byteLength);
      if (written !== buf.byteLength) throw new Error(`short append: ${written}/${buf.byteLength} bytes to ${file}`);
    } finally {
      fs.closeSync(fd);
    }
    this.cache.delete(file);
  }

  private index(opts: { chainId?: ChainId; sinceDay?: string } = {}): {
    receipts: Map<string, Receipt>;
    amendments: Map<string, ReceiptAmendment[]>;
  } {
    const receipts = new Map<string, Receipt>();
    const amendments = new Map<string, ReceiptAmendment[]>();
    const stats: ScanStats = { files: 0, receipts: 0, amendments: 0, malformed: 0 };
    for (const file of this.files(opts)) {
      stats.files++;
      const recs = this.readFile(file);
      stats.malformed += this.cache.get(file)?.malformed ?? 0;
      for (const rec of recs) {
        if (isAmendment(rec)) {
          stats.amendments++;
          const list = amendments.get(rec.receiptId);
          if (list) list.push(rec);
          else amendments.set(rec.receiptId, [rec]);
        } else if (rec.id) {
          stats.receipts++;
          // First write wins: a duplicate line for the same id is the same content by construction.
          if (!receipts.has(rec.id)) receipts.set(rec.id, rec);
        } else {
          stats.malformed++;
        }
      }
    }
    this.lastStats = stats;
    return { receipts, amendments };
  }

  private readFile(file: string): StoredRecord[] {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.cache.delete(file);
      return [];
    }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.records;
    const text = fs.readFileSync(file, 'utf8');
    const records: StoredRecord[] = [];
    let malformed = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as StoredRecord;
        if (parsed && typeof parsed === 'object') records.push(parsed);
        else malformed++;
      } catch {
        malformed++;
      }
    }
    this.cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, records, malformed });
    return records;
  }
}

function byTime(a: Receipt, b: Receipt): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortAmendments(list: ReceiptAmendment[]): ReceiptAmendment[] {
  return [...list].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/** Replays amendments over a receipt, oldest first; later amendments win. Pure. */
export function applyAmendments(base: Receipt, list: ReceiptAmendment[]): Receipt {
  if (list.length === 0) return base;
  let out: Receipt = base;
  for (const a of sortAmendments(list)) {
    out = {
      ...out,
      ...(a.patch.txHash === undefined ? {} : { txHash: a.patch.txHash }),
      ...(a.patch.outcome === undefined ? {} : { outcome: a.patch.outcome }),
    };
  }
  return out;
}
