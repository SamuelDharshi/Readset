import { NextResponse } from 'next/server';
import { emptyCounters, evaluateCounters, parsePolicy } from '@readset/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  /** Consecutive reverts observed for this wallet. */
  consecutiveReverts?: number;
  /** Wei burned by failures inside the rolling hour. */
  burnLastHourWei?: string;
  /** Whose counters these are. Defaults to the zero address for a what-if. */
  wallet?: string;
  policy?: Record<string, unknown>;
}

/**
 * Evaluate the breaker against supplied counters.
 *
 * This is the PURE half of the breaker: it answers "given these counters and this policy, do we
 * halt?". It deliberately does not read or write the durable trip state on disk, so the
 * playground can explore thresholds without arming or tripping an operator's real breaker.
 * The stateful path lives in @readset/core (`checkBreaker` / `recordResult`).
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const consecutive = Number(body.consecutiveReverts ?? 0);
  if (!Number.isInteger(consecutive) || consecutive < 0) {
    return NextResponse.json(
      { ok: false, error: '`consecutiveReverts` must be a non-negative integer' },
      { status: 400 },
    );
  }
  const burn = (body.burnLastHourWei ?? '0').toString();
  if (!/^\d+$/.test(burn)) {
    return NextResponse.json(
      { ok: false, error: '`burnLastHourWei` must be decimal wei' },
      { status: 400 },
    );
  }

  try {
    const policy = parsePolicy(body.policy ?? {});
    const wallet = (/^0x[0-9a-fA-F]{40}$/.test(body.wallet ?? '')
      ? body.wallet!
      : '0x0000000000000000000000000000000000000000') as `0x${string}`;
    const counters = { ...emptyCounters(wallet), consecutiveReverts: consecutive, burnWei: burn };
    const violations = evaluateCounters(counters, policy);
    const halt = violations.length > 0;

    return NextResponse.json(
      JSON.parse(
        JSON.stringify(
          {
            ok: true,
            halt,
            allow: !halt,
            reason: halt ? violations.map((v) => v.reason).join('; ') : null,
            violations,
            counters: { wallet, consecutiveReverts: consecutive, burnLastHourWei: burn },
            policy: {
              maxConsecutiveReverts: policy.maxConsecutiveReverts,
              maxBurnPerHourWei: policy.maxBurnPerHourWei,
            },
          },
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        ),
      ),
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
