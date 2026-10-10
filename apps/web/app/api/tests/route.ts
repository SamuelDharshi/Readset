import { NextResponse } from 'next/server';
import { readResult } from '@/lib/results';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Written by the suite itself (vitest --reporter=json, summarised into results/). Serving the
 * file rather than a hardcoded count means the page cannot claim a green suite nobody ran.
 */
export async function GET() {
  const summary = await readResult<Record<string, unknown>>('test-summary.json');
  if (!summary) {
    return NextResponse.json({
      ok: false,
      error: 'no results/test-summary.json yet',
      hint: 'npx vitest run --reporter=json --outputFile=.readset/tmp/tests.json',
    });
  }
  return NextResponse.json({ ok: true, ...summary });
}
