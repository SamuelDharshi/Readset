import { notFound } from 'next/navigation';
import { Forensics } from '@/components/forensics';

export const dynamic = 'force-dynamic';

/** Every analysis has its own URL, so a result can be handed to someone as a link. */
export default async function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) notFound();
  return <Forensics initialHash={hash.toLowerCase()} />;
}
