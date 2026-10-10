import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell, Marker, Panel } from '@/components/chrome';
import { findDoc, renderDoc } from '@/lib/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Renders one of the repo's markdown docs. The content is the file; nothing is rewritten here. */
export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = findDoc(slug);
  if (!entry) notFound();
  const html = await renderDoc(entry);
  if (!html) notFound();

  return (
    <Shell>
      <section className="pt-14 pb-6">
        <Marker>{entry.group}</Marker>
        <h1 className="display text-[clamp(32px,3.6vw,52px)]">{entry.title}</h1>
        <p className="mt-3 font-mono text-[13.5px] text-faint">docs/{entry.file}</p>
      </section>

      <Panel className="p-7 md:p-10">
        <article className="prose-readset" dangerouslySetInnerHTML={{ __html: html }} />
      </Panel>

      <p className="mt-7">
        <Link
          href="/docs"
          className="text-green-ink underline decoration-green/40 underline-offset-4 hover:decoration-green-ink"
        >
          ← all docs
        </Link>
      </p>
    </Shell>
  );
}
