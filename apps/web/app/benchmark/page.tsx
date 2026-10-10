import { buildStats } from '@/lib/stats';
import { Shell, H2, Panel, Marker, Tag, Caveat, Empty } from '@/components/chrome';
import { n, pct, mon } from '@/lib/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KILL_TESTS: [string, string, 'pass' | 'partial', string, string][] = [
  [
    'K1',
    'Can we extract a transaction’s dependencies — historical debug_traceCall, and do read-only slots appear?',
    'pass',
    'PASS',
    'Two free public endpoints are full archive with tracing. Read-only slots appear in non-diff mode only, so the dependency set is built from a non-diff trace. Block overrides are unsupported, which is why time-dependence stays a heuristic.',
  ],
  [
    'K2',
    'Is the avoidable loss real and large enough?',
    'partial',
    'PARTIAL',
    'Burn and loop burn confirmed far above target, and 36% of burn was already doomed three blocks earlier. The false-block rate failed its bar, which is why hard refusal is opt-in.',
  ],
  [
    'K3',
    'Can a MetaMask Agent Wallet plugin gate a send?',
    'partial',
    'PARTIAL',
    'No interception exists: the host rejects plugins that declare hooks. Readset ships mm readset safe-submit, which an agent calls instead of a raw send — cooperative, not enforced.',
  ],
  [
    'K4',
    'Are monadNewHeads / monadLogs reachable without a paid key?',
    'pass',
    'PASS',
    'Keyless on the public endpoints. 1,724 proposed blocks observed over 10.7 minutes, none abandoned (95% upper bound 0.22%).',
  ],
];

function deletedClaims(meanFailMon: number | null): [string, string][] {
  const mean = meanFailMon === null ? 'the measured mean' : `about ${meanFailMon.toFixed(2)} MON`;
  return [
  [
    '“An airdrop farmer burned $112k on failed transactions”',
    'The full address was never published and the cited source points at a Solana explorer. Unverifiable, so removed.',
  ],
  ['“About 6% of transactions fail”', 'Measured 3.73% of user transactions over a full 30-day census.'],
  [
    '“~0.03 MON lost per failed transaction”',
    `The measured mean is ${mean} — several times worse than the brief assumed.`,
  ],
  [
    '“44 TPS, 7% gas utilisation”',
    'Re-derived over a fresh 20,000-block window: 77.8 TPS, 11.9% utilisation, 302 ms blocks.',
  ],
  [
    '“Blockaid runs on Monad”, “Blocknative pre-flight”',
    'Neither could be confirmed, so both are out of the prior-art comparison.',
  ],
  [
    'Hotslot: “OpenZeppelin’s ReentrancyGuard serialises your contract”',
    'False. Monad compares committed values and the guard goes 1 → 2 → 1, netting to no change. This killed the predecessor project.',
  ],
  ];
}

function Row({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-3 align-top">{k}</td>
      <td className="num px-4 py-3 align-top whitespace-nowrap">{v}</td>
      <td className="px-4 py-3 align-top text-dim">{note ?? ''}</td>
    </tr>
  );
}

export default async function Benchmark() {
  const s = await buildStats();
  const c = s.census;
  const gp = s.gasPadding;
  const rp = s.replay;
  const fb = s.falseBlocks;

  // Lower bound: only candidates we could re-simulate that still reverted.
  // Upper bound: assume every unmeasurable candidate would also have reverted.
  const fbLo = fb?.stable ?? 0;
  const fbHi = fb && rp?.successfulN ? fb.stable + fb.unmeasured / rp.successfulN : fbLo;

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Benchmark</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">
          Every number, and how it was measured.
        </h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          The build was gated on four kill tests, with instructions to publish the negative result
          if the numbers did not hold. Two came back PARTIAL. Those are first.
        </p>
      </section>

      <H2>Kill tests</H2>
      <Panel>
        <table className="w-full border-collapse text-[15.5px]">
          <thead>
            <tr className="border-b border-line text-[13px] text-faint">
              <th className="px-4 py-3 text-left font-normal">Test</th>
              <th className="px-4 py-3 text-left font-normal">Question</th>
              <th className="px-4 py-3 text-left font-normal">Verdict</th>
              <th className="px-4 py-3 text-left font-normal">What it changed</th>
            </tr>
          </thead>
          <tbody>
            {KILL_TESTS.map(([id, q, kind, label, effect]) => (
              <tr key={id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 align-top">{id}</td>
                <td className="max-w-[26ch] px-4 py-3 align-top">{q}</td>
                <td className="px-4 py-3 align-top">
                  <Tag kind={kind}>{label}</Tag>
                </td>
                <td className="px-4 py-3 align-top text-dim">{effect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <H2
        note={
          c
            ? `Not a sample: every block from ${n(c.rangeBlocks[0])} to ${n(c.rangeBlocks[1])} — ${n(c.blocks)} blocks, ${c.days} days. Streamed from the ${c.source.toUpperCase()} mainnet mirror; the pure-RPC path is cross-validated field by field in the test suite, but 30 days over RPC is days of wall clock.`
            : undefined
        }
      >
        The 30-day census
      </H2>
      {c ? (
        <Panel>
          <table className="w-full border-collapse text-[15.5px]">
            <tbody>
              <Row
                k="Failed transactions"
                v={n(c.failedTxs)}
                note={`${pct(c.failureRate)} of ${n(c.userTxs)} user transactions`}
              />
              <Row k="Burned on failure" v={mon(c.revertBurnMON)} note={`${mon(c.burnPerDayMON)} per day`} />
              <Row
                k="Failed txs where gasUsed ≠ gasLimit"
                v={n(c.gasUsedNeGasLimitFailed)}
                note="The premise is measured, not assumed: every failure paid its whole limit."
              />
              <Row
                k="Distinct failing senders"
                v={n(c.distinctFailingSenders)}
                note={`top 50 carry ${pct(c.top50SenderBurnShare)}, top 10 carry ${pct(c.top10SenderBurnShare)}`}
              />
              {c.loops ? (
                <>
                  <Row
                    k="Burn inside loops (≥10 consecutive failures)"
                    v={mon(c.loops.burnMON ?? 0)}
                    note={`${n(c.loops.runs ?? 0)} runs, ${pct(c.loops.burnShare ?? 0)} of all burn`}
                  />
                  <Row
                    k="A breaker of 5 would have stopped"
                    v={mon(c.loops.stoppedByBreaker5MON ?? 0)}
                    note="Needs no prediction — only counting."
                  />
                </>
              ) : null}
              {gp?.neverNeededShare ? (
                <>
                  <Row
                    k="Gas bought by failed txs, never needed"
                    v={pct(gp.neverNeededShare)}
                    note={`${n(gp.tracedN ?? 0)} failures re-simulated individually`}
                  />
                  <Row
                    k="Failures with a limit ≥2× their real need"
                    v={pct(gp.paddedTxShare ?? 0)}
                    note={`they carry ${pct(gp.burnShareOfPadded ?? 0)} of all burn`}
                  />
                </>
              ) : null}
            </tbody>
          </table>
        </Panel>
      ) : (
        <Empty what="No census on disk yet." cmd="npx tsx scripts/k2-sample.ts --full" />
      )}

      <H2 note="Real failed mainnet transactions, re-simulated against the end state of the blocks before them. If it already reverted three blocks earlier, a gate would have caught it.">
        The replay benchmark
      </H2>
      {rp ? (
        <Panel>
          <table className="w-full border-collapse text-[15.5px]">
            <tbody>
              <Row
                k="Sample"
                v={`${n(rp.failedN)} failed + ${n(rp.successfulN)} successful`}
                note="Randomly sampled across the 30-day window from a fixed seed."
              />
              <Row
                k="Burn already doomed at N−1"
                v={pct(rp.knowableBurnN1)}
                note="A gate simulating at the head would have caught it."
              />
              <Row
                k="Burn already doomed at N−3"
                v={pct(rp.knowableBurnN3)}
                note="Still reverting three blocks earlier, so it was not a race."
              />
              <Row
                k="Same-block races"
                v={pct(rp.sameBlockBurnShare)}
                note="Undetectable without a pending feed. Not claimed as savings."
              />
              <Row
                k="False blocks (refuse on any revert)"
                v={pct(rp.falseBlockRate)}
                note="Good sends a naive gate would have wrongly refused."
              />
            </tbody>
          </table>
        </Panel>
      ) : (
        <Empty
          what="No replay results on disk yet."
          cmd="npx tsx scripts/replay-benchmark.ts --blocks 1700 --seed 20261007"
        />
      )}

      {fb ? (
        <Caveat title="The result that changed the product">
          <p>
            The bar was under 1% false blocks. Refusing on any reverting simulation would have refused{' '}
            <strong className="text-ink">{pct(fb.naive)}</strong> of transactions that actually
            succeeded. Requiring the revert to reproduce three blocks back halves that to{' '}
            <strong className="text-ink">{pct(fbLo)}</strong> — but {fb.unmeasured} of {fb.candidates}{' '}
            candidates could not be re-simulated (pruned state or a throttled endpoint), so the honest
            range is{' '}
            <strong className="text-ink">
              {pct(fbLo)}–{pct(fbHi)}
            </strong>
            . Those unmeasurable cases are not assumed away.
          </p>
          <p>
            Those are not measurement errors. Such a transaction’s precondition is written by an
            earlier transaction <em>in its own block</em> — a router funded, an auction opened, an
            allowance set. A client-side gate reading the committed head genuinely cannot see it.
          </p>
          <p>
            Knowable burn is almost identical at N−1 and N−3, so demanding that a revert reproduce
            costs nearly no detection. It still misses the 1% bar, so{' '}
            <code className="text-dim">refuseOnRevert</code> defaults to{' '}
            <code className="text-dim">warn</code>.
          </p>
        </Caveat>
      ) : null}

      <H2 note="These were in the brief. They did not survive checking, so they are not in the pitch.">
        Claims we deleted
      </H2>
      <Panel>
        <table className="w-full border-collapse text-[15.5px]">
          <tbody>
            {deletedClaims(
              c?.revertBurnMON && c?.failedTxs ? c.revertBurnMON / c.failedTxs : null,
            ).map(([claim, why]) => (
              <tr key={claim} className="border-b border-line last:border-0">
                <td className="max-w-[34ch] px-4 py-3 align-top">{claim}</td>
                <td className="px-4 py-3 align-top text-dim">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <H2 note="Each command writes the JSON this page reads. No key required.">Reproduce it</H2>
      <Panel className="p-5">
        <pre className="overflow-x-auto text-[12.5px] leading-[1.9] text-dim">
{`npx tsx scripts/k2-sample.ts --full          # 30-day census (43s cached, ~43min cold)
npx tsx scripts/replay-benchmark.ts --blocks 1700 --seed 20261007
npx tsx scripts/stable-revert-check.ts       # the false-block rule comparison
npx tsx scripts/run-abandonment.ts --network mainnet --hours 24
npx tsx scripts/k1-probe.ts                  # per-endpoint history + tracing support`}
        </pre>
      </Panel>

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        These are replay results over historical transactions. They are not a guarantee of future
        savings. Read from <code className="text-dim">results/</code> at{' '}
        {new Date(s.generatedAt).toUTCString()}.
      </footer>
    </Shell>
  );
}
