import { beforeAll, describe, expect, it } from 'vitest';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import {
  accessFromPrestate,
  accountKey,
  calleeAddresses,
  encodeBlockSelector,
  makePublicClient,
  normalizeSlot,
  parsePrestate,
  slotKey,
  splitKey,
  traceCallPrestate,
  traceCallTree,
  traceTxCallTree,
  traceTxPrestate,
  walkCallTree,
  type CallFrame,
  type Hex,
  type TraceTx,
} from '../src/index.js';

type Raw = (a: { method: string; params?: unknown[] }) => Promise<any>;
const hexNum = (n: bigint) => `0x${n.toString(16)}`;

describe('normalisation (pure)', () => {
  it('pads and lowercases slots, builds and splits keys', () => {
    expect(normalizeSlot('0x1')).toBe(`0x${'0'.repeat(63)}1`);
    expect(normalizeSlot('0xAB')).toBe(`0x${'0'.repeat(62)}ab`);
    const a = '0xAbCdEf0000000000000000000000000000000001';
    expect(accountKey(a)).toBe(`${a.toLowerCase()}:account`);
    expect(splitKey(slotKey(a, '0x2'))).toEqual({ address: a.toLowerCase(), slot: normalizeSlot('0x2') });
    expect(splitKey(accountKey(a)).slot).toBe('account');
    expect(encodeBlockSelector(5n)).toBe('0x5');
    expect(encodeBlockSelector(`0x${'a'.repeat(64)}`)).toEqual({ blockHash: `0x${'a'.repeat(64)}` });
    expect(encodeBlockSelector('latest')).toBe('latest');
  });
});

const NETS = [
  { name: 'testnet', chainId: 10143 },
  { name: 'mainnet', chainId: 143 },
];

for (const net of NETS) {
  describe(`real ${net.name} tracing`, () => {
    const client = makePublicClient({ env: { READSET_NETWORK: net.name }, retryCount: 2, timeoutMs: 20_000 });
    const raw = client.request as unknown as Raw;
    let reachable = false;
    let reason = '';
    let txHash: Hex;
    let txObj: TraceTx;
    let txBlock: bigint;
    let parentHash: Hex;
    let txGas: bigint;

    beforeAll(async () => {
      try {
        if (offline()) { reason = OFFLINE_REASON; return; }
        reachable = (await client.getChainId()) === net.chainId;
        if (!reachable) reason = 'unexpected chain id';
      } catch (e) {
        reason = `Monad ${net.name} RPC unreachable: ${(e as Error).message.split('\n')[0]}`;
      }
      if (!reachable) {
        console.warn(`SKIPPING ${net.name} trace tests: ${reason}`);
        return;
      }
      const head = await client.getBlockNumber();
      for (let i = 3n; i < 80n; i++) {
        const b = await raw({ method: 'eth_getBlockByNumber', params: [hexNum(head - i), true] });
        const t = b?.transactions?.find((x: any) => x.to && x.input && x.input.length > 10 && BigInt(x.value) === 0n);
        if (t) {
          txHash = t.hash;
          txBlock = BigInt(t.blockNumber);
          txGas = BigInt(t.gas);
          txObj = { from: t.from, to: t.to, data: t.input, value: BigInt(t.value), gas: BigInt(t.gas) };
          const parent = await raw({ method: 'eth_getBlockByNumber', params: [hexNum(txBlock - 1n), false] });
          parentHash = parent.hash;
          break;
        }
      }
      if (!txHash!) throw new Error(`no contract-call tx found in last 80 ${net.name} blocks`);
    }, 120_000);

    const live = (name: string, fn: () => Promise<void>) =>
      it(
        name,
        async (ctx) => {
          if (!reachable) return ctx.skip(reason);
          await fn();
        },
        120_000,
      );

    live('traceTxPrestate full vs diff are consistent', async () => {
      const full = await traceTxPrestate(client, txHash);
      const diff = await traceTxPrestate(client, txHash, { diffMode: true });
      expect(full.parsed.diffMode).toBe(false);
      expect(diff.parsed.diffMode).toBe(true);
      expect(full.parsed.accounts.length).toBeGreaterThan(0);
      for (const s of [...full.parsed.slots, ...diff.parsed.slots]) {
        expect(s.address).toMatch(/^0x[0-9a-f]{40}$/);
        expect(s.slot).toMatch(/^0x[0-9a-f]{64}$/);
        expect(s.pre).toMatch(/^0x[0-9a-f]{64}$/);
      }
      // diff writes: pre values agree with the full trace, and post differs from pre
      const fullIdx = new Map(full.parsed.slots.map((s) => [`${s.address}:${s.slot}`, s.pre]));
      for (const s of diff.parsed.slots.filter((x) => x.written)) {
        const f = fullIdx.get(`${s.address}:${s.slot}`);
        if (f !== undefined) expect(BigInt(f)).toBe(BigInt(s.pre));
        expect(s.post).toBeDefined();
        expect(BigInt(s.post!)).not.toBe(BigInt(s.pre));
      }
      const acc = accessFromPrestate(diff.raw as any, full.raw as any);
      for (const w of acc.writes) expect(acc.reads).toContain(w);
    });

    live('traceCallPrestate at a block number and at a block hash agree', async () => {
      const byNum = await traceCallPrestate(client, txObj, txBlock - 1n);
      const byHash = await traceCallPrestate(client, txObj, parentHash);
      expect(byNum.parsed.slots.length + byNum.parsed.accounts.length).toBeGreaterThan(0);
      expect(byHash.parsed.slots).toEqual(byNum.parsed.slots);
      const d = await traceCallPrestate(client, txObj, txBlock - 1n, { diffMode: true });
      expect(d.parsed.diffMode).toBe(true);
      expect(parsePrestate(d.raw).slots).toEqual(d.parsed.slots);
    });

    live('callTracer tree walk is consistent for tx and replayed call', async () => {
      const tree: CallFrame = await traceTxCallTree(client, txHash);
      const walked = walkCallTree(tree);
      expect(walked[0]!.depth).toBe(0);
      expect(walked[0]!.frame.to?.toLowerCase()).toBe(txObj.to!.toLowerCase());
      const count = (f: CallFrame): number => 1 + (f.calls ?? []).reduce((n, c) => n + count(c), 0);
      expect(walked.length).toBe(count(tree));
      expect(calleeAddresses(tree)).toContain(txObj.to!.toLowerCase());
      let visited = 0;
      walkCallTree(tree, () => {
        visited++;
        return false;
      });
      expect(visited).toBe(1);

      const replay = await traceCallTree(client, txObj, txBlock - 1n);
      expect(replay.type).toBeTruthy();
      expect(BigInt(replay.gas ?? '0x0')).toBe(txGas);
    });
  });
}
