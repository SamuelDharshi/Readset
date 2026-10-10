import { NextResponse } from 'next/server';
import {
  gate,
  loadPolicy,
  makePublicClient,
  parsePolicy,
  recordAttempt,
  resolveChainConfig,
} from '@readset/core';
import { STATE_ROOT } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEXDATA = /^0x([0-9a-fA-F]{2})*$/;

interface Body {
  from?: string;
  to?: string;
  data?: string;
  value?: string;
  network?: 'testnet' | 'mainnet';
  /** Policy overrides for this one call (the playground's refusal-mode switch). */
  policy?: Record<string, unknown>;
  /** Write a receipt for this decision. Off by default: the playground is exploratory. */
  record?: boolean;
}

/**
 * The gate, over HTTP. Runs the same `gate()` the viem wrapper, the MCP server and the plugin
 * run, against real chain state — nothing here is simulated twice or faked.
 *
 * Read-only: it never signs and never sends.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const from = (body.from ?? '').trim();
  const to = (body.to ?? '').trim();
  const data = (body.data ?? '0x').trim() || '0x';

  if (!ADDRESS.test(from)) {
    return NextResponse.json({ ok: false, error: '`from` must be a 20-byte address' }, { status: 400 });
  }
  if (!ADDRESS.test(to)) {
    return NextResponse.json({ ok: false, error: '`to` must be a 20-byte address' }, { status: 400 });
  }
  if (!HEXDATA.test(data)) {
    return NextResponse.json(
      { ok: false, error: '`data` must be even-length hex calldata' },
      { status: 400 },
    );
  }
  let value: bigint | undefined;
  if (body.value !== undefined && body.value !== '') {
    if (!/^\d+$/.test(body.value)) {
      return NextResponse.json({ ok: false, error: '`value` must be decimal wei' }, { status: 400 });
    }
    value = BigInt(body.value);
  }

  const network = body.network === 'mainnet' ? 'mainnet' : 'testnet';

  try {
    const cfg = resolveChainConfig({ network });
    const client = makePublicClient(cfg);
    const policy = parsePolicy({ ...loadPolicy({ root: STATE_ROOT }), ...(body.policy ?? {}) });

    const tx = {
      from: from.toLowerCase() as `0x${string}`,
      to: to.toLowerCase() as `0x${string}`,
      ...(data === '0x' ? {} : { data: data as `0x${string}` }),
      ...(value === undefined ? {} : { value }),
      chainId: cfg.chain.id,
    };

    const g = await gate({ client, tx, policy });
    const reason = g.doomed?.revertReason ?? g.doomed?.reason ?? g.funds?.reason ?? g.error;

    let receiptId: string | undefined;
    if (body.record) {
      const r = recordAttempt(
        {
          chainId: tx.chainId,
          tx: {
            from: tx.from,
            to: tx.to,
            ...(tx.data === undefined ? {} : { data: tx.data }),
            ...(tx.value === undefined ? {} : { value: tx.value.toString() }),
            ...(g.gasLimitChosen === undefined ? {} : { gasLimitChosen: g.gasLimitChosen.toString() }),
          },
          verdict: g.verdict,
          policy,
          ...(g.doomed === undefined ? {} : { doomed: g.doomed }),
          ...(g.dependencySet === undefined ? {} : { dependencySet: g.dependencySet }),
        },
        { root: STATE_ROOT },
      );
      receiptId = r.id;
    }

    return NextResponse.json(
      JSON.parse(
        JSON.stringify(
          {
            ok: true,
            network,
            chainId: cfg.chain.id,
            verdict: g.verdict,
            allowed: g.verdict === 'allowed',
            reason: reason ?? null,
            // Present when the simulation reverted but the policy only warns.
            warned: g.warnedDoomed ?? null,
            gasLimitChosen: g.gasLimitChosen ?? null,
            simulation: g.simulation ?? null,
            block: g.block ?? null,
            funds: g.funds ?? null,
            dependencySlots: g.dependencySet?.slots.length ?? 0,
            dependencyCoverage: g.dependencySet?.coverage ?? null,
            timeDependent: g.dependencySet?.time?.flagged ?? null,
            policy: { refuseOnRevert: policy.refuseOnRevert, gasBufferPct: policy.gasBufferPct },
            receiptId: receiptId ?? null,
          },
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      ),
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
