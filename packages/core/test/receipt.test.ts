import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ReceiptStore,
  amendmentId,
  buildReceipt,
  canonicalJson,
  isAmendment,
  monadFeePaidWei,
  policyHash,
  receiptId,
  recordAttempt,
  recordOutcome,
  recordSent,
  verifyAmendment,
  verifyReceipt,
  type AttemptInput,
} from '../src/receipt/index.js';
import { DEFAULT_POLICY, parsePolicy } from '../src/breaker/policy.js';
import type { DependencySet, Hex, Receipt } from '../src/types.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const TSX_CLI = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const STORE_MODULE = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'receipt', 'index.ts')).href;

const WALLET: Hex = '0x00000000000000000000000000000000000a11ce';
const POOL: Hex = '0x7a3f00000000000000000000000000000000c21e';
const CHAIN = 10143;

const tmpRoots: string[] = [];
function tmpRoot(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `readset-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

const w32 = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function depSet(): DependencySet {
  return {
    simulation: {
      success: false,
      gasUsed: 123_456n,
      revertData: '0x08c379a0',
      revertReason: 'HEALTH_FACTOR',
      block: { number: 111_218_869n, hash: w32(0xabcdefn), timestamp: 1_760_000_000n },
    },
    slots: [
      { address: POOL, slot: w32(4n), valueSeen: w32(1000n), readOnly: true, label: 'totalDeposits' },
      { address: POOL, slot: w32(5n), valueSeen: w32(900n), readOnly: false },
    ],
    accounts: [{ address: WALLET, balance: 5_000_000_000_000_000_000n, nonce: 42 }],
    time: { flagged: true, contracts: [POOL], opcodes: ['TIMESTAMP'] },
    coverage: 'full',
  };
}

function attempt(over: Partial<AttemptInput> = {}): AttemptInput {
  return {
    chainId: CHAIN,
    tx: { from: WALLET, to: POOL, data: '0xa9059cbb0000', value: 0n, gasLimitChosen: 300_000n },
    verdict: 'refused_doomed',
    doomed: { reason: 'simulation reverted', revertReason: 'HEALTH_FACTOR' },
    dependencySet: depSet(),
    policy: DEFAULT_POLICY,
    createdAt: '2026-10-07T12:00:00.000Z',
    ...over,
  };
}

describe('canonical json + hashing', () => {
  it('sorts keys and renders bigint as decimal', () => {
    expect(canonicalJson({ b: 1n, a: [2n, 'x'], c: { z: true, y: null } })).toBe(
      '{"a":["2","x"],"b":"1","c":{"y":null,"z":true}}',
    );
  });

  it('drops undefined-valued keys so an absent field and an undefined field hash alike', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('bigint and its decimal string are the same content', () => {
    expect(canonicalJson({ v: 10n ** 20n })).toBe(canonicalJson({ v: '100000000000000000000' }));
  });

  it('receipt ids are deterministic and independent of key order', () => {
    const a = buildReceipt(attempt());
    const b = buildReceipt({
      createdAt: '2026-10-07T12:00:00.000Z',
      policy: parsePolicy({}),
      dependencySet: depSet(),
      doomed: { revertReason: 'HEALTH_FACTOR', reason: 'simulation reverted' },
      verdict: 'refused_doomed',
      tx: { gasLimitChosen: '300000', value: '0', data: '0xA9059CBB0000' as Hex, to: POOL.toUpperCase() as Hex, from: WALLET },
      chainId: CHAIN,
    });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReceipt(a).ok).toBe(true);
  });

  it('any change of content changes the id', () => {
    const base = buildReceipt(attempt());
    expect(buildReceipt(attempt({ verdict: 'allowed' })).id).not.toBe(base.id);
    expect(buildReceipt(attempt({ chainId: 143 })).id).not.toBe(base.id);
    expect(buildReceipt(attempt({ createdAt: '2026-10-07T12:00:00.001Z' })).id).not.toBe(base.id);
    expect(buildReceipt(attempt({ tx: { ...attempt().tx, value: 1n } })).id).not.toBe(base.id);
  });

  it('txHash and outcome are outside the id, so an amendment never invalidates it', () => {
    const withHash = buildReceipt(attempt({ txHash: w32(7n).slice(0, 66) as Hex }));
    expect(withHash.id).toBe(buildReceipt(attempt()).id);
  });

  it('policyHash is deterministic and limit-sensitive', () => {
    expect(policyHash(DEFAULT_POLICY)).toBe(policyHash(parsePolicy({})));
    expect(policyHash(parsePolicy({ maxConsecutiveReverts: 4 }))).not.toBe(policyHash(DEFAULT_POLICY));
  });

  it('refuses to hash content carrying a key or a raw signed payload', () => {
    expect(() =>
      buildReceipt(attempt({ doomed: { reason: 'x', ...({ privateKey: '0xdead' } as object) } as never })),
    ).toThrow(/secret-bearing key/);
    expect(() => buildReceipt(attempt({ doomed: { reason: 'x', ...({ rawTransaction: '0x02f8' } as object) } as never })))
      .toThrow(/secret-bearing key/);
  });

  it('Monad fee is the gas LIMIT times the price (docs/facts.md #1a)', () => {
    expect(monadFeePaidWei(950_000n, 110_000_000_000n)).toBe('104500000000000000');
  });
});

describe('store: append-only JSONL, amendments, tamper detection', () => {
  const root = tmpRoot('store');
  // Pin the clock, and advance it by a second per call. `amend()` files an amendment under the
  // amendment's own date, so a real clock would put these in today's file and the assertions
  // would only hold on one calendar day. Advancing also keeps amendment order deterministic:
  // amendments sharing a timestamp fall back to id order, which is not write order.
  let tick = 0;
  const store = new ReceiptStore({
    root,
    chainId: CHAIN,
    now: () => new Date(Date.parse('2026-10-07T12:00:02.000Z') + tick++ * 1000),
  });
  let blocked: Receipt;
  let sent: Receipt;

  beforeAll(() => {
    blocked = recordAttempt(attempt(), { store });
    sent = recordAttempt(
      attempt({ verdict: 'allowed', doomed: undefined, createdAt: '2026-10-07T12:00:01.000Z' }),
      { store },
    );
    recordSent(sent, w32(0x11n).slice(0, 66) as Hex, { store });
    recordOutcome(sent, { status: 'reverted', gasUsed: 300_000n, feePaidWei: monadFeePaidWei(300_000n, 110n * 10n ** 9n), blockNumber: 111_218_900n }, { store });
  });

  it('writes to .readset/receipts/<chainId>/<day>.jsonl', () => {
    const file = path.join(root, 'receipts', String(CHAIN), '2026-10-07.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    expect(store.fileFor(CHAIN, blocked.createdAt)).toBe(file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4); // 2 receipts + txHash amendment + outcome amendment
  });

  it('the original receipt line is never rewritten', () => {
    const file = path.join(root, 'receipts', String(CHAIN), '2026-10-07.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Receipt);
    const original = records.find((r) => r.id === sent.id)!;
    expect(original.outcome).toBeUndefined();
    expect(original.txHash).toBeUndefined();
    expect(receiptId(original)).toBe(sent.id);
  });

  it('amendments are self-verifying records with their own hash', () => {
    const amendments = store.amendmentsFor(sent.id);
    expect(amendments).toHaveLength(2);
    for (const a of amendments) {
      expect(isAmendment(a)).toBe(true);
      expect(a.kind).toBe('amendment');
      expect(a.receiptId).toBe(sent.id);
      expect(verifyAmendment(a)).toBe(true);
      const { id: _id, ...rest } = a;
      expect(amendmentId(rest)).toBe(a.id);
    }
    expect(amendments.map((a) => Object.keys(a.patch)[0])).toEqual(['txHash', 'outcome']);
  });

  it('reads replay amendments over the receipt without changing its id', () => {
    const merged = store.get(sent.id)!;
    expect(merged.id).toBe(sent.id);
    expect(verifyReceipt(merged).ok).toBe(true);
    expect(merged.outcome).toEqual({
      status: 'reverted',
      gasUsed: '300000',
      feePaidWei: '33000000000000000',
      blockNumber: '111218900',
    });
    expect(merged.txHash).toBe(w32(0x11n).slice(0, 66));
  });

  it('bigints survive the round trip as decimal strings', () => {
    const merged = store.get(blocked.id)!;
    expect(merged.dependencySet!.simulation.gasUsed).toBe('123456');
    expect(merged.dependencySet!.accounts[0]!.balance).toBe('5000000000000000000');
    // and the recorded id still verifies, because the id was computed over the same canonical form
    expect(verifyReceipt(merged).ok).toBe(true);
  });

  it('byTxHash and list filters', () => {
    expect(store.byTxHash(w32(0x11n).slice(0, 66) as Hex).map((r) => r.id)).toEqual([sent.id]);
    expect(store.byTxHash(w32(0x99n).slice(0, 66) as Hex)).toEqual([]);
    expect(store.list({ verdict: 'refused_doomed' }).map((r) => r.id)).toEqual([blocked.id]);
    expect(store.list({ since: '2026-10-07T12:00:01.000Z' }).map((r) => r.id)).toEqual([sent.id]);
    expect(store.list({ limit: 1 }).map((r) => r.id)).toEqual([sent.id]); // most recent
    expect(store.list({ from: WALLET })).toHaveLength(2);
    expect(store.list({ from: POOL })).toHaveLength(0);
  });

  it('attachOutcome on an unknown id throws, and verifyAll is clean', () => {
    expect(() => store.attachOutcome('0'.repeat(64), { status: 'success', gasUsed: '1', feePaidWei: '1', blockNumber: '1' })).toThrow(/no receipt/);
    expect(store.verifyAll()).toEqual({ checked: 4, bad: [] });
  });

  it('detects a tampered line in the log', () => {
    const tamperRoot = tmpRoot('tamper');
    const s = new ReceiptStore({ root: tamperRoot, chainId: CHAIN });
    const r = recordAttempt(attempt(), { store: s });
    const file = s.fileFor(CHAIN, r.createdAt);
    const edited = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Receipt;
    edited.verdict = 'allowed'; // an operator "fixing" the audit trail
    fs.writeFileSync(file, `${JSON.stringify(edited)}\n`);
    const fresh = new ReceiptStore({ root: tamperRoot, chainId: CHAIN });
    const loaded = fresh.get(r.id)!;
    const v = verifyReceipt(loaded);
    expect(v.ok).toBe(false);
    expect(v.expected).not.toBe(v.id);
    expect(fresh.verifyAll().bad).toEqual([{ id: r.id, reason: 'content does not hash to the recorded id' }]);
  });

  it('put refuses a receipt whose id does not match its content', () => {
    const s = new ReceiptStore({ root: tmpRoot('mismatch'), chainId: CHAIN });
    expect(() => s.put({ ...buildReceipt(attempt()), verdict: 'allowed' })).toThrow(/failed verification/);
  });
});

describe('concurrent appends from two processes', () => {
  it('both children land every record in one day file, uncorrupted', () => {
    const root = tmpRoot('concurrent');
    const script = path.join(root, 'writer.ts');
    fs.writeFileSync(
      script,
      `// Child writer: uses the real ReceiptStore, one process per sender.
import { recordAttempt, ReceiptStore } from ${JSON.stringify(STORE_MODULE)};
const [root, from, count] = [process.env.ROOT, process.env.FROM, Number(process.env.COUNT)];
const store = new ReceiptStore({ root, chainId: ${CHAIN} });
for (let i = 0; i < count; i++) {
  recordAttempt(
    {
      chainId: ${CHAIN},
      tx: { from, to: ${JSON.stringify(POOL)}, data: '0xa9059cbb', value: BigInt(i) },
      verdict: 'refused_doomed',
      doomed: { reason: 'child ' + from + ' #' + i },
      createdAt: '2026-10-07T12:00:00.000Z',
    },
    { store },
  );
}
`,
      'utf8',
    );

    const N = 60;
    const senders: Hex[] = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'];
    const children = senders.map((from) =>
      spawnSync(process.execPath, [TSX_CLI, script], {
        cwd: REPO,
        env: { ...process.env, ROOT: root, FROM: from, COUNT: String(N) },
        encoding: 'utf8',
      }),
    );
    for (const c of children) expect(c.status, c.stderr).toBe(0);

    const file = path.join(root, 'receipts', String(CHAIN), '2026-10-07.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2 * N);
    const store = new ReceiptStore({ root, chainId: CHAIN });
    expect(store.list()).toHaveLength(2 * N);
    expect(store.stats().malformed).toBe(0);
    const { checked, bad } = store.verifyAll();
    expect(bad).toEqual([]);
    expect(checked).toBe(2 * N);
    for (const from of senders) expect(store.list({ from })).toHaveLength(N);
  }, 120_000);
});
