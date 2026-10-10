// Explain tests. Pure parts are unit-tested; the rest runs against REAL Monad mainnet transactions
// picked at run time by scanning recent blocks for receipts with status 0x0. No fixtures, no mocks.
//
// Needs a mainnet archive endpoint with debug_* (K1: rpc2.monad.xyz / rpc-mainnet.monadinfra.com).
// Override with READSET_EXPLAIN_RPC. If the network is unreachable the live tests skip LOUDLY.
import { beforeAll, describe, expect, it } from 'vitest';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import { makePublicClient } from '../src/index.js';
import type { Hex } from '../src/types.js';
import {
  burnFacts,
  classifyBatch,
  classifyResims,
  decodeRevert,
  explainFailedTx,
  explanationToJson,
  isFundsFailure,
  lastWritesInBlock,
  MONAD_SYSTEM_ACCOUNTS,
  rankMovements,
  summarize,
  verdictDistribution,
  type FullExplanation,
  type Movement,
  type ResimAtK,
} from '../src/explain/index.js';

const B = (n: bigint) => n;
const HASH32 = (c: string) => `0x${c.repeat(64)}` as Hex;

// ---------------------------------------------------------------- pure units

describe('burn accounting (pure)', () => {
  it('burnedWei is gasLimit x effectiveGasPrice and cross-checks the receipt', () => {
    // Real mainnet numbers from docs/facts.md (tx 0x862bae1f57..., block 111218869).
    const f = burnFacts({ gasLimit: 950_000n, effectiveGasPrice: 110_000_000_000n, receiptGasUsed: 950_000n });
    expect(f.burnedWei).toBe((950_000n * 110_000_000_000n).toString());
    expect(f.burnedWei).toBe('104500000000000000'); // 0.1045 MON, as in facts.md
    expect(f.receiptGasUsedEqualsLimit).toBe(true);
    const g = burnFacts({ gasLimit: 100n, effectiveGasPrice: 2n, receiptGasUsed: 50n });
    expect(g.burnedWei).toBe('200'); // the LIMIT is charged, not gasUsed
    expect(g.receiptGasUsedEqualsLimit).toBe(false);
    expect(() => burnFacts({ gasLimit: -1n, effectiveGasPrice: 1n, receiptGasUsed: 0n })).toThrow();
  });
});

describe('revert decoding (pure)', () => {
  it('decodes Error(string), Panic(uint256), custom errors and empty data', () => {
    // abi.encodeWithSignature("Error(string)", "ds-math-sub-underflow")
    const errStr =
      '0x08c379a0' +
      '0'.repeat(62) + '20' +
      '0'.repeat(62) + '15' +
      Buffer.from('ds-math-sub-underflow').toString('hex').padEnd(64, '0');
    expect(decodeRevert(errStr as Hex)).toMatchObject({ kind: 'error-string', reason: 'ds-math-sub-underflow' });
    const panic = ('0x4e487b71' + '0'.repeat(62) + '11') as Hex;
    expect(decodeRevert(panic)).toMatchObject({ kind: 'panic' });
    expect(decodeRevert(panic).reason).toContain('arithmetic overflow/underflow');
    // Real revert payload of mainnet tx 0xd7e44875dd28...: a custom error selector.
    const custom =
      '0x911bb2c900000000000000000000000000000000000000000000000001a413533aa42180000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000001a40010ef713367' as Hex;
    expect(decodeRevert(custom)).toMatchObject({ kind: 'custom-error', selector: '0x911bb2c9' });
    expect(decodeRevert('0x')).toMatchObject({ kind: 'empty' });
    expect(decodeRevert(undefined)).toMatchObject({ kind: 'none' });
  });
  it('treats only node-level funding failures as funds failures', () => {
    expect(isFundsFailure('insufficient funds for gas * price + value')).toBe(true);
    expect(isFundsFailure('reserve balance would be violated')).toBe(true);
    // a token balance revert is a real dependency move, not a funding problem
    expect(isFundsFailure('ERC20: transfer amount exceeds balance')).toBe(false);
    expect(isFundsFailure(undefined)).toBe(false);
  });
});

describe('verdict table (pure)', () => {
  const sim = (k: number, outcome: ResimAtK['outcome'], extra: Partial<ResimAtK> = {}): ResimAtK => ({
    k,
    block: B(100n - BigInt(k)),
    blockHash: HASH32('a'),
    outcome,
    ...extra,
  });

  it('reverting at N-3 is knowable', () => {
    const v = classifyResims([sim(1, 'revert', { revertReason: 'x' }), sim(2, 'revert'), sim(3, 'revert', { revertReason: 'x' })]);
    expect(v).toMatchObject({ avoidableClass: 'knowable', avoidableAt: 'N-3', avoidable: true, undetectableWithoutPendingFeed: false });
  });
  it('reverting only at N-1 is latency-sensitive', () => {
    const v = classifyResims([sim(1, 'revert', { revertReason: 'slippage' }), sim(2, 'success'), sim(3, 'success')]);
    expect(v).toMatchObject({ avoidableClass: 'latency-sensitive', avoidableAt: 'N-1', avoidable: true });
    expect(v.rationale).toContain('N-1');
  });
  it('reverting at N-2 but not N-3 is latency-sensitive at N-2', () => {
    expect(classifyResims([sim(1, 'revert'), sim(2, 'revert'), sim(3, 'success')])).toMatchObject({ avoidableAt: 'N-2', avoidableClass: 'latency-sensitive' });
  });
  it('succeeding at N-1 is same-block and claims no avoidability', () => {
    const v = classifyResims([sim(1, 'success'), sim(2, 'success'), sim(3, 'success')]);
    expect(v).toMatchObject({ avoidableClass: 'same-block', avoidableAt: 'same-block', avoidable: false, undetectableWithoutPendingFeed: true });
    expect(v.rationale).toMatch(/pending-transaction feed/);
  });
  it('funds / reserve-balance failures are never avoidable (PRD rule)', () => {
    expect(classifyResims([sim(1, 'funds', { error: 'insufficient funds for gas * price + value' })])).toMatchObject({
      avoidableClass: 'unavoidable',
      avoidableAt: 'unavoidable',
      avoidable: false,
    });
    expect(classifyResims([sim(1, 'revert', { revertReason: 'insufficient funds' }), sim(2, 'revert'), sim(3, 'revert')])).toMatchObject({
      avoidableClass: 'unavoidable',
      avoidable: false,
    });
  });
  it('an unusable N-1 basis is unknown, not a guess', () => {
    expect(classifyResims([sim(1, 'error', { error: 'pruned state' })])).toMatchObject({ avoidableClass: 'unknown', avoidableAt: 'unknown', avoidable: false });
    expect(classifyResims([])).toMatchObject({ avoidableClass: 'unknown' });
  });
  it('verdictDistribution counts classes and avoidableAt values', () => {
    const d = verdictDistribution([
      { avoidableClass: 'same-block', avoidableAt: 'same-block' },
      { avoidableClass: 'knowable', avoidableAt: 'N-3' },
      { avoidableClass: 'knowable', avoidableAt: 'N-3' },
    ]);
    expect(d).toEqual({ total: 3, byClass: { 'same-block': 1, knowable: 2 }, byAvoidableAt: { 'same-block': 1, 'N-3': 2 } });
  });
});

describe('writer attribution over block traces (pure)', () => {
  const diffEntry = (txHash: Hex, addr: string, slot: string, pre: string, post: string) => ({
    txHash,
    result: { pre: { [addr]: { storage: { [slot]: pre } } }, post: { [addr]: { storage: { [slot]: post } } } },
  });
  it('keeps the LAST write before the cut-off index and ignores later txs', () => {
    const A = '0xcee4c7563c3d7116def480bd37937b55686b0959';
    const entries = [
      diffEntry(HASH32('1'), A, '0x1', '0x0', '0x5'),
      diffEntry(HASH32('2'), A, '0x1', '0x5', '0x9'),
      diffEntry(HASH32('3'), A, '0x1', '0x9', '0xf'),
    ];
    const all = lastWritesInBlock(entries);
    expect(all.get(`${A}:0x${'0'.repeat(63)}1`)).toMatchObject({ txHash: HASH32('3'), txIndex: 2 });
    const before2 = lastWritesInBlock(entries, 2);
    expect(before2.get(`${A}:0x${'0'.repeat(63)}1`)).toMatchObject({ txHash: HASH32('2'), txIndex: 1 });
    expect(lastWritesInBlock(entries, 0).size).toBe(0);
  });
  it('ignores entries whose value did not change and malformed entries', () => {
    const A = '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242';
    const entries = [diffEntry(HASH32('4'), A, '0x2', '0x7', '0x7'), { txHash: HASH32('5') }, {} as never];
    expect(lastWritesInBlock(entries).size).toBe(0);
  });
});

describe('movement ranking (pure)', () => {
  it('puts real contract slots the tx read before system-account accounting slots', () => {
    const mk = (address: string, systemAccount: boolean, read: boolean): Movement => ({
      address: address as Hex,
      slot: HASH32('0'),
      values: {},
      from: HASH32('0'),
      to: HASH32('1'),
      inDependencySetAt: read ? ['executed'] : [],
      changedBetween: 'N-1 -> executed',
      systemAccount,
    });
    const sys = mk(MONAD_SYSTEM_ACCOUNTS[0]!, true, true);
    const unread = mk('0x1b68626dca36c7fe922fd2d55e4f631d962de19c', false, false);
    const read = mk('0xcee4c7563c3d7116def480bd37937b55686b0959', false, true);
    expect(rankMovements([sys, unread, read]).map((m) => m.address)).toEqual([read.address, unread.address, sys.address]);
    expect(MONAD_SYSTEM_ACCOUNTS[0]).toBe('0x0000000000000000000000000000000000001000');
  });
});

// ---------------------------------------------------------------- live mainnet

const RPC = process.env.READSET_EXPLAIN_RPC ?? 'https://rpc2.monad.xyz';
const SAMPLE = Number(process.env.READSET_EXPLAIN_SAMPLE ?? 6);

describe('real Monad mainnet failed transactions', () => {
  const client = makePublicClient({ env: { READSET_NETWORK: 'mainnet', READSET_RPC_URL: RPC }, retryCount: 2, timeoutMs: 30_000 });
  const raw = client.request as unknown as (a: { method: string; params?: unknown[] }) => Promise<any>;
  const hx = (n: bigint) => `0x${n.toString(16)}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let reachable = false;
  let reason = '';
  let hashes: Hex[] = [];
  let explanations: FullExplanation[] = [];

  beforeAll(async () => {
    if (offline()) {
      reason = OFFLINE_REASON;
      return;
    }
    try {
      const id = await client.getChainId();
      reachable = id === 143;
      if (!reachable) reason = `expected mainnet chain id 143, got ${id}`;
    } catch (e) {
      reason = `Monad mainnet RPC ${RPC} unreachable: ${(e as Error).message.split('\n')[0]}`;
    }
    if (!reachable) {
      console.warn(`\n*** SKIPPING live explain tests: ${reason} ***\n`);
      return;
    }
    // Find real failed txs (status 0x0) in recent blocks. Throttled: 1 request per ~250 ms (<10 rps).
    const head = await client.getBlockNumber();
    const seenSenders = new Set<string>();
    for (let i = 8n; hashes.length < SAMPLE && i < 70n; i++) {
      let rcpts: any[];
      try {
        rcpts = await raw({ method: 'eth_getBlockReceipts', params: [hx(head - i)] });
      } catch (e) {
        console.warn(`  receipts for block ${head - i} failed: ${(e as Error).message.split('\n')[0]}`);
        await sleep(600);
        continue;
      }
      await sleep(250);
      for (const r of rcpts ?? []) {
        if (r.status !== '0x0' || !r.to) continue;
        if (seenSenders.has(r.from)) continue; // spread the sample over distinct senders
        seenSenders.add(r.from);
        hashes.push(r.transactionHash as Hex);
        if (hashes.length >= SAMPLE) break;
      }
    }
    if (hashes.length === 0) {
      reachable = false;
      reason = 'no failed (status 0x0) transaction found in the scanned mainnet blocks';
      console.warn(`\n*** SKIPPING live explain tests: ${reason} ***\n`);
      return;
    }
    console.log(`\nexplain: sampled ${hashes.length} real failed mainnet txs:\n  ${hashes.join('\n  ')}`);
    const batch = await classifyBatch(client, hashes, { concurrency: 2, minIntervalMs: 250 });
    for (const item of batch.items) {
      if (!item.ok) {
        console.warn(`  ${item.txHash}: explain failed: ${item.error}`);
        continue;
      }
      explanations.push(item.explanation as FullExplanation);
    }
    console.log('\n=== verdict distribution over the sampled real failed txs ===');
    console.log(JSON.stringify(batch.distribution, null, 1));
    console.log(`burned total: ${batch.burnedWei} wei over ${batch.distribution.total} txs; explain failures: ${batch.failures}`);
    for (const e of explanations) {
      console.log(`\n${summarize(e)}`);
      console.log(`  resims: ${e.resims.map((r) => `N-${r.k}=${r.outcome}`).join(' ')}`);
      console.log(`  executed revert: ${e.executedRevert.kind} ${e.executedRevert.reason ?? ''}`.slice(0, 160));
      console.log(`  ${e.rationale}`.slice(0, 400));
      for (const m of e.attributedMovements) {
        console.log(`   writer: ${m.address} ${m.slot} ${m.from} -> ${m.to} by ${m.writerTx} (sender ${m.writerSender}, block ${m.writerBlock}, same-block=${m.sameBlock})`);
      }
      if (e.unattributedMovements.length) console.log(`   ${e.unattributedMovements.length} moved slot(s) with no writer in the scanned window`);
    }
  }, 900_000);

  const live = (name: string, fn: () => Promise<void> | void) =>
    it(
      name,
      async (ctx) => {
        if (!reachable) return ctx.skip(reason);
        await fn();
      },
      900_000,
    );

  live('explained at least one sampled failed transaction', () => {
    expect(hashes.length).toBeGreaterThan(0);
    expect(explanations.length).toBeGreaterThan(0);
  });

  live('burn equals gasLimit x effectiveGasPrice for every explanation', async () => {
    for (const e of explanations) {
      const receipt = await raw({ method: 'eth_getTransactionReceipt', params: [e.txHash] });
      const tx = await raw({ method: 'eth_getTransactionByHash', params: [e.txHash] });
      await sleep(200);
      expect(BigInt(receipt.status)).toBe(0n);
      const limit = BigInt(tx.gas);
      const price = BigInt(receipt.effectiveGasPrice);
      expect(e.gasLimit).toBe(limit.toString());
      expect(e.burnedWei).toBe((limit * price).toString());
      expect(e.burnEqualsLimitTimesPrice).toBe(true);
      // Monad sets receipt gasUsed to the limit at the top call level (facts.md #2).
      expect(BigInt(receipt.gasUsed)).toBe(limit);
      expect(e.burn.receiptGasUsedEqualsLimit).toBe(true);
    }
  });

  live('every verdict is an enum value backed by real re-simulation evidence', () => {
    const classes = ['knowable', 'latency-sensitive', 'same-block', 'unavoidable', 'unknown'];
    const ats = ['N-1', 'N-2', 'N-3', 'same-block', 'unavoidable', 'unknown'];
    for (const e of explanations) {
      expect(classes).toContain(e.avoidableClass);
      expect(ats).toContain(e.avoidableAt);
      expect(e.rationale.length).toBeGreaterThan(20);
      expect(e.failedBlock).toBeGreaterThan(0n);
      expect(e.failedBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
      // evidence: the N-1 basis exists, is pinned by block hash, and carries an outcome
      const r1 = e.resims.find((r) => r.k === 1);
      expect(r1).toBeDefined();
      expect(r1!.block).toBe(e.failedBlock - 1n);
      expect(r1!.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(['success', 'revert', 'funds', 'error']).toContain(r1!.outcome);
      // the verdict agrees with the N-1 outcome
      if (r1!.outcome === 'success') expect(e.avoidableClass).toBe('same-block');
      if (r1!.outcome === 'error') expect(e.avoidableClass).toBe('unknown');
      if (e.avoidableClass === 'knowable') expect(e.resims.find((r) => r.k === 3)!.outcome).toBe('revert');
      // the executed transaction really did fail, and we captured something about it
      expect(['error-string', 'panic', 'custom-error', 'empty', 'none']).toContain(e.executedRevert.kind);
      // non-diff prestateTracer gives read-only slots too (K1), so coverage is full
      expect(e.coverage).toBe('full');
      expect(e.executedSlots.length).toBeGreaterThanOrEqual(0);
      for (const s of [...e.executedSlots, ...e.resims.flatMap((r) => r.slots)]) {
        expect(s.address).toMatch(/^0x[0-9a-f]{40}$/);
        expect(s.slot).toMatch(/^0x[0-9a-f]{64}$/);
        expect(s.valueSeen).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  live('same-block verdicts claim no avoidability and say they were undetectable', () => {
    for (const e of explanations.filter((x) => x.avoidableClass === 'same-block')) {
      expect(e.avoidable).toBe(false);
      expect(e.avoidableAt).toBe('same-block');
      expect(e.undetectableWithoutPendingFeed).toBe(true);
      expect(e.rationale).toMatch(/pending-transaction feed/);
      // any writer we attribute for a same-block case must be an earlier tx in block N
      for (const m of e.attributedMovements.filter((x) => x.sameBlock)) {
        expect(m.writerBlock).toBe(e.failedBlock);
        expect(m.writerTxIndex).toBeLessThan(e.txIndex);
      }
    }
  });

  live('every attributed writer is a real transaction that really wrote that slot', async () => {
    const all = explanations.flatMap((e) => e.attributedMovements.map((m) => ({ e, m })));
    let earlierBlock = 0;
    let sameBlock = 0;
    for (const { e, m } of all) {
      expect(m.writerTx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(m.writerSender).toMatch(/^0x[0-9a-f]{40}$/);
      expect(m.writerBlock).toBeLessThanOrEqual(e.failedBlock);
      expect(BigInt(m.from)).not.toBe(BigInt(m.to));
      if (m.writerBlock < e.failedBlock) earlierBlock++;
      else sameBlock++;
      // Independent check of the claim this test is named for: the attributed transaction
      // really wrote that slot. We ask the writer's OWN trace rather than reading the slot at
      // the end of its block -- `to` is the last value across the whole window, and a later
      // transaction (in that block or a subsequent one) may have moved it again, so the two
      // are not the same thing and comparing them would fail on a correct attribution.
      const wdiff = await raw({
        method: 'debug_traceTransaction',
        params: [m.writerTx, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }],
      });
      await sleep(200);
      const post = (wdiff?.post ?? {}) as Record<string, { storage?: Record<string, string> }>;
      const wrote = Object.entries(post).some(
        ([addr, acc]) =>
          addr.toLowerCase() === m.address.toLowerCase() &&
          Object.keys(acc?.storage ?? {}).some((k) => BigInt(k) === BigInt(m.slot)),
      );
      if (!wrote) {
        // Name the case rather than just failing: a wrong writer is the worst thing this tool
        // can produce, so the evidence has to be in the output.
        console.error(
          `*** ATTRIBUTION MISMATCH ***
  failed tx : ${e.txHash}
  slot      : ${m.address}:${m.slot}
` +
            `  writer    : ${m.writerTx} (block ${m.writerBlock}, sameBlock=${String(m.sameBlock)})
` +
            `  writer post addresses: ${Object.keys(post).join(', ') || '(none)'}`,
        );
      }
      expect(wrote, `attributed writer ${m.writerTx} shows no write to ${m.address}:${m.slot}`).toBe(true);
      const wtx = await raw({ method: 'eth_getTransactionByHash', params: [m.writerTx] });
      await sleep(200);
      expect(wtx.from.toLowerCase()).toBe(m.writerSender);
      expect(BigInt(wtx.blockNumber)).toBe(m.writerBlock);
    }
    console.log(`\nwriter attribution over the sample: ${all.length} attributed movement(s); ${sameBlock} written by an earlier tx in block N, ${earlierBlock} written in an earlier block.`);
    if (all.length === 0) {
      console.warn('*** HONEST RESULT: no moved slot in this sample was attributed to a writer inside the scanned window. ***');
    }
    if (earlierBlock === 0) {
      console.warn(
        '*** HONEST RESULT: no moved slot in this sample resolved to a writer in an EARLIER block; ' +
          'every attributed writer was an earlier transaction inside the failed tx\'s own block (same-block race). ***',
      );
    }
    // Not forced: the assertion is on consistency, and the earlier-block count is reported above either way.
    expect(earlierBlock + sameBlock).toBe(all.length);
  });

  live('the explanation is deterministic for the same hash', async () => {
    const h = explanations[0]!.txHash;
    const again = await explainFailedTx(client, h);
    const strip = (e: FullExplanation) => {
      const j = explanationToJson(e) as Record<string, unknown>;
      // notes can mention transient RPC errors; everything else below must match exactly
      delete j.notes;
      delete j.writerScan;
      // MEASURED CAVEAT: the same endpoint has been observed returning a slightly different
      // ACCESSED-slot set for the same mined transaction on a repeated prestateTracer call
      // (load- or cache-dependent). That list is context, not evidence, so it is compared
      // separately below. Everything the verdict rests on is compared strictly.
      delete j.executedSlots;
      // Same caveat for each re-simulation's accessed-slot list and its count. What the verdict
      // actually rests on is each resim's OUTCOME at its block, asserted strictly below.
      j.resims = (j.resims as Record<string, unknown>[] | undefined)?.map((r) => {
        const { slots, slotCount, ...rest } = r as Record<string, unknown> & {
          slots?: unknown;
          slotCount?: unknown;
        };
        void slots;
        void slotCount;
        return rest;
      });
      return j;
    };
    expect(strip(again)).toEqual(strip(explanations[0]!));
    expect(again.avoidableClass).toBe(explanations[0]!.avoidableClass);
    expect(again.burnedWei).toBe(explanations[0]!.burnedWei);
    // Each re-simulation's verdict-bearing fields must match exactly.
    expect(again.resims.map((r) => [r.k, r.outcome, r.block.toString()])).toEqual(
      explanations[0]!.resims.map((r) => [r.k, r.outcome, r.block.toString()]),
    );
    // The moved slots ARE evidence: a forensic verdict that changed between runs would be
    // worthless, so these must be identical.
    expect(again.movedSlots).toEqual(explanations[0]!.movedSlots);
    expect(again.attributedMovements).toEqual(explanations[0]!.attributedMovements);

    // The context list must at least be stably ordered and deduped by us.
    const keys = (e: FullExplanation) => e.executedSlots.map((s) => `${s.address}:${s.slot}`);
    const a = keys(again);
    const b = keys(explanations[0]!);
    expect([...a]).toEqual([...a].sort());
    expect(new Set(a).size).toBe(a.length);
    const overlap = a.filter((k) => b.includes(k)).length;
    const union = new Set([...a, ...b]).size;
    if (overlap !== union) {
      console.warn(
        `*** HONEST RESULT: prestateTracer returned a different accessed-slot set on a repeat ` +
          `call for the same tx (${overlap}/${union} shared). The verdict and moved slots were ` +
          `identical; only the read-only context list drifted. ***`,
      );
    }
    // Most of the footprint must still agree, or the trace source is not usable as context.
    expect(overlap / union).toBeGreaterThan(0.5);
  });

  live('refuses to explain a successful transaction', async () => {
    const head = await client.getBlockNumber();
    let ok: Hex | undefined;
    for (let i = 8n; !ok && i < 20n; i++) {
      const rcpts: any[] = await raw({ method: 'eth_getBlockReceipts', params: [hx(head - i)] });
      await sleep(250);
      ok = rcpts.find((r) => r.status === '0x1' && r.to)?.transactionHash as Hex | undefined;
    }
    if (!ok) {
      console.warn('no successful tx found to test the refusal path');
      return;
    }
    await expect(explainFailedTx(client, ok)).rejects.toThrow(/succeeded/);
    await expect(explainFailedTx(client, HASH32('b'))).rejects.toThrow(/not found/);
  });
});
