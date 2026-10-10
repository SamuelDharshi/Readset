'use client';

/*
 * Two live demonstrations, no wallet required.
 *
 * The gate half runs the real `gate()` against real Monad state and never signs anything.
 * The breaker half is a what-if over the real policy evaluator: it feeds counters in and shows
 * where the halt lands. Neither writes to an operator's durable breaker state.
 */

import { useEffect, useState } from 'react';
import { Shell, H2, Panel, Marker, Tag, Caveat } from '@/components/chrome';
import { n, monFine } from '@/lib/format';

const PROJECT_WALLET = '0x28F0ae7b3dB471479196718794E0b3A4b9AB90BA';
/** Monad testnet WMON. Deposit is payable, so a zero-value call to it is a clean read-ish probe. */
const WMON = '0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541';

interface Preset {
  name: string;
  detail: string;
  from: string;
  to: string;
  data: string;
  value: string;
}

const PRESETS: Preset[] = [
  {
    name: 'Unfunded sender',
    detail: 'A wallet with 0 MON cannot cover gas_limit × price. Refused before anything is signed.',
    from: PROJECT_WALLET,
    to: PROJECT_WALLET,
    data: '0x',
    value: '0',
  },
  {
    name: 'Doomed transferFrom',
    detail: 'transferFrom with no allowance on real testnet WMON. The simulation reverts.',
    from: PROJECT_WALLET,
    to: WMON,
    // transferFrom(from=WMON, to=PROJECT_WALLET, 1)
    data:
      '0x23b872dd' +
      '000000000000000000000000fb8bf4c1cc7a94c73d209a149ea2abea852bc541' +
      '00000000000000000000000028f0ae7b3db471479196718794e0b3a4b9ab90ba' +
      '0000000000000000000000000000000000000000000000000000000000000001',
    value: '0',
  },
  {
    name: 'Plain balance read',
    detail: 'balanceOf on WMON: a call that simulates cleanly, so the gate has no reason to object.',
    from: PROJECT_WALLET,
    to: WMON,
    data: '0x70a08231' + '00000000000000000000000028f0ae7b3db471479196718794e0b3a4b9ab90ba',
    value: '0',
  },
];

interface GateResult {
  ok: boolean;
  error?: string;
  verdict?: string;
  allowed?: boolean;
  reason?: string | null;
  gasLimitChosen?: string | null;
  dependencySlots?: number;
  dependencyCoverage?: string | null;
  timeDependent?: boolean | null;
  block?: { number?: string } | null;
  chainId?: number;
  simulation?: { success?: boolean; gasUsed?: string } | null;
  policy?: { refuseOnRevert?: string };
}

interface LoopStep {
  n: number;
  verdict: string;
  reason: string | null;
}

export default function Playground() {
  // --- gate
  const [form, setForm] = useState<Preset>(PRESETS[0]!);
  const [mode, setMode] = useState<'warn' | 'stable' | 'any'>('any');
  const [gating, setGating] = useState(false);
  const [result, setResult] = useState<GateResult | null>(null);

  // --- breaker
  const [limit, setLimit] = useState(5);
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [running, setRunning] = useState(false);
  const [halted, setHalted] = useState<string | null>(null);
  /** Mean cost of a real failed transaction, taken from the 30-day census. Never a guess. */
  const [meanFailMon, setMeanFailMon] = useState<number | null>(null);
  const fails = steps.length;
  const tripped = halted !== null;

  useEffect(() => {
    fetch('/api/stats')
      .then((r) => r.json())
      .then((s) => {
        const c = s?.census;
        if (c?.revertBurnMON && c?.failedTxs) setMeanFailMon(c.revertBurnMON / c.failedTxs);
      })
      .catch(() => setMeanFailMon(null));
  }, []);

  async function runGate() {
    setGating(true);
    setResult(null);
    try {
      const r = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, network: 'testnet', policy: { refuseOnRevert: mode } }),
      });
      setResult((await r.json()) as GateResult);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setGating(false);
    }
  }

  /**
   * A broken agent retries. Every iteration here is a REAL gate call against live Monad state
   * using the doomed preset, so each refusal is an actual RPC result rather than a number we
   * invented, and the breaker evaluates that real count. Nothing is signed, so no MON is spent.
   */
  async function runLoop() {
    setRunning(true);
    setSteps([]);
    setHalted(null);
    const doomed = PRESETS[1]!;
    const seen: LoopStep[] = [];

    for (let i = 1; i <= limit + 2; i++) {
      const g = (await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...doomed, network: 'testnet', policy: { refuseOnRevert: 'any' } }),
      }).then((r) => r.json())) as GateResult;

      // Only a real refusal counts towards the breaker.
      if (g.ok && g.allowed) break;
      seen.push({ n: i, verdict: g.verdict ?? 'error', reason: g.reason ?? g.error ?? null });
      setSteps([...seen]);

      const b = (await fetch('/api/breaker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          consecutiveReverts: seen.length,
          policy: { maxConsecutiveReverts: limit },
        }),
      }).then((r) => r.json())) as { halt?: boolean; reason?: string };

      if (b.halt) {
        setHalted(b.reason ?? 'breaker tripped');
        break;
      }
    }
    setRunning(false);
  }

  // What an unattended bot would keep spending, priced from the MEASURED mean failure cost.
  const wouldHaveBurned = meanFailMon === null ? null : meanFailMon * Math.max(0, 20 - fails);

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Playground</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">Try it without a wallet</h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          The gate below runs the same code the viem wrapper, the MCP server and the MetaMask plugin
          run, against live Monad testnet state. It simulates and decides; it never signs and never
          sends.
        </p>
      </section>

      <H2 note="Pick a preset or type your own call. The verdict, the reason and the chosen gas limit are whatever the real gate returns.">
        The gate
      </H2>

      <div className="grid gap-3 md:grid-cols-3">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => {
              setForm(p);
              setResult(null);
            }}
            className={`rounded-2xl border bg-panel p-5 text-left transition-colors ${
              form.name === p.name ? 'border-green' : 'border-line hover:border-dim'
            }`}
          >
            <div className="text-[15.5px] font-semibold">{p.name}</div>
            <div className="mt-1.5 text-[13.5px] leading-relaxed text-dim">{p.detail}</div>
          </button>
        ))}
      </div>

      <Panel className="mt-4 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {(['from', 'to'] as const).map((k) => (
            <div key={k}>
              <label htmlFor={k} className="marker mb-2 block">
                {k}
              </label>
              <input
                id={k}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                spellCheck={false}
                className="w-full rounded-xl border border-line bg-sunken px-3.5 py-3 font-mono text-[14px] outline-none focus:border-green"
              />
            </div>
          ))}
        </div>
        <div className="mt-4">
          <label htmlFor="data" className="marker mb-2 block">
            calldata
          </label>
          <textarea
            id="data"
            value={form.data}
            onChange={(e) => setForm({ ...form, data: e.target.value })}
            spellCheck={false}
            rows={3}
            className="w-full resize-y rounded-xl border border-line bg-sunken px-3.5 py-3 font-mono text-[13px] break-all outline-none focus:border-green"
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="value" className="marker mb-2 block">
              value (wei)
            </label>
            <input
              id="value"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              spellCheck={false}
              className="w-full rounded-xl border border-line bg-sunken px-3.5 py-3 font-mono text-[14px] outline-none focus:border-green"
            />
          </div>
          <div>
            <span className="marker mb-2 block">on a reverting simulation</span>
            <div className="flex gap-1.5">
              {(['warn', 'stable', 'any'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg border px-3 py-2 text-[13.5px] ${
                    mode === m ? 'border-green text-green-ink' : 'border-line text-dim hover:text-ink'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={() => void runGate()}
          disabled={gating}
          className="mt-5 rounded-xl bg-green px-7 py-3.5 text-[15.5px] font-semibold text-white disabled:cursor-progress disabled:opacity-50"
        >
          {gating ? 'Simulating…' : 'Run the gate'}
        </button>

        {result ? (
          <div className="mt-6 border-t border-line pt-5">
            {result.ok ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Tag kind={result.allowed ? 'pass' : 'fail'}>
                    {result.allowed ? 'ALLOW' : 'REFUSE'}
                  </Tag>
                  <span className="font-mono text-[14px] text-dim">{result.verdict}</span>
                  {result.policy?.refuseOnRevert ? (
                    <span className="text-[13.5px] text-faint">
                      policy: refuseOnRevert = {result.policy.refuseOnRevert}
                    </span>
                  ) : null}
                </div>
                {result.reason ? (
                  <p className="mt-3 max-w-[88ch] text-[15px] leading-relaxed text-body">
                    {result.reason}
                  </p>
                ) : null}
                <dl className="mt-4 grid gap-x-5 gap-y-2 text-[14px] sm:grid-cols-[180px_1fr]">
                  <dt className="text-faint">gas limit chosen</dt>
                  <dd className="num">
                    {result.gasLimitChosen ? n(Number(result.gasLimitChosen)) : '—'}
                  </dd>
                  <dt className="text-faint">simulated gas</dt>
                  <dd className="num">
                    {result.simulation?.gasUsed ? n(Number(result.simulation.gasUsed)) : '—'}
                  </dd>
                  <dt className="text-faint">dependencies captured</dt>
                  <dd className="num">
                    {result.dependencySlots ?? 0}
                    {result.dependencyCoverage ? (
                      <span className="text-faint"> · {result.dependencyCoverage}</span>
                    ) : null}
                  </dd>
                  <dt className="text-faint">may be time-dependent</dt>
                  <dd>{result.timeDependent === null ? '—' : result.timeDependent ? 'yes (bytecode heuristic)' : 'no'}</dd>
                  <dt className="text-faint">pinned block</dt>
                  <dd className="num">{result.block?.number ? n(Number(result.block.number)) : '—'}</dd>
                </dl>
              </>
            ) : (
              <p className="text-[15px] text-moved">{result.error}</p>
            )}
          </div>
        ) : null}
      </Panel>

      <H2 note="A human notices a loop. An agent does not. Set the threshold and watch where the halt lands.">
        The breaker
      </H2>

      <Panel className="p-6">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <label htmlFor="limit" className="marker mb-2 block">
              max consecutive reverts
            </label>
            <input
              id="limit"
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="w-28 rounded-xl border border-line bg-sunken px-3.5 py-3 font-mono text-[15px] outline-none focus:border-green"
            />
          </div>
          <button
            onClick={() => void runLoop()}
            disabled={running}
            className="rounded-xl bg-green px-7 py-3.5 text-[15.5px] font-semibold text-white disabled:cursor-progress disabled:opacity-50"
          >
            {running ? `Gating attempt ${fails + 1}...` : 'Run a looping bot'}
          </button>
          {fails > 0 ? (
            <button
              onClick={() => {
                setSteps([]);
                setHalted(null);
              }}
              className="rounded-xl border border-line px-5 py-3.5 text-[15px] hover:border-green"
            >
              Reset breaker
            </button>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-1.5">
          {Array.from({ length: Math.max(limit + 3, fails) }, (_, i) => {
            const fired = i < fails;
            const isHalt = i + 1 === limit && tripped;
            return (
              <span
                key={i}
                className={`grid size-9 place-items-center rounded-lg border text-[13px] ${
                  isHalt
                    ? 'border-moved bg-moved text-white'
                    : fired
                      ? 'border-moved/30 bg-moved-soft text-moved'
                      : 'border-line text-faint'
                }`}
              >
                {fired ? '✕' : i + 1}
              </span>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Tag kind={tripped ? 'fail' : fails ? 'partial' : 'mute'}>
            {tripped ? 'BREAKER TRIPPED' : fails ? `${fails} consecutive failures` : 'armed'}
          </Tag>
          {tripped ? (
            <span className="text-[15px] text-body">
              Sending halts here and stays halted until an operator resets it.
              {wouldHaveBurned !== null ? (
                <>
                  {' '}
                  A bot left running to 20 attempts would have burned about{' '}
                  <strong className="text-ink">{wouldHaveBurned.toFixed(2)} MON</strong> more,
                  priced at the measured mean cost of a failed Monad transaction.
                </>
              ) : null}
            </span>
          ) : null}
        </div>

        {steps.length ? (
          <ol className="mt-5 space-y-1.5 border-t border-line pt-4">
            {steps.map((st) => (
              <li key={st.n} className="flex gap-3 text-[13.5px]">
                <span className="num w-6 text-faint">{st.n}</span>
                <span className="font-mono text-moved">{st.verdict}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{st.reason}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </Panel>

      <Caveat title="What this demo is, exactly" tone="good">
        <p>
          Both halves are real. Every attempt in the loop is an actual gate call against live Monad
          testnet state, refused for an actual reason, and the breaker evaluates that real count.
          The one thing that does not happen is broadcasting: nothing is signed, so no MON is spent
          proving that a broken bot can waste money.
        </p>
        <p>
          The &ldquo;would have burned&rdquo; figure is the measured mean cost of a failed Monad
          transaction over the 30-day census, not an assumed gas price. The full loop-burn numbers
          are on the benchmark page.
        </p>
      </Caveat>

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Nothing on this page signs a transaction. The gate is read-only by construction.
      </footer>
    </Shell>
  );
}
