// Standalone proof of the Monad-testnet leg, independent of the mm CLI (which needs a MetaMask login).
// Run: npx tsx packages/plugin/spike/direct-send.ts   (reads HOTSLOT_PRIVATE_KEY from .env; never prints it)
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gate, writeReceipt } from './mm-plugin/src/gate.js';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const rpc = process.env.MONAD_TESTNET_RPC ?? 'https://testnet-rpc.monad.xyz';
const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(env.HOTSLOT_PRIVATE_KEY as `0x${string}`);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

const to = account.address; // self-transfer of 0.001 MON
const value = 10n ** 15n;
console.log('from', account.address, 'balance', formatEther(await pub.getBalance({ address: account.address })), 'MON');
const v = await gate(pub, { from: account.address, to, value, chainId: 10143 });
const receiptPath = new URL('./receipts.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
writeReceipt(receiptPath, { ts: new Date().toISOString(), from: account.address, to, verdict: v });
if (!v.ok) {
  console.log('REFUSED (nothing signed):', v.kind, v.reason);
  process.exit(0);
}
console.log('gate ok: simulatedGas', v.simulatedGas, '-> gas limit', v.gas);
const hash = await wallet.sendTransaction({ to, value, gas: v.gas }); // explicit gas limit, no estimateGas by viem
console.log('sent', hash);
const r = await pub.waitForTransactionReceipt({ hash });
console.log('status', r.status, 'gasUsed', r.gasUsed, '(Monad charges gas_limit x price:', v.gas, ')');
