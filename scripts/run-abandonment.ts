// Usage: npx tsx scripts/run-abandonment.ts [--network mainnet|testnet] [--hours N] [--file path] [--endpoint wss://...]
import { runLogger } from '../packages/bench/src/abandonment-logger.js';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const hours = get('hours');
const ep = get('endpoint');
await runLogger({
  network: get('network') ?? 'mainnet',
  hours: hours ? Number(hours) : undefined,
  file: get('file'),
  endpoints: ep ? [ep] : undefined,
});
