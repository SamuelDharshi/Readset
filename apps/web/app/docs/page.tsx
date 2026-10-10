import Link from 'next/link';
import { Shell, H2, Panel, Marker, Caveat } from '@/components/chrome';
import { docIndex, listAvailable } from '@/lib/docs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GROUPS = ['Using Readset', 'How it works', 'Evidence'] as const;

const INSTALL = `# the guarded viem client
import { createGuardedWalletClient } from '@readset/viem';

const readset = createGuardedWalletClient({ walletClient, publicClient, policy });
await readset.sendTransaction({ to, data, value });   // throws DoomedTxError on a refusal`;

const MCP = `{
  "mcpServers": {
    "readset": {
      "command": "node",
      "args": ["packages/mcp/bin/readset-mcp.mjs"],
      "env": { "READSET_NETWORK": "testnet" }
    }
  }
}`;

const PLUGIN = `# MetaMask Agent Wallet (plugins are beta: enable them first)
mm config set experimentalPlugins true
mm plugins link ./packages/plugin

mm readset gate --from 0x… --to 0x… --data 0x…      # dry run, no auth needed
mm readset safe-submit --to 0x… --data 0x…          # gate, then submit
mm readset status                                    # breaker + recent decisions`;

export default async function Docs() {
  const available = await listAvailable();
  const entries = docIndex();

  return (
    <Shell>
      <section className="pt-14 pb-7">
        <Marker>Docs</Marker>
        <h1 className="display text-[clamp(36px,4.4vw,60px)]">Install, use, and the limits</h1>
        <p className="mt-4 max-w-[76ch] text-[18px] leading-relaxed text-body">
          Readset is one engine behind three surfaces. The MetaMask plugin, the MCP server and the
          viem wrapper all call the same <code>gate()</code>, write the same receipts and obey the
          same policy, so a decision does not depend on which door it came through.
        </p>
      </section>

      <H2 note="Drop-in replacement for a viem WalletClient. The one behavioural difference is that it can refuse.">
        viem wrapper
      </H2>
      <Panel className="p-6">
        <pre className="overflow-x-auto text-[13.5px] leading-[1.8] text-body">{INSTALL}</pre>
      </Panel>

      <H2 note="Three tools: readset_send, readset_status, readset_policy. Register the server with any MCP client.">
        MCP server
      </H2>
      <Panel className="p-6">
        <pre className="overflow-x-auto text-[13.5px] leading-[1.8] text-body">{MCP}</pre>
      </Panel>

      <H2 note="Agent Wallet has no interception hook, so an agent calls safe-submit instead of a raw send. That is cooperative, not enforced.">
        MetaMask Agent Wallet
      </H2>
      <Panel className="p-6">
        <pre className="overflow-x-auto text-[13.5px] leading-[1.8] text-body">{PLUGIN}</pre>
      </Panel>

      <H2 note="Rendered from the repo's own markdown, so a doc on this site cannot drift from the one in the tree.">
        Reference
      </H2>
      {GROUPS.map((g) => {
        const items = entries.filter((e) => e.group === g && available.has(e.slug));
        if (!items.length) return null;
        return (
          <div key={g} className="mb-5">
            <div className="marker mb-3">{g}</div>
            <Panel>
              <table className="w-full border-collapse text-[15.5px]">
                <tbody>
                  {items.map((e) => (
                    <tr key={e.slug} className="border-b border-line last:border-0">
                      <td className="w-[300px] px-5 py-3.5">
                        <Link
                          href={`/docs/${e.slug}`}
                          className="text-green-ink underline decoration-green/40 underline-offset-4 hover:decoration-green-ink"
                        >
                          {e.title}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-[13.5px] text-faint">docs/{e.file}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        );
      })}

      <H2>Honest limits</H2>
      <Caveat title="What Readset does not do">
        <p>
          <strong className="text-ink">It cannot see same-block races.</strong> Monad exposes no
          pending-transaction feed, so a transaction broken by an earlier transaction in its own
          block is invisible to any client-side guard. That share is reported on the benchmark page,
          not counted as savings.
        </p>
        <p>
          <strong className="text-ink">It does not refuse by default.</strong> Refusing on every
          reverting simulation wrongly refuses about 8.5% of sends that would have succeeded, so
          <code>refuseOnRevert</code> defaults to <code>warn</code> and hard refusal is opt-in per
          target.
        </p>
        <p>
          <strong className="text-ink">Time dependence is a heuristic.</strong> Monad has no struct
          logs and rejects block overrides, so Readset flags TIMESTAMP/NUMBER in bytecode and cannot
          confirm by differential re-simulation without a local fork.
        </p>
        <p>
          <strong className="text-ink">
            <code>latest</code> is a Proposed block
          </strong>{' '}
          and can be abandoned. Measured: 0 of 1,724 over 10.7 minutes, 95% upper bound 0.22%. Run
          the 24-hour logger before quoting a rate.
        </p>
        <p>
          <strong className="text-ink">It does not detect malicious contracts</strong>, and it does
          not claim to beat Category Labs&rsquo; gas-limit research — their per-(to, selector) buffer
          is the better source, and the flat buffer here is a stand-in that credits them.
        </p>
        <p>
          <strong className="text-ink">A slot is never named without evidence.</strong> Every writer
          attribution is confirmed against that transaction&rsquo;s own trace, and one that fails
          confirmation is reported as unattributed rather than blamed.
        </p>
      </Caveat>

      <footer className="band mt-20 pt-7 text-[14.5px] text-faint">
        Credits: Monad documentation, Category Labs&rsquo; gas-limit research, viem, MetaMask Agent
        Wallet, and the evm-fork-cache / reth execution-cache idea behind the (unbuilt) fast path.
        None of these projects endorse Readset.
      </footer>
    </Shell>
  );
}
