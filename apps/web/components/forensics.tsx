'use client';

/*
 * The forensics view, shared by /tx/[hash] and /why so there is one implementation.
 *
 * Pasting a hash navigates to /tx/<hash>, which makes every result a shareable URL — a judge
 * can be handed a link to the exact transaction rather than a page plus instructions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell, H2, Panel, Marker, Tag } from '@/components/chrome';
import { DependencyGraph, type ExecutedSlot, type MovedSlot } from '@/components/graph';
import { n, monFine } from '@/lib/format';

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Real failed mainnet transactions, one per verdict, taken from the committed replay results
 * (results/replay/latest.json) and confirmed to resolve end to end. They exist so a judge can
 * click rather than go hunting for a failed hash.
 */
const EXAMPLES: { hash: string; label: string; detail: string }[] = [
  {
    hash: '0x18ff273dcd9c21eed1a95360985f8dff51f0d8b2db27dbc55926a651120af199',
    label: 'Doomed 3 blocks early',
    detail: '2.58 MON — a gate would have caught it long before sending',
  },
  {
    hash: '0x3409dd8df027966ad47cb6322443b18036f416ca6033621dfcae690732abf63f',
    label: 'Doomed 1 block early',
    detail: '4.80 MON — 13 dependencies moved against it',
  },
  {
    hash: '0x90ba2f18e1125b7ba6f1d17670e29eeb9836650795df6d82fb1d796a2412d631',
    label: 'Same-block race',
    detail: '5.35 MON — nothing client-side could have caught this',
  },
];

/** What the server is doing, so a 10–30s trace is not a blank screen. */
const STEPS = [
  'fetching the transaction and its receipt',
  'tracing what it depended on',
  'replaying it at N-1, N-2 and N-3',
  'finding which transaction moved the slot',
] as const;

export interface Explanation {
  txHash: string;
  failedBlock: string;
  burnedWei: string;
  gasLimit: string;
  avoidableAt: string;
  avoidableClass?: string;
  rationale?: string;
  coverage?: string;
  undetectableWithoutPendingFeed?: boolean;
  notes?: string[];
  movedSlots: MovedSlot[];
  executedSlots?: ExecutedSlot[];
  from?: string;
  to?: string;
  nonce?: number;
  txIndex?: number;
  executedRevert?: { kind?: string; reason?: string };
  burn?: { gasUsed?: string; effectiveGasPrice?: string };
  burnEqualsLimitTimesPrice?: boolean;
}

const VERDICT: Record<string, { text: string; kind: 'pass' | 'partial' | 'fail' | 'mute' }> = {
  'N-1': { text: 'avoidable — already doomed one block earlier', kind: 'fail' },
  'N-2': { text: 'avoidable — already doomed two blocks earlier', kind: 'fail' },
  'N-3': { text: 'avoidable — already doomed three blocks earlier', kind: 'fail' },
  'same-block': { text: 'same-block race — no client-side guard could see this', kind: 'partial' },
  // A funds/reserve refusal is not a race. It is excluded from the avoidable numbers entirely,
  // and saying "unavoidable" here would quietly imply it was a race we could not catch.
  'excluded-funds': {
    text: 'insufficient funds / reserve balance (not a race, excluded from avoidable)',
    kind: 'mute',
  },
  unavoidable: { text: 'not knowable before sending', kind: 'mute' },
  unknown: { text: 'could not be classified', kind: 'mute' },
};

const EXPLORER = 'https://monadvision.com';

export function Forensics({ initialHash }: { initialHash?: string }) {
  const router = useRouter();
  const [input, setInput] = useState(initialHash ?? '');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  /** Set when the hash is a real transaction that did NOT fail: an answer, not an error. */
  const [succeeded, setSucceeded] = useState<string | null>(null);
  const [exp, setExp] = useState<Explanation | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopSteps = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const run = useCallback(async (h: string) => {
    setBusy(true);
    setExp(null);
    setSucceeded(null);
    setPicked(null);
    setStatus(null);
    setStep(0);
    // The server does not stream progress, so the steps advance on a timer that roughly
    // matches their real cost. Labelled as "what it is doing", never as measured timings.
    stopSteps();
    timer.current = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 2600);

    try {
      const r = await fetch(`/api/tx/${h}`);
      const body = await r.json();
      if (!body.ok) {
        if (body.succeeded) {
          setSucceeded(body.error ?? 'This transaction succeeded.');
        } else {
          setStatus({ msg: `${body.error}${body.hint ? ` — ${body.hint}` : ''}`, err: true });
        }
        return;
      }
      setStatus({ msg: `traced via ${body.rpc}` });
      setExp(body.explanation as Explanation);
    } catch (e) {
      setStatus({ msg: String(e), err: true });
    } finally {
      stopSteps();
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialHash && TX_HASH.test(initialHash)) void run(initialHash);
    return stopSteps;
  }, [initialHash, run]);

  function submit(h: string) {
    const v = h.trim();
    if (!TX_HASH.test(v)) {
      setStatus({ msg: 'That is not a 32-byte transaction hash.', err: true });
      return;
    }
    // Navigate so the result has its own URL.
    router.push(`/tx/${v.toLowerCase()}`);
  }

  const moved = exp?.movedSlots ?? [];
  const verdict = exp
    ? (VERDICT[exp.avoidableAt] ?? { text: exp.avoidableAt, kind: 'mute' as const })
    : null;

  const notes: string[] = [];
  if (exp?.rationale) notes.push(exp.rationale);
  if (exp?.undetectableWithoutPendingFeed) {
    notes.push(
      'This was only decidable from inside its own block. Monad exposes no pending-transaction feed, so no client-side guard could have caught it — we do not count this one as savings.',
    );
  }
  if (exp?.coverage && exp.coverage !== 'full') {
    notes.push(`Dependency coverage is "${exp.coverage}": read-only slots may be missing from this trace.`);
  }
  for (const x of exp?.notes ?? []) notes.push(x);

  function downloadReceipt() {
    if (!exp) return;
    const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `readset-${exp.txHash.slice(0, 12)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Forensics</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">Why your bot lost</h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          Paste a failed Monad mainnet transaction. Readset re-simulates it against the state of the
          blocks before it, finds the dependency whose value moved, and names the transaction that
          moved it. Where the evidence does not establish a cause, it says so.
        </p>
      </section>

      <Panel className="p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <label htmlFor="hash" className="marker mb-3 block">
            Transaction hash
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="hash"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              placeholder="0x…"
              className="min-w-0 flex-1 rounded-xl border border-line bg-sunken px-4 py-3.5 font-mono text-[15px] outline-none focus:border-green"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-green px-7 py-3.5 text-[15.5px] font-semibold text-white disabled:cursor-progress disabled:opacity-50"
            >
              {busy ? 'Tracing…' : 'Explain'}
            </button>
          </div>

          {busy ? (
            <ol className="mt-5 space-y-1.5">
              {STEPS.map((label, i) => (
                <li
                  key={label}
                  className={`flex items-center gap-2.5 text-[14px] ${
                    i < step ? 'text-green-ink' : i === step ? 'text-ink' : 'text-faint'
                  }`}
                >
                  <span aria-hidden="true">{i < step ? '✓' : i === step ? '◇' : '·'}</span>
                  {label}
                  {i === step ? <span className="cue">…</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className={`mt-4 min-h-6 text-[14px] ${status?.err ? 'text-moved' : 'text-dim'}`}>
              {status?.msg ?? ''}
            </p>
          )}
        </form>

        {!exp && !busy ? (
          <div className="mt-6 border-t border-line pt-5">
            <div className="marker mb-3">Or start from a real failure</div>
            <div className="grid gap-2.5 md:grid-cols-3">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.hash}
                  type="button"
                  onClick={() => submit(ex.hash)}
                  className="rounded-xl border border-line bg-sunken p-4 text-left transition-colors hover:border-green"
                >
                  <div className="text-[15px] font-semibold">{ex.label}</div>
                  <div className="mt-1 text-[13.5px] text-dim">{ex.detail}</div>
                  <div className="mt-2 font-mono text-[12px] text-faint">{ex.hash.slice(0, 22)}…</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      {succeeded ? (
        <Panel className="mt-6 border-l-[3px] border-l-green p-6">
          <h2 className="display mb-2 text-[24px]">This transaction succeeded</h2>
          <p className="max-w-[80ch] text-[16px] leading-relaxed text-body">{succeeded}</p>
          <p className="mt-3 max-w-[80ch] text-[16px] leading-relaxed text-body">
            Readset explains failures: it reconstructs what a transaction depended on and which of
            those values moved. There is nothing to explain here, because nothing went wrong.
          </p>
        </Panel>
      ) : null}

      {exp ? (
        <>
          <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-2xl border border-line bg-line">
            {[
              ['burned', monFine(exp.burnedWei), 'text-moved'],
              ['gas limit', n(Number(exp.gasLimit)), ''],
              ['gas used', exp.burn?.gasUsed ? n(Number(exp.burn.gasUsed)) : '—', ''],
              ['failed in block', n(Number(exp.failedBlock)), ''],
              ['dependencies that moved', String(moved.length), ''],
            ].map(([k, v, cls]) => (
              <div key={k} className="bg-panel p-5">
                <div className="marker">{k}</div>
                <div className={`num mt-1.5 text-[17px] ${cls}`}>{v}</div>
              </div>
            ))}
            <div className="bg-panel p-5">
              <div className="marker">verdict</div>
              <div className="mt-2">{verdict ? <Tag kind={verdict.kind}>{verdict.text}</Tag> : null}</div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={downloadReceipt}
              className="rounded-xl border border-line bg-panel px-4 py-2.5 text-[14.5px] hover:border-green"
            >
              Download receipt (JSON)
            </button>
            <a
              href={`${EXPLORER}/tx/${exp.txHash}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border border-line bg-panel px-4 py-2.5 text-[14.5px] hover:border-green"
            >
              View on explorer ↗
            </a>
            {exp.burnEqualsLimitTimesPrice ? (
              <span className="text-[14px] text-dim">
                fee charged = gas limit × price, confirmed against the receipt
              </span>
            ) : null}
          </div>

          {exp.executedRevert?.reason ? (
            <p className="mt-4 text-[15.5px] text-body">
              <span className="text-faint">revert reason:</span>{' '}
              <span className="font-mono text-moved">{exp.executedRevert.reason}</span>
            </p>
          ) : null}

          {notes.length ? (
            <div className="mt-5 space-y-2.5">
              {notes.map((x, i) => (
                <p key={i} className="border-l-2 border-line pl-4 text-[15px] leading-relaxed text-body">
                  {x}
                </p>
              ))}
            </div>
          ) : null}

          <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-white">
            <DependencyGraph
              moved={moved}
              executed={exp.executedSlots ?? []}
              onPick={setPicked}
              picked={picked}
            />
          </div>

          <H2>{moved.length ? 'The dependencies that moved' : 'No moved dependency found'}</H2>
          {moved.length ? (
            <div className="space-y-3">
              {moved.map((m, i) => (
                <article
                  key={`${m.address}:${m.slot}`}
                  onClick={() => setPicked(i)}
                  className={`cursor-pointer rounded-2xl border border-line border-l-[3px] border-l-moved bg-panel p-5 transition-colors ${
                    picked === i ? 'ring-1 ring-green' : ''
                  }`}
                >
                  <h3 className="mb-3 font-mono text-[14.5px] break-all">{m.label ?? m.slot}</h3>
                  <dl className="grid gap-x-5 gap-y-2 text-[14px] sm:grid-cols-[120px_1fr]">
                    <dt className="text-faint">contract</dt>
                    <dd className="font-mono break-all">{m.address}</dd>
                    <dt className="text-faint">value</dt>
                    <dd className="font-mono break-all">
                      <span className="text-faint">{m.from}</span> <span className="text-dim">→</span>{' '}
                      <span className="text-moved">{m.to}</span>
                    </dd>
                    <dt className="text-faint">written by</dt>
                    <dd className="font-mono break-all">
                      <a
                        href={`${EXPLORER}/tx/${m.writerTx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-green-ink underline decoration-green/40 underline-offset-4"
                      >
                        {m.writerTx}
                      </a>
                    </dd>
                    <dt className="text-faint">that sender</dt>
                    <dd className="font-mono break-all">{m.writerSender}</dd>
                    <dt className="text-faint">in block</dt>
                    <dd className="num">
                      {n(Number(m.writerBlock))}
                      {Number(m.writerBlock) === Number(exp.failedBlock) ? (
                        <span className="text-amber"> — the same block, ahead of you</span>
                      ) : null}
                    </dd>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <Panel className="border-l-[3px] border-l-green p-6">
              <p className="text-[16px] leading-relaxed text-body">
                This transaction failed for a reason other than a storage value changing under it —
                bad calldata, a permanent require, or state written inside its own block. Readset says
                so rather than naming a slot it cannot justify.
              </p>
            </Panel>
          )}
        </>
      ) : null}

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Traces come from a full-archive Monad mainnet endpoint. A slot that changed and changed back
        is excluded: Monad compares committed values, so a net-unchanged slot cannot have invalidated
        the transaction.
      </footer>
    </Shell>
  );
}
