'use client';

import { Fragment, useEffect, useState } from 'react';
import { Shell, H2, Panel, Marker, Tag } from '@/components/chrome';
import { n, monFine, short } from '@/lib/format';

interface Receipt {
  id: string;
  createdAt: string;
  chainId: number;
  verdict: string;
  tx: { from: string; to: string | null; data?: string; gasLimitChosen?: string };
  doomed?: { reason?: string; revertReason?: string };
  dependencySet?: { slots?: unknown[]; coverage?: string };
  txHash?: string;
  outcome?: { status: string; gasUsed: string; feePaidWei: string; blockNumber: string };
  policyHash: string;
}

interface Body {
  ok: boolean;
  error?: string;
  root?: string;
  count?: number;
  integrity?: { checked: number; bad: { id: string; reason: string }[] } | null;
  receipts?: Receipt[];
}

const VERDICT_TAG: Record<string, 'pass' | 'partial' | 'fail' | 'mute'> = {
  allowed: 'pass',
  refused_doomed: 'fail',
  refused_breaker: 'fail',
  refused_funds: 'partial',
  refused_policy: 'partial',
};

export default function Receipts() {
  const [body, setBody] = useState<Body | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/receipts?limit=100')
      .then((r) => r.json())
      .then(setBody)
      .catch((e) => setBody({ ok: false, error: String(e) }));
  }, []);

  const receipts = body?.receipts ?? [];
  const bad = body?.integrity?.bad ?? [];

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Audit trail</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">Dependency receipts</h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          Every send attempt writes one record of what the agent believed: the simulated outcome, the
          storage it depended on, the policy in force, and the verdict. Refusals are recorded too — a
          blocked send is part of the trail, not an absence of one.
        </p>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          The log is append-only. A mined outcome arrives as a separate amendment line rather than
          rewriting the original, so the receipt still hashes to the decision it committed to.
        </p>
      </section>

      {body && !body.ok ? (
        <Panel className="p-5">
          <p className="text-[13.5px] text-moved">{body.error}</p>
        </Panel>
      ) : null}

      {body?.ok ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-xl border border-line bg-line">
          <div className="bg-panel p-5">
            <div className="num font-sans text-[25px] tracking-tight">{n(body.count ?? 0)}</div>
            <div className="mt-1.5 text-[12.5px] text-dim">receipts on disk</div>
          </div>
          <div className="bg-panel p-5">
            <div
              className={`num font-sans text-[25px] tracking-tight ${bad.length ? 'text-moved' : 'text-ok'}`}
            >
              {bad.length ? `${bad.length} bad` : 'intact'}
            </div>
            <div className="mt-1.5 text-[12.5px] text-dim">
              {body.integrity ? `${n(body.integrity.checked)} records re-hashed` : 'integrity not checked'}
            </div>
          </div>
          <div className="bg-panel p-5">
            <div className="font-sans text-[13px] break-all text-dim">{body.root}</div>
            <div className="mt-1.5 text-[13px] text-faint">store location</div>
          </div>
        </div>
      ) : null}

      {bad.length ? (
        <Panel className="mt-4 border-l-[3px] border-l-moved p-5">
          <h3 className="display mb-2 text-[21px]">Tampered or malformed records</h3>
          <ul className="space-y-1 text-[12.5px] text-dim">
            {bad.map((b) => (
              <li key={b.id}>
                <span className="text-moved">{short(b.id, 12, 8)}</span> — {b.reason}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <H2>Recent decisions</H2>

      {body?.ok && receipts.length === 0 ? (
        <Panel className="p-5">
          <p className="text-[13.5px] text-dim">
            No receipts yet. They appear once something makes a decision — the viem wrapper, the MCP
            server, or the MetaMask plugin.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-sunken p-3 text-[12.5px]">
{`# write one by gating a real testnet call
npx tsx packages/plugin/spike/direct-send.ts`}
          </pre>
        </Panel>
      ) : null}

      {receipts.length ? (
        <Panel>
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b border-line text-[13px] text-faint">
                <th className="px-4 py-3 text-left font-normal">When</th>
                <th className="px-4 py-3 text-left font-normal">Verdict</th>
                <th className="px-4 py-3 text-left font-normal">Target</th>
                <th className="px-4 py-3 text-left font-normal">Deps</th>
                <th className="px-4 py-3 text-left font-normal">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => {
                const isOpen = open === r.id;
                return (
                  // The key belongs on the fragment: this row renders two <tr>s.
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : r.id)}
                      className="cursor-pointer border-b border-line hover:bg-white/[0.03]"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-dim">
                        {new Date(r.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2.5">
                        <Tag kind={VERDICT_TAG[r.verdict] ?? 'mute'}>{r.verdict}</Tag>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{short(r.tx.to, 8, 6)}</td>
                      <td className="num px-4 py-2.5">{r.dependencySet?.slots?.length ?? '—'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-dim">
                        {r.outcome
                          ? `${r.outcome.status} · ${monFine(r.outcome.feePaidWei)}`
                          : r.txHash
                            ? 'sent, pending'
                            : '—'}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-line bg-sunken">
                        <td colSpan={5} className="px-4 py-4">
                          <dl className="grid gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-[118px_1fr]">
                            <dt className="text-faint">receipt id</dt>
                            <dd className="break-all">{r.id}</dd>
                            <dt className="text-faint">from</dt>
                            <dd className="break-all">{r.tx.from}</dd>
                            <dt className="text-faint">to</dt>
                            <dd className="break-all">{r.tx.to ?? '(deploy)'}</dd>
                            {r.tx.gasLimitChosen ? (
                              <>
                                <dt className="text-faint">gas limit set</dt>
                                <dd className="num">{n(Number(r.tx.gasLimitChosen))}</dd>
                              </>
                            ) : null}
                            {r.doomed?.revertReason || r.doomed?.reason ? (
                              <>
                                <dt className="text-faint">reason</dt>
                                <dd className="text-moved">
                                  {r.doomed.revertReason ?? r.doomed.reason}
                                </dd>
                              </>
                            ) : null}
                            {r.dependencySet?.coverage ? (
                              <>
                                <dt className="text-faint">dep coverage</dt>
                                <dd>{r.dependencySet.coverage}</dd>
                              </>
                            ) : null}
                            {r.txHash ? (
                              <>
                                <dt className="text-faint">tx hash</dt>
                                <dd className="break-all">{r.txHash}</dd>
                              </>
                            ) : null}
                            <dt className="text-faint">policy hash</dt>
                            <dd className="break-all text-dim">{r.policyHash}</dd>
                          </dl>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Receipts are local to whoever ran the guard; nothing is uploaded. A receipt’s id commits to the
        decision, not the outcome, which is why a later result cannot change it.
      </footer>
    </Shell>
  );
}
