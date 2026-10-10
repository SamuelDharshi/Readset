/**
 * Spawns the real Readset MCP server binary over stdio and drives it with the official MCP
 * client. Live Monad testnet; no mocks. Skips loudly if the RPC is unreachable.
 *
 * READSET_PRIVATE_KEY is deliberately stripped from the child env, so the "no signer" path is
 * exercised and nothing can be signed by this test.
 */
import { mkdtemp } from 'node:fs/promises';
import { offline, OFFLINE_REASON } from '../../../test/offline-flag.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  PROJECT_WALLET,
  findDoomedTransferFrom,
  networkDown,
  publicClient,
} from '../../viem/test/helpers.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'readset-mcp.mjs');

let skip: string | null = null;
let client: Client;
let transport: StdioClientTransport;
const pub = publicClient();

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** Every tool returns exactly one JSON text block. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ json: any; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as CallResult;
  expect(res.content.length, `${name} must return one content block`).toBe(1);
  expect(res.content[0]!.type).toBe('text');
  return { json: JSON.parse(res.content[0]!.text!), isError: res.isError === true };
}

beforeAll(async () => {
  skip = await networkDown();
  if (skip) {
    console.warn(`\n*** SKIPPING @readset/mcp live tests: ${skip} ***\n`);
    return;
  }
  const stateDir = await mkdtemp(join(tmpdir(), 'readset-mcp-'));
  const env: Record<string, string> = { READSET_STATE_DIR: stateDir, READSET_NETWORK: 'testnet' };
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'READSET_PRIVATE_KEY' || k === 'HOTSLOT_PRIVATE_KEY') continue; // no signer on purpose
    if (!(k in env)) env[k] = v;
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: 'pipe' });
  client = new Client({ name: 'readset-mcp-test', version: '0.1.0' });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  // Close the MCP session; the SDK terminates the child it spawned. Never kill by process name.
  await client?.close().catch(() => undefined);
});

describe('readset MCP server over stdio', () => {
  it('lists its tools with input schemas', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('readset_send');
    expect(names).toContain('readset_status');
    expect(names).toContain('readset_policy');
    console.log(`tools: ${names.join(', ')}`);
    // readset_explain exists only when @readset/core exports `explain`.
    for (const t of tools) {
      expect(t.description && t.description.length > 20).toBe(true);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('readset_status returns breaker state, receipts and rolling burn', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const { json, isError } = await call('readset_status', { limit: 5 });
    expect(isError).toBe(false);
    expect(json.ok).toBe(true);
    expect(json.chain.chainId).toBe(10143);
    expect(json.chain.network).toBe('testnet');
    expect(Number(json.chain.blockNumber)).toBeGreaterThan(0);
    expect(json.signerConfigured).toBe(false);
    // Breaker trip state is per wallet. This server runs without a signer, so there is no
    // wallet to report on: status says so instead of inventing a zero-address breaker.
    if (json.breaker === null) {
      expect(json.breakerUnavailable).toMatch(/signer/i);
      expect(json.rollingBurn.lastHourWei).toBeNull();
    } else {
      expect(json.breaker.tripped).toBe(false);
      expect(typeof json.breaker.consecutiveReverts).toBe('number');
      expect(json.rollingBurn.lastHourWei).toMatch(/^\d+$/);
    }
    expect(json.rollingBurn.maxBurnPerHourWei).toMatch(/^\d+$/);
    expect(Array.isArray(json.receipts)).toBe(true);
    // No secret may ever appear in a result. A bare /0x[0-9a-f]{64}/ is not the test:
    // calldata words and storage slot values legitimately have that shape. What must
    // never appear is the configured key itself, or a field that carries one.
    // (Naming the env var in a hint is fine; carrying its value is not.)
    const body = JSON.stringify(json);
    const keyNames: string[] = [];
    JSON.parse(body, function collect(k) {
      if (/privatekey|mnemonic|secret|seed/i.test(k)) keyNames.push(k);
      return (this as Record<string, unknown>)[k];
    });
    expect(keyNames).toEqual([]);
    const key = (process.env.READSET_PRIVATE_KEY ?? process.env.HOTSLOT_PRIVATE_KEY ?? '').trim();
    if (key.length >= 64) {
      expect(body.toLowerCase()).not.toContain(key.toLowerCase().replace(/^0x/, ''));
    }
  });

  it('readset_policy gets and sets the policy', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const got = await call('readset_policy', { action: 'get' });
    expect(got.json.ok).toBe(true);
    expect(got.json.policy.maxConsecutiveReverts).toBeGreaterThan(0);
    expect(got.json.policy.maxBurnPerHourWei).toMatch(/^\d+$/);
    expect(typeof got.json.policy.failClosed).toBe('boolean');

    const set = await call('readset_policy', {
      action: 'set',
      maxConsecutiveReverts: 3,
      maxBurnPerHourWei: '12345',
      gasBufferPct: 25,
    });
    expect(set.json.ok).toBe(true);
    expect(set.json.updated).toBe(true);
    expect(set.json.policy.maxConsecutiveReverts).toBe(3);

    const again = await call('readset_policy', { action: 'get' });
    expect(again.json.policy.maxConsecutiveReverts).toBe(3);
    expect(again.json.policy.maxBurnPerHourWei).toBe('12345');
    expect(again.json.policy.gasBufferPct).toBe(25);
  });

  it('readset_send refuses a doomed transferFrom with a structured verdict', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const doomed = await findDoomedTransferFrom(pub, PROJECT_WALLET);
    if (!doomed) {
      console.warn('\n*** SKIPPING doomed readset_send test: no live testnet ERC-20 found whose transferFrom reverts ***\n');
      return;
    }
    // Refusing on a reverting simulation is opt-in (default 'warn'), so this test sets it:
    // it is asserting the refusal path, not the default.
    const pol = await call('readset_policy', { action: 'set', refuseOnRevert: 'any' });
    expect(pol.json.policy.refuseOnRevert).toBe('any');

    const { json, isError } = await call('readset_send', {
      to: doomed.token,
      data: doomed.data,
      from: PROJECT_WALLET,
      send: false,
    });
    // A refusal is an answer, not a tool fault.
    expect(isError).toBe(false);
    expect(json.ok).toBe(false);
    expect(json.sent).toBe(false);
    expect(json.verdict).toBe('refused_doomed');
    expect(json.allowed).toBe(false);
    expect(typeof json.receiptId).toBe('string');
    expect(json.receiptId.length).toBeGreaterThan(15);
    expect(String(json.revertReason ?? json.reason).length).toBeGreaterThan(0);
    expect(json.breaker.tripped).toBe(false);
    console.log(`readset_send verdict: ${json.verdict} (${json.revertReason ?? json.reason})`);

    // The refusal must show up as a receipt in status.
    const status = await call('readset_status', { limit: 20 });
    expect(status.json.receipts.some((r: { id: string }) => r.id === json.receiptId)).toBe(true);
  });

  it('readset_send with send=true refuses clearly when no signer is configured', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const { json, isError } = await call('readset_send', { to: PROJECT_WALLET, send: true });
    expect(isError).toBe(true);
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('NO_SIGNER');
    expect(json.error.message).toMatch(/READSET_PRIVATE_KEY/);
    expect(json.error.hint).toMatch(/send=false|server env/);
    expect(JSON.stringify(json)).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('rejects malformed input instead of guessing', async () => {
    if (skip) return expect(skip).toBeTypeOf('string');
    const err = await client.callTool({ name: 'readset_send', arguments: { to: 'not-an-address' } }).then(
      (r) => r as CallResult,
      (e: unknown) => e as Error,
    );
    if (err instanceof Error) {
      expect(err.message).toMatch(/to|invalid|pattern/i);
    } else {
      expect(err.isError).toBe(true);
    }
  });
});
