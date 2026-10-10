import { explainTx } from '@/lib/explain-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

/** Older alias. The canonical route is /api/tx/[hash]; both share one handler. */
export async function GET(req: Request) {
  return explainTx(new URL(req.url).searchParams.get('hash') ?? '');
}
