import { NextResponse } from 'next/server';
import { DEFAULT_POLICY, loadPolicy, parsePolicy, policyPath, savePolicy } from '@readset/core';
import { STATE_ROOT } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const policy = loadPolicy({ root: STATE_ROOT });
    return NextResponse.json({ ok: true, policy, path: policyPath(STATE_ROOT), defaults: DEFAULT_POLICY });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/** Editing policy from a page is a real write, so it is validated through the same schema. */
export async function POST(req: Request) {
  try {
    const patch = (await req.json()) as Record<string, unknown>;
    const next = parsePolicy({ ...loadPolicy({ root: STATE_ROOT }), ...patch });
    const saved = savePolicy(next, { root: STATE_ROOT });
    return NextResponse.json({ ok: true, policy: saved, path: policyPath(STATE_ROOT) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}
