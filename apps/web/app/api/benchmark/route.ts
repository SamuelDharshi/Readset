import { NextResponse } from 'next/server';
import { buildStats } from '@/lib/stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Alias of /api/stats, under the name the benchmark page and scripts use. */
export async function GET() {
  return NextResponse.json({ ok: true, ...(await buildStats()) });
}
