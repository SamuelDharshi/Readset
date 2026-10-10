import { explainTx } from '@/lib/explain-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/** Canonical analysis route. /api/explain?hash= is the older alias for the same handler. */
export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return explainTx(hash);
}
