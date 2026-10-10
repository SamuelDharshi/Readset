import Link from 'next/link';
import { buildStats } from '@/lib/stats';
import { ScrollShell, Screen, StatGrid, Stat, Panel, Caveat } from '@/components/chrome';
import { HashInput } from '@/components/hash-input';
import { n, pct, mon } from '@/lib/format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PILLARS = [
  {
    i: '01',
    when: 'before the send',
    name: 'Guard',
    body: 'Simulate against the current head, capture every storage slot the call read, and check the sender can cover gas_limit × price. Monad charges the limit, not the gas used.',
    edge: 'border-t-green',
  },
  {
    i: '02',
    when: 'during operation',
    name: 'Breaker',
    body: 'A human notices a loop. An agent does not. After N consecutive reverts, or N MON burned in an hour, sending halts and stays halted until someone resets it.',
    edge: 'border-t-moved',
  },
  {
    i: '03',
    when: 'after the failure',
    name: 'Receipt',
    body: 'Every attempt leaves a tamper-evident record of what the agent believed. Diff it against what the chain did and the cause is exact, not "execution reverted".',
    edge: 'border-t-dep',
  },
];

const FLOW_HEAD = `AI AGENT
   │  "send this transaction"
   ▼
READSET
   ├─ 1  breaker    has this agent been burning money?  ──►  `;

const FLOW_MID = `
   ├─ 2  simulate   would this revert against current state?
   ├─ 3  read set   which storage slots did it depend on?
   ├─ 4  funds      can it cover gas_limit × price + value?
   └─ 5  receipt    write the decision down, allowed or not
   ▼
`;

const LINKS: [string, string, string][] = [
  [
    '/why',
    'Forensics',
    'Paste a real failed mainnet hash: the dependency graph in 3D, the slot that moved, and the transaction that moved it.',
  ],
  [
    '/benchmark',
    'Benchmark',
    'The 30-day census, the replay results, the four kill tests, and every claim deleted for lack of proof.',
  ],
  ['/receipts', 'Receipts', 'The audit trail: what each agent believed at the moment it decided.'],
  ['/policy', 'Policy', 'Breaker thresholds and current trip state.'],
  ['/demo', 'Demo', 'The stale-dependency scenario on testnet, end to end.'],
];

export default async function Overview() {
  const s = await buildStats();
  const c = s.census;
  const gp = s.gasPadding;

  return (
    <ScrollShell>
      {/* 1 — the claim */}
      <Screen label="Monad · agent wallets">
        <h1 className="display max-w-[16ch] text-[clamp(44px,6.6vw,104px)]">
          On Monad, a failed transaction pays its{' '}
          <em className="text-moved not-italic">full gas limit</em>.
        </h1>
        <p className="mt-9 max-w-[62ch] text-[clamp(18px,1.5vw,23px)] leading-relaxed text-body">
          Readset simulates before your agent signs, names the storage slot that moved against it,
          and trips a breaker before a broken loop drains the wallet.
        </p>
        <HashInput />
      </Screen>

      {/* 2 — the measurement */}
      <Screen label="Measured, not estimated">
        <h2 className="display max-w-[20ch] text-[clamp(32px,3.6vw,56px)]">
          {c ? (
            <>
              Over {c.days} days, {n(c.failedTxs)} transactions failed and burned{' '}
              <span className="text-moved">{mon(c.revertBurnMON)}</span>.
            </>
          ) : (
            <>No census on disk yet.</>
          )}
        </h2>
        <p className="mt-6 mb-10 max-w-[74ch] text-[17.5px] leading-relaxed text-body">
          {c ? (
            <>
              Every one of mainnet&rsquo;s {n(c.blocks)} blocks in the window, not a sample. On{' '}
              <strong className="text-ink">all {n(c.failedTxs)}</strong> the fee charged was the full
              gas limit — the premise is measured, not assumed.
            </>
          ) : (
            <>Run the measurement and this page fills itself in.</>
          )}
        </p>

        {c ? (
          <StatGrid>
            <Stat value={mon(c.revertBurnMON)} label={`burned on failure in ${c.days} days`} tone="warn" />
            <Stat value={mon(c.burnPerDayMON)} label="per day" />
            <Stat value={pct(c.failureRate)} label="of user transactions failed" />
            <Stat value={pct(c.top50SenderBurnShare)} label="of the burn is 50 senders" />
            {gp?.neverNeededShare ? (
              <Stat
                value={pct(gp.neverNeededShare)}
                label="of gas bought by failed txs was never needed"
                tone="warn"
              />
            ) : null}
            {c.loops?.stoppedByBreaker5MON ? (
              <Stat
                value={mon(c.loops.stoppedByBreaker5MON)}
                label="a breaker of 5 would have stopped"
                tone="good"
              />
            ) : null}
          </StatGrid>
        ) : null}
      </Screen>

      {/* 3 — the mechanism */}
      <Screen label="How it works">
        <h2 className="display max-w-[22ch] text-[clamp(32px,3.6vw,56px)]">
          Five checks, in order, before anything is signed.
        </h2>
        <Panel className="mt-9 p-7">
          <pre className="overflow-x-auto text-[clamp(12px,1vw,15px)] leading-[1.85] text-body">
            {FLOW_HEAD}
            <span className="text-moved">HALT, no RPC spent</span>
            {FLOW_MID}
            <span className="text-green-deep">SIGNED</span>
            {' with a gas limit chosen from simulated gas'}
          </pre>
        </Panel>
      </Screen>

      {/* 4 — the three pillars */}
      <Screen label="Three pillars">
        <h2 className="display max-w-[22ch] text-[clamp(32px,3.6vw,56px)]">
          Guard the send. Stop the loop. Explain the loss.
        </h2>
        <div className="mt-10 grid grid-cols-[repeat(auto-fit,minmax(290px,1fr))] gap-5">
          {PILLARS.map((p) => (
            <div key={p.i} className={`rounded-2xl border border-line border-t-2 bg-panel p-7 ${p.edge}`}>
              <div className="marker mb-3">
                {p.i} · {p.when}
              </div>
              <h3 className="display mb-3 text-[26px]">{p.name}</h3>
              <p className="text-[15.5px] leading-relaxed text-body">{p.body}</p>
            </div>
          ))}
        </div>
      </Screen>

      {/* 5 — the limits, stated before the flattering numbers */}
      <Screen label="What it is not">
        <h2 className="display max-w-[24ch] text-[clamp(32px,3.6vw,56px)]">
          Two of these were forced by the measurements, not chosen.
        </h2>
        <div className="mt-8">
          <Caveat title="It is not a blocker by default">
            <p>
              Refusing every transaction whose simulation reverts would wrongly refuse{' '}
              <strong className="text-ink">{s.falseBlocks ? pct(s.falseBlocks.naive) : '—'}</strong> of
              sends that actually succeed, because their precondition often lands in their own block.
              So the default records the warning and lets the send through; hard refusal is opt-in,
              per target. A guard that silently blocked one good send in twelve would be worse than
              no guard.
            </p>
          </Caveat>

          <Caveat title="It cannot see same-block races">
            <p>
              <strong className="text-ink">
                {s.replay?.sameBlockBurnShare ? pct(s.replay.sameBlockBurnShare) : '—'}
              </strong>{' '}
              of the burn in our replay sample came from transactions broken by an earlier
              transaction in their own block. Monad exposes no pending-transaction feed, so no
              client-side guard catches those. We report that share instead of counting it as savings.
            </p>
          </Caveat>

          <Caveat title="What needs no prediction at all" tone="good">
            <p>
              The breaker and the receipts do not depend on guessing whether a transaction will fail.{' '}
              <strong className="text-ink">
                {c?.loops?.stoppedByBreaker5MON ? mon(c.loops.stoppedByBreaker5MON) : '—'}
              </strong>{' '}
              of loop burn over 30 days would have been stopped by a breaker set to 5 — that comes
              from counting, not forecasting.
            </p>
          </Caveat>
        </div>
      </Screen>

      {/* 6 — where to go */}
      <Screen label="Where to look" cue={false}>
        <h2 className="display max-w-[20ch] text-[clamp(32px,3.6vw,56px)]">See it on real data.</h2>
        <Panel className="mt-9">
          <table className="w-full border-collapse text-[15.5px]">
            <tbody>
              {LINKS.map(([href, label, body]) => (
                <tr key={href} className="border-b border-line last:border-0">
                  <td className="w-[150px] px-5 py-4 align-top">
                    <Link
                      href={href}
                      className="text-green-ink underline decoration-green/40 underline-offset-4 hover:decoration-green-ink"
                    >
                      {label}
                    </Link>
                  </td>
                  <td className="px-5 py-4 align-top text-body">{body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <footer className="mt-10 text-[14.5px] text-faint">
          Every figure here is read from live Monad mainnet or from committed measurement output in{' '}
          <code>results/</code>. None of it is estimated and nothing is mocked.
        </footer>
      </Screen>
    </ScrollShell>
  );
}
