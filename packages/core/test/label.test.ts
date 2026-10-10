import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256 } from 'viem';
import { buildSlotLabeler, labelerFromLayout, REENTRANCY_GUARD_SLOT, type SlotLabeler } from '../src/label/index.js';
import type { Hex } from '../src/types.js';

const fixtures = path.resolve(import.meta.dirname, 'fixtures');
const POOL: Hex = '0x7a3f00000000000000000000000000000000c21e';
const ALICE: Hex = '0x00000000000000000000000000000000000a11ce';
const BOB: Hex = '0x0000000000000000000000000000000000000b0b';
const w32 = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const mapSlot = (key: Hex, base: bigint) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [`0x${key.slice(2).padStart(64, '0')}` as Hex, w32(base)]));
const k = (slot: string) => `${POOL}:${slot}`;

let lab: SlotLabeler;
beforeAll(async () => {
  // Real solc compilation of a real contract (solc-js; downloads the soljson build on first use).
  lab = await buildSlotLabeler({
    projectDir: fixtures,
    contractName: 'LendingPool',
    address: POOL,
    accounts: [ALICE, BOB],
  });
}, 180_000);

describe('labeler on compiled LendingPool', () => {
  it('base variables', () => {
    expect(lab.label(k(w32(0n)))).toBe('owner');
    expect(lab.label(k(w32(4n)))).toBe('totalDeposits');
    expect(lab.label(k(w32(5n)))).toBe('totalBorrowed');
  });
  it('mapping entries resolve for supplied callers', () => {
    expect(lab.label(k(mapSlot(ALICE, 2n)))).toBe('balances[0x0000…11ce]');
    expect(lab.label(k(mapSlot(BOB, 3n)))).toBe('debt[0x0000…0b0b]');
  });
  it('unknown caller is unresolved, not guessed', () => {
    const other = '0x00000000000000000000000000000000000000ee' as Hex;
    expect(lab.label(k(mapSlot(other, 2n)))).toMatch(/^unresolved@0x/);
  });
  it('ERC-7201 reentrancy guard slot', () => {
    expect(lab.label(k(REENTRANCY_GUARD_SLOT))).toBe('ReentrancyGuard._status (namespaced)');
  });
  it('account pseudo-slots', () => {
    expect(lab.label(`${ALICE}:account`)).toBe('account(0x0000…11ce) nonce/balance');
  });
  it('slots of other addresses are not mislabelled', () => {
    expect(lab.label(`${ALICE}:${w32(4n)}`)).toMatch(/^0x0000…11ce:0x/);
  });
});

describe('labelerFromLayout (layouts in solc format)', () => {
  const layout = {
    storage: [
      { label: 'owner', slot: '0', offset: 0, type: 't_address' },
      { label: 'nested', slot: '1', offset: 0, type: 't_mapping(t_address,t_mapping(t_uint256,t_uint256))' },
      { label: 'list', slot: '2', offset: 0, type: 't_array(t_uint256)dyn_storage' },
      { label: 'pos', slot: '3', offset: 0, type: 't_struct(P)' },
      { label: 'fixed', slot: '5', offset: 0, type: 't_array(t_uint256)2_storage' },
    ],
    types: {
      t_address: { encoding: 'inplace', label: 'address', numberOfBytes: '20' },
      t_uint256: { encoding: 'inplace', label: 'uint256', numberOfBytes: '32' },
      't_mapping(t_uint256,t_uint256)': { encoding: 'mapping', label: 'mapping(uint256 => uint256)', numberOfBytes: '32', key: 't_uint256', value: 't_uint256' },
      't_mapping(t_address,t_mapping(t_uint256,t_uint256))': { encoding: 'mapping', label: 'm', numberOfBytes: '32', key: 't_address', value: 't_mapping(t_uint256,t_uint256)' },
      't_array(t_uint256)dyn_storage': { encoding: 'dynamic_array', label: 'uint256[]', numberOfBytes: '32', base: 't_uint256' },
      't_array(t_uint256)2_storage': { encoding: 'inplace', label: 'uint256[2]', numberOfBytes: '64', base: 't_uint256' },
      't_struct(P)': {
        encoding: 'inplace', label: 'struct P', numberOfBytes: '64',
        members: [
          { label: 'a', slot: '0', offset: 0, type: 't_uint256', astId: 0, contract: '' },
          { label: 'b', slot: '1', offset: 0, type: 't_uint256', astId: 0, contract: '' },
        ],
      },
    },
  } as any;
  const l = labelerFromLayout(layout, { address: POOL, accounts: [ALICE] });

  it('nested mappings', () => {
    const inner = BigInt(mapSlot(ALICE, 1n));
    expect(l.label(k(mapSlot(w32(7n), inner)))).toBe('nested[0x0000…11ce][7]');
  });
  it('dynamic array length and elements', () => {
    expect(l.label(k(w32(2n)))).toBe('list.length');
    const base = BigInt(keccak256(w32(2n)));
    expect(l.label(k(w32(base + 3n)))).toBe('list[3]');
  });
  it('struct members and static arrays', () => {
    expect(l.label(k(w32(4n)))).toBe('pos.b');
    expect(l.label(k(w32(6n)))).toBe('fixed[1]');
  });
});
