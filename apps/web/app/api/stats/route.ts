import { NextResponse } from 'next/server';
import { buildStats } from '@/lib/stats';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, ...(await buildStats()) });
}
