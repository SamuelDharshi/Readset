import { redirect } from 'next/navigation';
import { Forensics } from '@/components/forensics';

export const dynamic = 'force-dynamic';

/**
 * Kept as the entry point people already have links to. With ?hash= it redirects to the
 * canonical /tx/<hash>, so a shared URL always carries its result.
 */
export default async function Why({
  searchParams,
}: {
  searchParams: Promise<{ hash?: string }>;
}) {
  const { hash } = await searchParams;
  if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) redirect(`/tx/${hash.toLowerCase()}`);
  return <Forensics />;
}
