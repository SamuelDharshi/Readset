import type { Metadata } from 'next';
import { Instrument_Serif, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/chrome';

/*
 * Three faces, each with a job: a serif for display lines so the headings carry some character,
 * a tight grotesque for reading, and a mono for anything a reader might compare digit by digit
 * — addresses, slots, gas, MON.
 */
const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-instrument',
  display: 'swap',
});

const sans = Inter_Tight({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-inter-tight',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Readset — spend firewall for agent wallets on Monad',
  description:
    'On Monad a failed transaction pays its full gas limit. Readset simulates before an agent signs, names the storage slot that moved against it, records every decision, and trips a breaker before a loop drains the wallet.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="field" />
        <Nav />
        {children}
      </body>
    </html>
  );
}
