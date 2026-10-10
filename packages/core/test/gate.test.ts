// Gate tests. Every network assertion runs against a REAL Monad endpoint (testnet 10143 and mainnet 143),
// read-only: eth_call / eth_estimateGas / debug_traceCall / eth_getBalance. Nothing is mocked or stubbed.
// If an endpoint is unreachable the affected tests skip LOUDLY (console.warn + ctx.skip) rather than pass.
import { beforeAll, describe, expect, it } from 'vitest';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';
import { makePublicClient, slotKey, type Hex, type TxRequest } from '../src/index.js';
import {
  buildDependencySet,
  checkFunds,
  chooseGasLimit,
  createGateRpc,
  decodeRevertReason,
  endpointsFor,
  gate,
  MIN_TX_GAS,
  MONAD_TX_GAS_LIMIT,
  pinBlock,
  RESERVE_BALANCE_WEI,
  scanBytecode,
  simulate,
  timeDependenceFromCode,
  type PinnedBlock,
} from '../src/gate/index.js';

// ---------------------------------------------------------------- real on-chain fixtures
//
// Multicall3 is deployed at the same canonical address on both Monad networks (verified live, 7618 bytes of
// code on each). It gives us three deterministic cases without deploying anything:
//   - getCurrentBlockTimestamp(): succeeds, and its bytecode really uses TIMESTAMP (0x42)
//   - aggregate([(target, 0xdeadbeef)]): reverts with Error(string) "Multicall3: call failed"
const MULTICALL3: Hex = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC_ABI = [
  { name: 'getCurrentBlockTimestamp', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'getEthBalance', type: 'function', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    name: 'aggregate',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }] },
    ],
    outputs: [{ type: 'uint256' }, { type: 'bytes[]' }],
  },
] as const;

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** An address with no balance on either network (verified live: 0 wei on both). */
const UNFUNDED: Hex = `0x${'ab'.repeat(20)}`;

/**
 * The burn address, used as the `from` of the allowed/doomed cases. It holds MON on both networks (it only
 * ever receives), has no code, and we never sign anything with it: `eth_call`/`eth_estimateGas` do not need
 * a key. Its balance is asserted in the tests that depend on it rather than assumed.
 */
const FUNDED: Hex = '0x000000000000000000000000000000000000dEaD';

interface Net {
  name: 'testnet' | 'mainnet';
  chainId: number;
  /** A real ERC20 whose balances mapping lives at `balanceSlot` (both verified live). */
  token: Hex;
  holder: Hex;
  balanceSlot: number;
}

// token/holder pairs and their mapping slots were confirmed against the live chains (and against
// docs/kill-tests/K1.md, which used the same mainnet WMON holder for exactly this check).
const NETS: Net[] = [
  {
    name: 'mainnet',
    chainId: 143,
    token: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', // WMON (canonical, docs.monad.xyz network-information)
    holder: '0xd5b70d70cbe6c42bcd1aaa662a21673a83f4615b',
    balanceSlot: 3,
  },
  {
    name: 'testnet',
    chainId: 10143,
    token: '0x0f1c3b7a1598297f22a21ac2561dea31b8037b2e', // ERC20 picked by the K1 probe (results/k1.json)
    holder: '0x14a44f05e28b7c82552cd36ae01ca11205c41a4b',
    balanceSlot: 0,
  },
];

const balanceSlotOf = (holder: Hex, slot: number): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(slot)]));

// ---------------------------------------------------------------- pure units (no network)

describe('revert decoding (pure)', () => {
  it('decodes Error(string)', () => {
    const data =
      '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000174d756c746963616c6c333a2063616c6c206661696c6564000000000000000000' as Hex;
    expect(decodeRevertReason(data)).toBe('Multicall3: call failed');
  });

  it('decodes Panic(uint) with a named code', () => {
    const panic = (code: number): Hex =>
      `0x4e487b71${code.toString(16).padStart(64, '0')}` as Hex;
    expect(decodeRevertReason(panic(0x11))).toBe('Panic(0x11): arithmetic overflow or underflow');
    expect(decodeRevertReason(panic(0x12))).toBe('Panic(0x12): division or modulo by zero');
    expect(decodeRevertReason(panic(0x32))).toBe('Panic(0x32): array index out of bounds');
    expect(decodeRevertReason(panic(0x99))).toBe('Panic(0x99)');
  });

  it('passes a custom-error selector through without guessing a name', () => {
    const r = decodeRevertReason(`0xfb8f41b2${'00'.repeat(32)}` as Hex)!;
    expect(r).toContain('custom error 0xfb8f41b2');
    expect(r).toContain('no ABI available');
    expect(decodeRevertReason('0xdeadbeef')).toBe('custom error 0xdeadbeef (no ABI available to name it)');
    expect(decodeRevertReason('0x')).toBeUndefined();
    expect(decodeRevertReason(undefined)).toBeUndefined();
  });
});

describe('bytecode scan (pure)', () => {
  it('finds TIMESTAMP and NUMBER opcodes', () => {
    expect(scanBytecode('0x4200')).toEqual({ timestamp: true, number: false, size: 2 });
    expect(scanBytecode('0x4300')).toEqual({ timestamp: false, number: true, size: 2 });
  });

  it('skips PUSH immediates so pushed 0x42/0x43 bytes are not opcodes', () => {
    // PUSH1 0x42 ; STOP
    expect(scanBytecode('0x604200').timestamp).toBe(false);
    // PUSH2 0x4243 ; STOP
    expect(scanBytecode('0x6142 4300'.replace(/ /g, '') as Hex)).toEqual({ timestamp: false, number: false, size: 4 });
    // PUSH1 0x42 ; TIMESTAMP
    expect(scanBytecode('0x604242').timestamp).toBe(true);
    expect(scanBytecode('0x')).toEqual({ timestamp: false, number: false, size: 0 });
    expect(scanBytecode(undefined)).toEqual({ timestamp: false, number: false, size: 0 });
  });

  it('aggregates per-contract scans and never claims a re-sim it did not run', () => {
    const t = timeDependenceFromCode([
      { address: '0x0000000000000000000000000000000000000001', code: '0x42' },
      { address: '0x0000000000000000000000000000000000000002', code: '0x604200' },
      { address: '0x0000000000000000000000000000000000000003', code: '0x43' },
    ]);
    expect(t.flagged).toBe(true);
    expect(t.contracts).toEqual([
      '0x0000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000003',
    ]);
    expect(t.opcodes.sort()).toEqual(['NUMBER', 'TIMESTAMP']);
    // K1: Monad rejects/ignores block overrides, so a +1-block differential cannot be run on the RPC.
    expect(t.confirmedByResim).toBeUndefined();
    expect(timeDependenceFromCode([{ address: '0x0000000000000000000000000000000000000001', code: '0x00' }])).toEqual({
      flagged: false,
      contracts: [],
      opcodes: [],
    });
  });
});

describe('chooseGasLimit (pure)', () => {
  it('adds the buffer, rounding up', () => {
    expect(chooseGasLimit(100_000n)).toBe(120_000n); // default 20%
    expect(chooseGasLimit(100_000n, { bufferPct: 0 })).toBe(100_000n);
    expect(chooseGasLimit(100_000n, { bufferPct: 12.5 })).toBe(112_500n);
    expect(chooseGasLimit(3n, { bufferPct: 10, minGas: 0n })).toBe(4n); // 3.3 -> 4
  });

  it('clamps to Monad limits and refuses to guess', () => {
    expect(chooseGasLimit(1n)).toBe(MIN_TX_GAS);
    expect(chooseGasLimit(MONAD_TX_GAS_LIMIT)).toBe(MONAD_TX_GAS_LIMIT);
    expect(() => chooseGasLimit(0n)).toThrow(/positive/);
    expect(() => chooseGasLimit(-1n)).toThrow(/positive/);
    expect(() => chooseGasLimit(1000n, { bufferPct: -1 })).toThrow(/bufferPct/);
  });
});

// ---------------------------------------------------------------- real network

for (const net of NETS) {
  describe(`gate against real Monad ${net.name}`, () => {
    const client = makePublicClient({ env: { READSET_NETWORK: net.name }, retryCount: 2, timeoutMs: 20_000 });
    const rpc = createGateRpc(client, { timeoutMs: 2_000, patientTimeoutMs: 20_000 });
    let reachable = false;
    let reason = '';
    let pinned: PinnedBlock;

    beforeAll(async () => {
      if (offline()) {
        reason = OFFLINE_REASON;
        return;
      }
      try {
        const id = await rpc.request<Hex>('eth_chainId', []);
        reachable = Number(BigInt(id)) === net.chainId;
        if (!reachable) reason = `unexpected chain id ${Number(BigInt(id))}, wanted ${net.chainId}`;
        else pinned = await pinBlock(rpc, 'latest');
      } catch (e) {
        reason = `Monad ${net.name} RPC unreachable: ${(e as Error).message.split('\n')[0]}`;
      }
      if (!reachable) console.warn(`SKIPPING all ${net.name} gate tests: ${reason}`);
    }, 120_000);

    const live = (name: string, fn: () => Promise<void>) =>
      it(
        name,
        async (ctx) => {
          if (!reachable) return ctx.skip(reason);
          await fn();
        },
        150_000,
      );

    const goodTx = (): TxRequest => ({
      from: FUNDED,
      to: MULTICALL3,
      data: encodeFunctionData({ abi: MC_ABI, functionName: 'getCurrentBlockTimestamp' }),
      chainId: net.chainId,
    });

    const doomedTx = (): TxRequest => ({
      from: FUNDED,
      to: MULTICALL3,
      data: encodeFunctionData({
        abi: MC_ABI,
        functionName: 'aggregate',
        args: [[{ target: MULTICALL3, callData: '0xdeadbeef' }]],
      }),
      chainId: net.chainId,
    });

    const readTx = (): TxRequest => ({
      from: net.holder,
      to: net.token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [net.holder] }),
      chainId: net.chainId,
    });

    it('derives a failover endpoint list from the chain config', () => {
      const eps = endpointsFor(client);
      expect(eps.length).toBeGreaterThanOrEqual(2);
      expect(eps.every((u) => u.startsWith('https://'))).toBe(true);
      expect(rpc.endpoints[0]).toBe(eps[0]);
    });

    live('simulate pins a real block and reports success with gas from eth_estimateGas', async () => {
      const sim = await simulate(client, goodTx(), 'latest', { rpc });
      expect(sim.success).toBe(true);
      expect(sim.revertData).toBeUndefined();
      expect(sim.gasUsed).toBeGreaterThan(MIN_TX_GAS);
      expect(sim.block.number).toBeGreaterThan(0n);
      expect(sim.block.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sim.block.timestamp).toBeGreaterThan(1_700_000_000n);
      // getCurrentBlockTimestamp() returns the pinned block's own timestamp: the simulation really ran
      // against the state we pinned, not some other block.
      expect(BigInt(sim.returnData!)).toBe(sim.block.timestamp);
    });

    live('simulate pinned by hash is reproducible', async () => {
      const a = await simulate(client, goodTx(), pinned.hash, { rpc });
      const b = await simulate(client, goodTx(), pinned.hash, { rpc });
      expect(a.block).toEqual(pinned);
      expect(b.returnData).toBe(a.returnData);
      expect(b.gasUsed).toBe(a.gasUsed);
    });

    live('a real reverting call is refused_doomed under refuseOnRevert: any', async () => {
      const r = await gate({
        client,
        tx: doomedTx(),
        rpc,
        blockTag: pinned.hash,
        policy: { refuseOnRevert: 'any' },
      });
      expect(r.verdict).toBe('refused_doomed');
      expect(r.simulation!.success).toBe(false);
      expect(r.doomed!.revertReason).toBe('Multicall3: call failed');
      expect(r.doomed!.revertData!.startsWith('0x08c379a0')).toBe(true);
      expect(r.doomed!.reason).toContain('Multicall3: call failed');
      expect(r.gasLimitChosen).toBeUndefined();
      // A refused send still gets a dependency set, so the receipt can be diffed later.
      expect(r.dependencySet).toBeDefined();
    });

    live('the DEFAULT policy warns instead of refusing a reverting call', async () => {
      // Measured: refusing on any revert at `latest` wrongly refuses 8.53% of sends that
      // actually succeed (docs/benchmark.md), so 'warn' is the default and the evidence
      // is carried on the result rather than turned into a refusal.
      const r = await gate({ client, tx: doomedTx(), rpc, blockTag: pinned.hash });
      expect(r.policy.refuseOnRevert).toBe('warn');
      expect(r.verdict).toBe('allowed');
      expect(r.doomed).toBeUndefined();
      expect(r.warnedDoomed!.revertReason).toBe('Multicall3: call failed');
      // No limit is chosen: the call reverted, so there is no honest simulated gas to size one from.
      expect(r.gasLimitChosen).toBeUndefined();
    });

    live('refuseOnRevert: stable refuses only when the revert reproduces earlier', async () => {
      const r = await gate({
        client,
        tx: doomedTx(),
        rpc,
        blockTag: pinned.hash,
        policy: { refuseOnRevert: 'stable', stableRevertLookback: 3 },
      });
      // This call reverts for a reason that does not depend on recent state (a failing
      // Multicall3 sub-call), so it must reproduce 3 blocks back and be refused.
      expect(r.revertReproduced).toBe(true);
      expect(r.verdict).toBe('refused_doomed');
      expect(r.doomed!.reason).toContain('3 blocks back');
    });

    live('a known-good call is allowed, with a gas limit above simulated gas', async () => {
      const r = await gate({ client, tx: goodTx(), rpc, blockTag: pinned.hash, policy: { gasBufferPct: 25 } });
      expect(r.verdict).toBe('allowed');
      expect(r.doomed).toBeUndefined();
      expect(r.gasLimitChosen).toBe(chooseGasLimit(r.simulation!.gasUsed, { bufferPct: 25 }));
      expect(r.gasLimitChosen!).toBeGreaterThan(r.simulation!.gasUsed);
      expect(r.funds!.ok).toBe(true);
      // Monad charges the limit, so the funds check must price the LIMIT, not the simulated usage.
      expect(r.funds!.maxFeeWei).toBe(r.gasLimitChosen! * r.funds!.maxFeePerGas);
      expect(r.block).toEqual(pinned);
      expect(r.policy.gasBufferPct).toBe(25);
    });

    live('the dependency set contains the read-only balance slot (non-diff coverage, K1)', async () => {
      const tx = readTx();
      const ds = await buildDependencySet(client, tx, pinned, { rpc });
      expect(ds.coverage).toBe('full');
      expect(ds.simulation.success).toBe(true);

      const want = balanceSlotOf(net.holder, net.balanceSlot).toLowerCase();
      const hit = ds.slots.find((s) => s.address === net.token.toLowerCase() && s.slot === want);
      expect(
        hit,
        `expected the balances[${net.holder}] slot ${want} on ${net.token} in the dependency set; got ${JSON.stringify(ds.slots)}`,
      ).toBeDefined();
      // balanceOf writes nothing: this slot is a READ-ONLY dependency, which is exactly what diffMode
      // cannot see (docs/kill-tests/K1.md caveat 1).
      expect(hit!.readOnly).toBe(true);
      expect(hit!.valueSeen).toMatch(/^0x[0-9a-f]{64}$/);
      expect(ds.slots.every((s) => s.readOnly)).toBe(true);

      // sender account facts come from the pinned block
      const sender = ds.accounts.find((a) => a.address === net.holder.toLowerCase());
      expect(sender).toBeDefined();
      expect(sender!.nonce).toBeGreaterThanOrEqual(0);
      expect(sender!.balance).toBeGreaterThanOrEqual(0n);

      // a diffMode trace of the same call reports no storage at all: the proof that non-diff is required
      const diffOnly = await rpc.request<{ pre: Record<string, { storage?: Record<string, string> }> }>(
        'debug_traceCall',
        [
          { from: tx.from, to: tx.to, data: tx.data },
          { blockHash: pinned.hash },
          { tracer: 'prestateTracer', tracerConfig: { diffMode: true } },
        ],
      );
      const diffSlots = Object.values(diffOnly.pre ?? {}).reduce((n, v) => n + Object.keys(v.storage ?? {}).length, 0);
      expect(diffSlots).toBe(0);
    });

    live('a slot labeller is applied when supplied', async () => {
      const tx = readTx();
      const want = balanceSlotOf(net.holder, net.balanceSlot).toLowerCase();
      const key = slotKey(net.token, want);
      const ds = await buildDependencySet(client, tx, pinned, {
        rpc,
        labeller: { label: (k: string) => (k === key ? 'balanceOf[holder]' : `unresolved@${k}`), truncated: false },
      });
      expect(ds.slots.find((s) => s.slot === want)!.label).toBe('balanceOf[holder]');
    });

    live('the bytecode scan flags a real contract that uses block.timestamp', async () => {
      const ds = await buildDependencySet(client, goodTx(), pinned, { rpc });
      expect(ds.time.flagged).toBe(true);
      expect(ds.time.contracts).toContain(MULTICALL3.toLowerCase());
      expect(ds.time.opcodes).toContain('TIMESTAMP');
      // The +1-block differential is not run: Monad's RPC rejects eth_call block overrides and silently
      // ignores debug_traceCall blockOverrides (docs/kill-tests/K1.md), so this stays undefined.
      expect(ds.time.confirmedByResim).toBeUndefined();

      // Confirmed independently against the deployed code.
      const code = await rpc.request<Hex>('eth_getCode', [MULTICALL3, { blockHash: pinned.hash }]);
      expect(scanBytecode(code).timestamp).toBe(true);
    });

    live('an unfunded sender cannot cover gas_limit x price and is refused_funds', async () => {
      const tx: TxRequest = { ...goodTx(), from: UNFUNDED };
      const balance = BigInt(await rpc.request<Hex>('eth_getBalance', [UNFUNDED, { blockHash: pinned.hash }]));
      expect(balance, 'fixture address must really be empty on this network').toBe(0n);

      const price = BigInt(await rpc.request<Hex>('eth_gasPrice', []));
      const funds = await checkFunds(client, tx, 200_000n, price, { rpc, pinnedBlock: pinned });
      expect(funds.ok).toBe(false);
      expect(funds.balance).toBe(0n);
      expect(funds.maxFeeWei).toBe(200_000n * price);
      expect(funds.requiredWei).toBe(funds.maxFeeWei);
      expect(funds.shortfallWei).toBe(-funds.requiredWei);
      expect(funds.reserveBalanceWei).toBe(RESERVE_BALANCE_WEI);
      expect(funds.delegated).toBe(false);
      expect(funds.reason).toContain('gas limit');

      const r = await gate({ client, tx, rpc, blockTag: pinned.hash });
      expect(r.verdict).toBe('refused_funds');
      expect(r.simulation!.success).toBe(true); // the call itself is fine; the sender simply cannot pay
      expect(r.funds!.ok).toBe(false);
      expect(r.gasLimitChosen).toBeGreaterThan(0n);
    });

    live('a funded sender passes the funds check at the live price', async () => {
      const price = BigInt(await rpc.request<Hex>('eth_gasPrice', []));
      const balance = BigInt(await rpc.request<Hex>('eth_getBalance', [FUNDED, { blockHash: pinned.hash }]));
      expect(balance, 'fixture sender must really hold MON on this network').toBeGreaterThan(0n);
      const limit = 100_000n;
      const funds = await checkFunds(client, goodTx(), limit, price, { rpc, pinnedBlock: pinned });
      expect(funds.balance).toBe(balance);
      expect(funds.requiredWei).toBe(limit * price);
      expect(funds.ok).toBe(balance >= funds.requiredWei);
      expect(funds.reserveRisk).toBe(balance - funds.requiredWei < RESERVE_BALANCE_WEI);
      if (!funds.ok) console.warn(`${net.name}: ${FUNDED} now holds less than ${funds.requiredWei} wei`);
    });

    live('a wrong chainId is refused before any simulation', async () => {
      const r = await gate({ client, tx: { ...goodTx(), chainId: 1 }, rpc });
      expect(r.verdict).toBe('refused_policy');
      expect(r.error).toContain('does not match');
      expect(r.simulation).toBeUndefined();
    });

    live('fail-closed: an endpoint that cannot answer yields refused_policy, not a pass', async () => {
      const bad = ['https://127.0.0.1:1/'];
      const r = await gate({
        client,
        tx: goodTx(),
        endpoints: bad,
        timeoutMs: 300,
        patientTimeoutMs: 0,
        policy: { failClosed: true },
      });
      expect(r.verdict).toBe('refused_policy');
      expect(r.error).toContain('fail-closed');

      await expect(
        gate({ client, tx: goodTx(), endpoints: bad, timeoutMs: 300, patientTimeoutMs: 0, policy: { failClosed: false } }),
      ).rejects.toThrow(/failed on all/);
    });

    live('failover: a dead primary is skipped and a real endpoint answers', async () => {
      const pool = createGateRpc(client, {
        endpoints: ['https://127.0.0.1:1/', ...endpointsFor(client)],
        timeoutMs: 2_000,
        patientTimeoutMs: 20_000,
      });
      const id = await pool.request<Hex>('eth_chainId', []);
      expect(Number(BigInt(id))).toBe(net.chainId);
      expect(pool.lastEndpoint).not.toBe('https://127.0.0.1:1/');
    });
  });
}
