/**
 * Live Monad testnet (chain 10143). Nothing is mocked and nothing is signed: both cases are
 * refusals, so no funded key is needed. Skips loudly if the RPC is unreachable.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createGuardedWalletClient,
  isDoomedTxError,
  receiptsPath,
  type GuardedWalletClient,
  type Policy,
} from '../src/index.js';
import {
  ERC20_TRANSFER_FROM_ABI,
  PROJECT_WALLET,
  RPC_URL,
  addressWalletClient,
  findDoomedTransferFrom,
  networkDown,
  publicClient,
} from './helpers.js';

const POLICY: Policy = {
  maxConsecutiveReverts: 5,
  maxBurnPerHourWei: '100000000000000000',
  perTarget: [],
  gasBufferPct: 20,
  failClosed: true,
  // The shipped default. Measured: refusing on any revert wrongly refuses 8.53% of real
  // sends (docs/benchmark.md), so a reverting simulation only warns unless asked otherwise.
  refuseOnRevert: 'warn',
  stableRevertLookback: 3,
};

/** For the tests that exercise the refusal path itself, which is opt-in. */
const REFUSING_POLICY: Policy = { ...POLICY, refuseOnRevert: 'any' };

let skip: string | null = null;
let guarded: GuardedWalletClient<ReturnType<typeof addressWalletClient>>;
const pub = publicClient();

beforeAll(async () => {
  process.env.READSET_STATE_DIR = await mkdtemp(join(tmpdir(), 'readset-viem-'));
  skip = await networkDown();
  if (skip) {
    console.warn(`\n*** SKIPPING @readset/viem live tests: ${skip} ***\n`);
    return;
  }
  guarded = createGuardedWalletClient({
    walletClient: addressWalletClient(),
    publicClient: pub,
    policy: POLICY,
  });
});

/** Receipts written by whichever store is in force (core's, or the stand-in's JSONL). */
async function findReceipt(id: string) {
  const viaApi = (await guarded.readset.receipts(50)).find((r) => r.id === id);
  if (viaApi) return viaApi;
  const text = await readFile(receiptsPath(), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((r: { id: string }) => r.id === id);
}

describe('createGuardedWalletClient on Monad testnet', () => {
  it('is drop-in: keeps the viem client surface', () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    expect(guarded.chain?.id).toBe(10143);
    expect(guarded.account?.address?.toLowerCase()).toBe(PROJECT_WALLET.toLowerCase());
    for (const k of ['sendTransaction', 'writeContract', 'signMessage', 'getAddresses', 'request']) {
      expect(typeof (guarded as unknown as Record<string, unknown>)[k]).toBe('function');
    }
    expect(typeof guarded.guard).toBe('function');
  });

  it('refuses a doomed transferFrom (no allowance) with DoomedTxError and writes a receipt', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const doomed = await findDoomedTransferFrom(pub, PROJECT_WALLET);
    if (!doomed) {
      console.warn('\n*** SKIPPING doomed-call test: no live testnet ERC-20 found whose transferFrom reverts ***\n');
      return;
    }
    console.log(`doomed call: token ${doomed.token}, holder ${doomed.holder}`);

    // This asserts the refusal mechanism, so it opts into refuseOnRevert: 'any'.
    const refusing = createGuardedWalletClient({
      walletClient: addressWalletClient(),
      publicClient: pub,
      policy: REFUSING_POLICY,
    });
    const err = await refusing
      .writeContract({
        address: doomed.token,
        abi: ERC20_TRANSFER_FROM_ABI,
        functionName: 'transferFrom',
        args: [doomed.holder, PROJECT_WALLET, 1n],
        chain: guarded.chain,
        account: guarded.account!,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err, 'writeContract should have refused').not.toBeNull();
    if (!isDoomedTxError(err)) throw err;
    expect(err.name).toBe('DoomedTxError');
    expect(err.verdict).toBe('refused_doomed');
    expect(err.receiptId).toMatch(/^[0-9a-f]{16,}$/);
    expect(err.chainId).toBe(10143);
    expect(String(err.revertReason ?? err.reason).length).toBeGreaterThan(0);
    // ERC20InsufficientAllowance(address,uint256,uint256) = 0xfb8f41b2 on OZ v5 tokens.
    if (err.revertData) expect(err.revertData).toMatch(/^0x[0-9a-f]{8}/);

    const receipt = await findReceipt(err.receiptId);
    expect(receipt, 'a dependency receipt must exist for the refusal').toBeTruthy();
    expect(receipt.verdict).toBe('refused_doomed');
    expect(receipt.tx.to.toLowerCase()).toBe(doomed.token.toLowerCase());
    expect(receipt.policyHash).toBeTruthy();
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE');
  });

  it('refuses when the wallet cannot cover gas_limit x price', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const [balance, gasPrice] = await Promise.all([
      pub.getBalance({ address: PROJECT_WALLET }),
      pub.getGasPrice(),
    ]);
    const needed = 21_000n * gasPrice;
    console.log(`wallet ${PROJECT_WALLET}: balance ${balance} wei, 21k x price = ${needed} wei`);
    if (balance >= needed) {
      console.warn(`\n*** SKIPPING funds test: ${PROJECT_WALLET} is now funded (${balance} wei) ***\n`);
      return;
    }

    // A value-0 self-send simulates cleanly, so the only possible refusal is the funds check.
    const decision = await guarded.guard({ to: PROJECT_WALLET, data: '0x', value: 0n });
    expect(decision.allowed).toBe(false);
    expect(decision.verdict).toBe('refused_funds');
    expect(decision.gasLimit).toBeGreaterThan(0n);
    expect(decision.reason).toMatch(/holds|short by|balance|funds|afford|reserve/i);
    expect(decision.receipt.verdict).toBe('refused_funds');

    const err = await guarded
      .sendTransaction({ to: PROJECT_WALLET, value: 0n, chain: guarded.chain, account: guarded.account! })
      .then(
        () => null,
        (e: unknown) => e,
      );
    if (!isDoomedTxError(err)) throw err ?? new Error('sendTransaction should have refused');
    expect(err.verdict).toBe('refused_funds');
    expect(await findReceipt(err.receiptId)).toBeTruthy();
  });

  it('reports breaker state and which functions came from @readset/core', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const breaker = await guarded.readset.breaker();
    expect(breaker.tripped).toBe(false);
    expect(breaker.limits.maxConsecutiveReverts).toBe(5);
    expect(typeof breaker.burnLastHourWei).toBe('string');
    const source = await guarded.readset.source();
    console.log(`core bindings: ${JSON.stringify(source)} (RPC ${RPC_URL})`);
    expect(Object.keys(source)).toContain('gate');
  });
});
