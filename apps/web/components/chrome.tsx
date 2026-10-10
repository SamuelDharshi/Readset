'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['/', 'Overview'],
  ['/why', 'Forensics'],
  ['/playground', 'Playground'],
  ['/receipts', 'Receipts'],
  ['/policy', 'Policy'],
  ['/benchmark', 'Benchmark'],
  ['/docs', 'Docs'],
  ['/demo', 'Demo'],
] as const;

/** Edge to edge: no max width, just a gutter that grows with the viewport. */
const WIDE = 'w-full px-6 md:px-10 lg:px-16 xl:px-24 2xl:px-32';

export function Nav() {
  const here = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-white/85 backdrop-blur-md">
      <div className={`${WIDE} flex flex-wrap items-center gap-x-8 gap-y-3 py-3.5`}>
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <span className="grid size-7 place-items-center rounded-md bg-green text-[13px] text-white">
            ◇
          </span>
          <span className="display text-[23px]">Readset</span>
          <span className="hidden text-[12.5px] text-dim sm:inline">spend firewall</span>
        </Link>

        <nav className="flex flex-wrap gap-1">
          {TABS.map(([href, label]) => {
            const on = here === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={on ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-[15px] no-underline transition-colors ${
                  on
                    ? 'bg-green-soft text-green-ink'
                    : 'text-dim hover:bg-sunken hover:text-ink'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <span className="marker ml-auto hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 md:flex">
          <i className="size-1.5 rounded-full bg-green" />
          Mainnet · read-only
        </span>
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return <main className={`${WIDE} pb-28`}>{children}</main>;
}

/** A landing that advances one screen at a time. */
export function ScrollShell({ children }: { children: React.ReactNode }) {
  return <main className={WIDE}>{children}</main>;
}

/**
 * One full-viewport section. `label` is the small marker; `cue` shows the "keep scrolling"
 * hint, which belongs on every screen except the last.
 */
export function Screen({
  label,
  children,
  cue = true,
}: {
  label?: string;
  children: React.ReactNode;
  cue?: boolean;
}) {
  return (
    <section className="screen relative">
      {label ? <Marker>{label}</Marker> : null}
      <div className="w-full">{children}</div>
      {cue ? (
        <div className="cue pointer-events-none absolute inset-x-0 bottom-7 flex justify-center text-dim">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : null}
    </section>
  );
}

/** A full-bleed band with a tinted background, for breaking the page into sections. */
export function Band({
  children,
  tone = 'wash',
}: {
  children: React.ReactNode;
  tone?: 'wash' | 'white';
}) {
  return (
    <section
      className={`band -mx-6 mt-20 px-6 py-16 md:-mx-10 md:px-10 lg:-mx-16 lg:px-16 xl:-mx-24 xl:px-24 2xl:-mx-32 2xl:px-32 ${
        tone === 'wash' ? 'bg-wash' : 'bg-white'
      }`}
    >
      {children}
    </section>
  );
}

export function Marker({ children }: { children: React.ReactNode }) {
  return <div className="marker mb-3.5">{children}</div>;
}

export function H2({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <>
      <h2 className="display mt-20 mb-4 text-[clamp(30px,2.6vw,42px)]">{children}</h2>
      {note ? <p className="mb-7 max-w-[80ch] text-[16.5px] leading-relaxed text-body">{note}</p> : null}
    </>
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_1px_2px_rgba(12,23,16,0.04)] ${className}`}
    >
      {children}
    </div>
  );
}

/** A measured figure. `tone` carries meaning, never decoration. */
export function Stat({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone?: 'warn' | 'good';
}) {
  const colour =
    tone === 'warn' ? 'text-moved' : tone === 'good' ? 'text-green-deep' : 'text-ink';
  return (
    <div className="bg-panel p-6">
      <div className={`num text-[clamp(26px,2vw,34px)] ${colour}`}>{value}</div>
      <div className="mt-2.5 text-[14px] leading-snug text-dim">{label}</div>
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-px overflow-hidden rounded-2xl border border-line bg-line">
      {children}
    </div>
  );
}

export function Tag({
  kind,
  children,
}: {
  kind: 'pass' | 'partial' | 'fail' | 'mute';
  children: React.ReactNode;
}) {
  const map = {
    pass: 'text-green-ink bg-green-soft border-green/30',
    partial: 'text-amber bg-[#fdf6e7] border-amber/25',
    fail: 'text-moved bg-moved-soft border-moved/25',
    mute: 'text-dim bg-sunken border-line',
  } as const;
  return (
    <span className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11.5px] ${map[kind]}`}>
      {children}
    </span>
  );
}

/** A limitation stated plainly. The product's credibility rests on these being present. */
export function Caveat({
  title,
  children,
  tone = 'warn',
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'warn' | 'good';
}) {
  return (
    <div
      className={`my-7 rounded-2xl border border-line border-l-[3px] p-6 ${
        tone === 'good' ? 'border-l-green bg-green-soft/35' : 'border-l-moved bg-moved-soft/45'
      }`}
    >
      <h3 className="display mb-3 text-[24px]">{title}</h3>
      <div className="max-w-[92ch] space-y-3 text-[16px] leading-relaxed text-body">{children}</div>
    </div>
  );
}

export function Empty({ what, cmd }: { what: string; cmd: string }) {
  return (
    <Panel className="p-6">
      <p className="text-[16px] text-body">{what}</p>
      <pre className="mt-3.5 overflow-x-auto rounded-xl border border-line bg-sunken p-4 text-[12.5px] text-ink">
        {cmd}
      </pre>
    </Panel>
  );
}
