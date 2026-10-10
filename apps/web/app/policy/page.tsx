'use client';

import { useEffect, useState } from 'react';
import { Shell, H2, Panel, Marker, Tag, Caveat } from '@/components/chrome';
import { n, monFine } from '@/lib/format';

interface Policy {
  maxConsecutiveReverts: number;
  maxBurnPerHourWei: string;
  gasBufferPct: number;
  failClosed: boolean;
  refuseOnRevert: 'warn' | 'stable' | 'any';
  stableRevertLookback: number;
  perTarget: { to: string; selector?: string }[];
}

const MODES: [Policy['refuseOnRevert'], string, string][] = [
  [
    'warn',
    'Warn (default)',
    'Record the reverting simulation in the receipt and feed the breaker, then let the send through. Chosen because refusing on any revert mis-blocks about 8.5% of good sends.',
  ],
  [
    'stable',
    'Stable',
    'Refuse only when the revert still reproduces N blocks earlier. Halves the false-block rate at almost no cost in detection — knowable burn is nearly identical at N−1 and N−3.',
  ],
  [
    'any',
    'Any',
    'Refuse on any reverting simulation. The highest false-refusal rate; reasonable only on a target where a wasted gas limit costs more than a missed opportunity.',
  ],
];

export default function PolicyPage() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [path, setPath] = useState<string>('');
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  /** Loop burn a breaker of 5 would have stopped, read from the census. Never typed in. */
  const [loopSavedMon, setLoopSavedMon] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((x) => {
        const v = x?.census?.loops?.stoppedByBreaker5MON;
        if (typeof v === 'number') setLoopSavedMon(v);
      })
      .catch(() => setLoopSavedMon(null));
  }, []);

  useEffect(() => {
    fetch('/api/policy')
      .then((r) => r.json())
      .then((b) => {
        if (b.ok) {
          setPolicy(b.policy);
          setPath(b.path);
        } else setMsg({ text: b.error, err: true });
      })
      .catch((e) => setMsg({ text: String(e), err: true }));
  }, []);

  async function patch(p: Partial<Policy>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p),
      });
      const b = await r.json();
      if (!b.ok) {
        setMsg({ text: b.error, err: true });
        return;
      }
      setPolicy(b.policy);
      setMsg({ text: `saved to ${b.path}` });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Policy</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">
          What the breaker is allowed to tolerate
        </h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          MetaMask’s own policies decide <em>what</em> an agent may do. Readset’s policy decides
          whether a particular send is worth doing right now, and when to stop the agent entirely.
          Edits here write the same <code className="text-dim">policy.json</code> the viem wrapper,
          the MCP server and the plugin all read.
        </p>
      </section>

      {policy ? (
        <>
          <H2>On a reverting simulation</H2>
          <div className="grid gap-3 md:grid-cols-3">
            {MODES.map(([mode, title, body]) => {
              const on = policy.refuseOnRevert === mode;
              return (
                <button
                  key={mode}
                  disabled={busy}
                  onClick={() => void patch({ refuseOnRevert: mode })}
                  className={`rounded-xl border bg-panel p-5 text-left transition-colors disabled:opacity-50 ${
                    on ? 'border-dep' : 'border-line hover:border-dim'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="font-sans text-[15px]">{title}</h3>
                    {on ? <Tag kind="pass">active</Tag> : null}
                  </div>
                  <p className="text-[13px] leading-relaxed text-dim">{body}</p>
                </button>
              );
            })}
          </div>

          <H2>Thresholds</H2>
          <Panel>
            <table className="w-full border-collapse text-[15.5px]">
              <tbody>
                <tr className="border-b border-line">
                  <td className="px-4 py-3">Max consecutive reverts</td>
                  <td className="num px-4 py-3">{policy.maxConsecutiveReverts}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {[3, 5, 10].map((v) => (
                        <button
                          key={v}
                          disabled={busy}
                          onClick={() => void patch({ maxConsecutiveReverts: v })}
                          className={`rounded-md border px-2.5 py-1 text-[12px] disabled:opacity-50 ${
                            policy.maxConsecutiveReverts === v
                              ? 'border-dep text-ink'
                              : 'border-line text-dim hover:text-ink'
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-4 py-3">Max burn per hour</td>
                  <td className="num px-4 py-3">{monFine(policy.maxBurnPerHourWei)}</td>
                  <td className="px-4 py-3 text-dim">
                    {policy.maxBurnPerHourWei === '0'
                      ? 'zero means unlimited — set one before leaving an agent unattended'
                      : 'sending halts once an hour’s failures cost this much'}
                  </td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-4 py-3">Stable-revert lookback</td>
                  <td className="num px-4 py-3">{policy.stableRevertLookback} blocks</td>
                  <td className="px-4 py-3 text-dim">
                    how far back a revert must reproduce under <code>stable</code>
                  </td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-4 py-3">Gas buffer</td>
                  <td className="num px-4 py-3">{policy.gasBufferPct}%</td>
                  <td className="px-4 py-3 text-dim">
                    over simulated gas. Category Labs’ per-(to, selector) buffer is the better
                    source; this is a flat stand-in and we do not claim to beat their research.
                  </td>
                </tr>
                <tr className="border-b border-line">
                  <td className="px-4 py-3">Fail closed</td>
                  <td className="px-4 py-3">
                    <Tag kind={policy.failClosed ? 'pass' : 'partial'}>
                      {policy.failClosed ? 'yes' : 'no'}
                    </Tag>
                  </td>
                  <td className="px-4 py-3 text-dim">
                    refuse rather than send blind when the simulation infrastructure itself fails
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3">Per-target rules</td>
                  <td className="num px-4 py-3">{n(policy.perTarget.length)}</td>
                  <td className="px-4 py-3 text-dim">
                    tighter limits for one (contract, selector) pair — where opting into hard refusal
                    makes sense
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <p className={`mt-3 min-h-5 text-[12.5px] ${msg?.err ? 'text-moved' : 'text-dim'}`}>
            {msg?.text ?? (path ? `reading ${path}` : '')}
          </p>

          <Caveat title="The breaker needs no prediction to be useful">
            <p>
              The guard has to guess whether a transaction will fail, and in the aggressive setting
              it is wrong a meaningful share of the time. The breaker guesses nothing: it counts
              outcomes. Over 30 days of mainnet, a breaker of 5 would have stopped{' '}
              {loopSavedMon === null ? '—' : `${Math.round(loopSavedMon).toLocaleString()} MON`} of
              loop burn.
            </p>
            <p>
              That is why the thresholds above matter more than the refusal mode, and why a burn cap of
              zero is worth changing before an agent runs unattended.
            </p>
          </Caveat>
        </>
      ) : (
        <Panel className="p-5">
          <p className={`text-[13.5px] ${msg?.err ? 'text-moved' : 'text-dim'}`}>
            {msg?.text ?? 'Loading policy…'}
          </p>
        </Panel>
      )}

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Trip state is per wallet, so the live breaker status appears wherever a wallet is configured —
        the MCP server’s <code className="text-dim">readset_status</code> tool, or{' '}
        <code className="text-dim">mm readset status</code>.
      </footer>
    </Shell>
  );
}
