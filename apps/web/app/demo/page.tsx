import { Shell, H2, Panel, Marker, Tag, Caveat } from '@/components/chrome';

export const dynamic = 'force-static';

const SCENE: [string, string, string][] = [
  [
    '01',
    'The agent reads the market',
    'It loads a position’s health factor from storage and decides to act. Readset records exactly which slot that was.',
  ],
  [
    '02',
    'A competitor moves first',
    'Another transaction writes that same slot. The agent’s plan is now based on a value that no longer exists.',
  ],
  [
    '03',
    'The agent sends anyway',
    'It has no reason to re-check. This is the ordinary case: nothing warned it, and on Monad the failure will cost the full gas limit.',
  ],
  [
    '04',
    'Readset refuses',
    'The simulation reverts, the dependency set shows which slot moved, and the receipt is written before anything is signed.',
  ],
  [
    '05',
    'The loop trips the breaker',
    'A broken agent retries. After five consecutive failures sending halts and stays halted until an operator resets it.',
  ],
];

export default function Demo() {
  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Demo</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">
          The stale-dependency scenario
        </h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          The forensics page explains failures that already happened on mainnet. This page is the
          other direction: a deliberately staged failure on testnet, so the refusal can be watched
          happening rather than reconstructed afterwards.
        </p>
      </section>

      <Caveat title="Not yet recorded on chain" tone="warn">
        <p>
          This scenario is scripted and the guard it exercises is the same code the mainnet forensics
          run on, but the testnet run has <strong className="text-ink">not</strong> been performed: the
          project wallet holds 0 MON, so nothing can be deployed or signed. Until it has, this page
          describes the scenario rather than showing its result, and no numbers from it appear
          anywhere else on this site.
        </p>
        <p>
          What already works without funds, and is tested: the gate refuses a real reverting
          testnet call, and refuses when a wallet cannot cover{' '}
          <code className="text-dim">gas_limit × price</code>. Both paths are covered in the suite.
        </p>
      </Caveat>

      <H2>The five beats</H2>
      <div className="space-y-2.5">
        {SCENE.map(([i, title, body]) => (
          <div key={i} className="flex gap-4 rounded-xl border border-line bg-panel p-5">
            <div className="marker pt-1">{i}</div>
            <div>
              <h3 className="display mb-2 text-[21px]">{title}</h3>
              <p className="max-w-[78ch] text-[16px] leading-relaxed text-body">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <H2 note="Honest labelling matters here: a demo contract is ours, and must never be presented as real market activity.">
        What gets deployed
      </H2>
      <Panel>
        <table className="w-full border-collapse text-[15.5px]">
          <tbody>
            <tr className="border-b border-line">
              <td className="w-[180px] px-4 py-3 align-top">Contract</td>
              <td className="px-4 py-3 align-top text-dim">
                A minimal market, clearly marked <strong className="text-ink">READSET DEMO CONTRACT</strong>,
                with a health factor any caller can move. It exists to make one storage slot visibly
                change hands; it is not a lending protocol and holds nothing of value.
              </td>
            </tr>
            <tr className="border-b border-line">
              <td className="px-4 py-3 align-top">Network</td>
              <td className="px-4 py-3 align-top text-dim">Monad testnet, chain id 10143.</td>
            </tr>
            <tr>
              <td className="px-4 py-3 align-top">Needed to run</td>
              <td className="px-4 py-3 align-top text-dim">
                About 5 MON from <code className="text-dim">faucet.monad.xyz</code> for the deploy and
                the staged transactions.
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      <H2>Status</H2>
      <Panel>
        <table className="w-full border-collapse text-[15.5px]">
          <tbody>
            {[
              ['Gate refuses a real reverting call', 'pass', 'tested on testnet, no funds required'],
              ['Gate refuses on insufficient funds', 'pass', 'tested against the unfunded project wallet'],
              ['Breaker trips at five and needs a reset', 'pass', 'tested from a real receipt log'],
              ['Demo contract deployed', 'fail', 'blocked: wallet holds 0 MON'],
              ['Staged race recorded on chain', 'fail', 'blocked: needs the deployed contract'],
            ].map(([what, kind, note]) => (
              <tr key={what} className="border-b border-line last:border-0">
                <td className="px-4 py-3 align-top">{what}</td>
                <td className="px-4 py-3 align-top">
                  <Tag kind={kind as 'pass' | 'fail'}>{kind === 'pass' ? 'working' : 'blocked'}</Tag>
                </td>
                <td className="px-4 py-3 align-top text-dim">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Nothing on this page is presented as a measured result. When the testnet run happens, its
        numbers will appear here with the transaction hashes that produced them.
      </footer>
    </Shell>
  );
}
