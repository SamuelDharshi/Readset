/**
 * Readset MCP server: the gate, breaker and receipts exposed as agent tools.
 *
 * Tools: readset_send, readset_status, readset_policy, and readset_explain (registered only
 * when @readset/core exports `explain`). Every result is a single JSON object in one text
 * block, so an agent can parse it without prose. Secrets are never returned: the server only
 * ever reports whether a signer is configured.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makePublicClient, makeWalletClient, resolveChainConfig, redactUrl } from '@readset/core';
import type { PublicClient } from 'viem';
import {
  createGuardedWalletClient,
  guard,
  isDoomedTxError,
  loadCoreBindings,
  type GuardDecision,
  type Hex,
  type Policy,
  type Receipt,
  type TxRequest,
} from '@readset/viem';

export const SERVER_NAME = 'readset';
export const SERVER_VERSION = '0.1.0';

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;

export interface ReadsetServerOptions {
  /** 'testnet' | 'mainnet'; default READSET_NETWORK or testnet. */
  network?: string;
  rpcUrl?: string;
  /** Injected for tests; otherwise built from the resolved chain config. */
  publicClient?: PublicClient;
  env?: Record<string, string | undefined>;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const jsonText = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const ok = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: jsonText({ ok: true, ...value }) }],
});

/** A refusal is a valid answer, not a tool fault: ok:false, isError stays false. */
const refusal = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: jsonText({ ok: false, ...value }) }],
});

/** A fault the agent must fix (bad input, missing signer, RPC down): isError true. */
const fault = (code: string, message: string, hint?: string): ToolResult => ({
  content: [{ type: 'text', text: jsonText({ ok: false, error: { code, message, hint } }) }],
  isError: true,
});

function decisionJson(d: GuardDecision): Record<string, unknown> {
  return {
    verdict: d.verdict,
    allowed: d.allowed,
    reason: d.reason,
    revertReason: d.doomed?.revertReason,
    revertData: d.doomed?.revertData,
    gasLimit: d.gasLimit !== undefined ? String(d.gasLimit) : undefined,
    receiptId: d.receipt.id,
    policyHash: d.receipt.policyHash,
    breaker: d.breaker,
    dependencySet: d.dependencySet,
    source: d.source,
  };
}

const receiptJson = (r: Receipt) => ({
  id: r.id,
  createdAt: r.createdAt,
  chainId: r.chainId,
  verdict: r.verdict,
  to: r.tx.to,
  from: r.tx.from,
  value: r.tx.value,
  gasLimitChosen: r.tx.gasLimitChosen,
  revertReason: r.doomed?.revertReason,
  txHash: r.txHash,
  outcome: r.outcome,
});

export function createReadsetServer(opts: ReadsetServerOptions = {}): {
  server: McpServer;
  info: { chainId: number; network: string; rpcUrl: string; signerConfigured: boolean };
} {
  const env = opts.env ?? process.env;
  const chainOpts = { network: opts.network, rpcUrl: opts.rpcUrl, env };
  const cfg = resolveChainConfig(chainOpts);
  const publicClient = opts.publicClient ?? (makePublicClient(chainOpts) as PublicClient);
  const hasSigner = (): boolean =>
    Boolean((env.READSET_PRIVATE_KEY || env.HOTSLOT_PRIVATE_KEY || '').trim());

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Readset guards transactions before they are signed. On Monad a reverted transaction ' +
        'pays its full gas limit, so call readset_send (send=false to check only) before every ' +
        'send; if it answers ok:false the send was refused and nothing was signed. Use ' +
        'readset_status to see breaker state and rolling burn, readset_policy to read or change ' +
        'limits. Never ask for or pass private keys: the server reads READSET_PRIVATE_KEY itself.',
    },
  );

  // ------------------------------------------------------------------ readset_send
  server.registerTool(
    'readset_send',
    {
      title: 'Readset: guard (and optionally send) a transaction',
      description:
        'Runs breaker -> gate -> receipt for one transaction. With send=false (default) nothing ' +
        'is signed and you get the verdict. With send=true it signs and broadcasts only if the ' +
        'gate allows it, using the gas limit the gate chose; requires READSET_PRIVATE_KEY on the ' +
        'server. Refusal verdicts: refused_doomed, refused_funds, refused_breaker, refused_policy.',
      inputSchema: {
        to: z.string().regex(HEX40).describe('Target address. Contract creation is not supported here.'),
        data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/).optional().describe('Calldata hex, default 0x'),
        value: z.string().regex(/^\d+$/).optional().describe('Value in wei, decimal string'),
        from: z.string().regex(HEX40).optional().describe('Sender; defaults to the server signer address'),
        gas: z.string().regex(/^\d+$/).optional().describe('Pin the gas LIMIT instead of letting the gate choose'),
        send: z.boolean().optional().describe('Sign and broadcast when allowed (default false)'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const wantsSend = args.send === true;
      let from = args.from as Hex | undefined;
      let wallet: ReturnType<typeof makeWalletClient> | undefined;
      if (wantsSend || !from) {
        if (!hasSigner()) {
          if (wantsSend) {
            return fault(
              'NO_SIGNER',
              'READSET_PRIVATE_KEY is not set on the Readset MCP server, so nothing can be signed.',
              'Set READSET_PRIVATE_KEY in the server env (never pass a key as a tool argument), or call readset_send with send=false and an explicit "from" to check the transaction only.',
            );
          }
          if (!from) {
            return fault(
              'NO_FROM',
              'No sender: READSET_PRIVATE_KEY is not set and no "from" was given.',
              'Pass from=<address> to check a transaction without a signer.',
            );
          }
        } else {
          try {
            wallet = makeWalletClient(chainOpts);
            from = wallet.account.address as Hex;
          } catch (e) {
            return fault('SIGNER_INVALID', (e as Error).message, 'Fix READSET_PRIVATE_KEY on the server.');
          }
        }
      }

      const tx: TxRequest = {
        from: from!,
        to: args.to as Hex,
        data: (args.data ?? '0x') as Hex,
        value: args.value ? BigInt(args.value) : 0n,
        gas: args.gas ? BigInt(args.gas) : undefined,
        chainId: cfg.chain.id,
      };

      try {
        if (!wantsSend || !wallet) {
          const d = await guard({ tx, publicClient });
          return d.allowed
            ? ok({ sent: false, ...decisionJson(d) })
            : refusal({ sent: false, ...decisionJson(d) });
        }
        const guarded = createGuardedWalletClient({ walletClient: wallet, publicClient });
        try {
          const hash = await guarded.sendTransaction({
            to: tx.to as Hex,
            data: tx.data,
            value: tx.value,
            gas: tx.gas,
            chain: wallet.chain,
            account: wallet.account,
          });
          const d = guarded.readset.lastDecision!;
          return ok({ sent: true, txHash: hash, ...decisionJson(d) });
        } catch (e) {
          if (isDoomedTxError(e)) {
            return refusal({ sent: false, ...e.toJSON() });
          }
          throw e;
        }
      } catch (e) {
        return fault('GATE_ERROR', (e as Error).message, `RPC ${redactUrl(cfg.rpcUrl)} may be unreachable or rate limited.`);
      }
    },
  );

  // ---------------------------------------------------------------- readset_status
  server.registerTool(
    'readset_status',
    {
      title: 'Readset: breaker state, recent receipts, rolling burn',
      description:
        'Circuit-breaker state (tripped or not, consecutive reverts, burn in the last hour vs ' +
        'the policy limits), the most recent dependency receipts, and chain/signer info. ' +
        'Read-only. Never returns keys.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Receipts to return (default 10)') },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const core = await loadCoreBindings();
        const policy = await core.loadPolicy();
        // Breaker trip state is per wallet, so status needs the configured signer's address.
        // Without a signer we still report policy, receipts and burn, and say why the
        // breaker block is absent rather than inventing a wallet.
        let statusWallet: Hex | undefined;
        try {
          statusWallet = makeWalletClient(chainOpts).account.address as Hex;
        } catch {
          statusWallet = undefined;
        }
        const [breaker, receipts, blockNumber] = await Promise.all([
          statusWallet
            ? core.checkBreaker({ policy, chainId: cfg.chain.id, wallet: statusWallet })
            : Promise.resolve(undefined),
          core.recentReceipts({ limit: args.limit ?? 10, chainId: cfg.chain.id }),
          publicClient.getBlockNumber().catch(() => undefined),
        ]);
        const burnAll = receipts.reduce(
          (acc, r) => acc + (r.outcome?.status === 'reverted' ? BigInt(r.outcome.feePaidWei) : 0n),
          0n,
        );
        return ok({
          chain: {
            chainId: cfg.chain.id,
            network: cfg.network,
            rpcUrl: redactUrl(cfg.rpcUrl),
            blockNumber: blockNumber !== undefined ? String(blockNumber) : null,
          },
          signerConfigured: hasSigner(),
          breaker: breaker ?? null,
          breakerUnavailable: breaker
            ? undefined
            : 'No signer configured: breaker trip state is per wallet, so set READSET_PRIVATE_KEY to see it.',
          rollingBurn: {
            lastHourWei: breaker?.burnLastHourWei ?? null,
            inReturnedReceiptsWei: String(burnAll),
            maxBurnPerHourWei: policy.maxBurnPerHourWei,
          },
          receiptCount: receipts.length,
          receipts: receipts.map(receiptJson),
          coreBindings: core.from,
        });
      } catch (e) {
        return fault('STATUS_ERROR', (e as Error).message);
      }
    },
  );

  // ---------------------------------------------------------------- readset_policy
  server.registerTool(
    'readset_policy',
    {
      title: 'Readset: get or set the spend policy',
      description:
        'action=get returns the policy in force. action=set merges the given fields and persists ' +
        'them. Fields: maxConsecutiveReverts, maxBurnPerHourWei (decimal wei), gasBufferPct, ' +
        'failClosed, refuseOnRevert (warn|stable|any), stableRevertLookback, ' +
        'perTarget[{to,selector,maxConsecutiveReverts,maxBurnPerHourWei}]. ' +
        'refuseOnRevert defaults to warn: refusing on every reverting simulation wrongly ' +
        'refuses about 8.5% of sends that would have succeeded (docs/benchmark.md).',
      inputSchema: {
        action: z.enum(['get', 'set']).describe('get or set'),
        maxConsecutiveReverts: z.number().int().min(1).max(1000).optional(),
        maxBurnPerHourWei: z.string().regex(/^\d+$/).optional(),
        gasBufferPct: z.number().int().min(0).max(500).optional(),
        failClosed: z.boolean().optional(),
        refuseOnRevert: z
          .enum(['warn', 'stable', 'any'])
          .optional()
          .describe('warn = record and send anyway; stable = refuse only if the revert reproduces earlier; any = refuse on any revert'),
        stableRevertLookback: z.number().int().min(1).max(32).optional(),
        perTarget: z
          .array(
            z.object({
              to: z.string().regex(HEX40),
              selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/).optional(),
              maxConsecutiveReverts: z.number().int().min(1).optional(),
              maxBurnPerHourWei: z.string().regex(/^\d+$/).optional(),
            }),
          )
          .optional(),
      },
    },
    async (args) => {
      try {
        const core = await loadCoreBindings();
        const current = await core.loadPolicy();
        if (args.action === 'get') return ok({ policy: current, source: core.from.loadPolicy });
        const next: Policy = {
          ...current,
          ...(args.maxConsecutiveReverts !== undefined ? { maxConsecutiveReverts: args.maxConsecutiveReverts } : {}),
          ...(args.refuseOnRevert !== undefined ? { refuseOnRevert: args.refuseOnRevert } : {}),
          ...(args.stableRevertLookback !== undefined ? { stableRevertLookback: args.stableRevertLookback } : {}),
          ...(args.maxBurnPerHourWei !== undefined ? { maxBurnPerHourWei: args.maxBurnPerHourWei } : {}),
          ...(args.gasBufferPct !== undefined ? { gasBufferPct: args.gasBufferPct } : {}),
          ...(args.failClosed !== undefined ? { failClosed: args.failClosed } : {}),
          ...(args.perTarget !== undefined ? { perTarget: args.perTarget as Policy['perTarget'] } : {}),
        };
        const saved = await core.savePolicy(next);
        return ok({ policy: saved, updated: true });
      } catch (e) {
        return fault('POLICY_ERROR', (e as Error).message);
      }
    },
  );

  return {
    server,
    info: {
      chainId: cfg.chain.id,
      network: cfg.network,
      rpcUrl: redactUrl(cfg.rpcUrl),
      signerConfigured: hasSigner(),
    },
  };
}

/**
 * Register readset_explain if @readset/core exports `explain`. Awaited separately because the
 * binding is resolved at runtime; see docs/mcp.md for the "tool may be absent" note.
 */
export async function registerExplainTool(
  server: McpServer,
  publicClient: PublicClient,
): Promise<boolean> {
  const core = await loadCoreBindings();
  if (!core.explain) return false;
  server.registerTool(
    'readset_explain',
    {
      title: 'Readset: explain a failed transaction',
      description:
        'Given a mined transaction hash, names the dependency slots that moved, who wrote them, ' +
        'whether it was avoidable at N-1/N-2/N-3, and the MON burned.',
      inputSchema: { txHash: z.string().regex(HEX64).describe('Transaction hash to explain') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const explanation = await core.explain!({ txHash: args.txHash as Hex, client: publicClient });
        return ok({ explanation });
      } catch (e) {
        return fault('EXPLAIN_ERROR', (e as Error).message);
      }
    },
  );
  return true;
}
