// K4 abandonment logger: subscribes to `monadNewHeads` (read-only) and records, for every block that was
// ever seen as Proposed, its commit-state timeline and whether it was ABANDONED (a different hash at the
// same height reached Finalized). Output: JSONL, append-only, so it is resumable across restarts.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';
const STATES: CommitState[] = ['Proposed', 'Voted', 'Finalized', 'Verified'];

export interface HeadEvent {
  recvMs: number;
  number: number;
  hash: string;
  parentHash: string;
  blockId: string;
  commitState: CommitState;
  /** block header timestamp, seconds */
  timestamp: number;
}

export type Outcome = 'finalized' | 'abandoned' | 'unresolved' | 'partial';

export interface BlockRecord {
  t: 'block';
  session: string;
  number: number;
  hash: string;
  parentHash: string;
  blockId: string;
  headerTs: number;
  proposedAt?: number;
  votedAt?: number;
  finalizedAt?: number;
  verifiedAt?: number;
  /** finalized: reached Finalized. abandoned: another hash at this height finalized, this one never did.
   *  unresolved: neither (connection ended / evicted before the height finalized).
   *  partial: first seen after the Proposed state (e.g. right after connect), excluded from the rate. */
  outcome: Outcome;
  /** hash that finalized at this height instead (abandoned only) */
  finalizedHash?: string;
}

/** Parse one raw websocket frame from `eth_subscribe monadNewHeads`. Returns null for non-head frames. */
export function parseHead(raw: string, recvMs: number): HeadEvent | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = m?.method === 'eth_subscription' ? m.params?.result : null;
  if (!r || typeof r.hash !== 'string' || !STATES.includes(r.commitState)) return null;
  return {
    recvMs,
    number: Number(BigInt(r.number)),
    hash: r.hash,
    parentHash: r.parentHash,
    blockId: r.blockId,
    commitState: r.commitState,
    timestamp: Number(BigInt(r.timestamp)),
  };
}

interface B {
  number: number;
  hash: string;
  parentHash: string;
  blockId: string;
  headerTs: number;
  at: Partial<Record<CommitState, number>>;
}

/** Pure state machine. Feed events in arrival order; it calls `emit` with one BlockRecord per block when its
 *  height is EVICT_DEPTH behind the newest finalized height, or on flush(). */
export class Tracker {
  static EVICT_DEPTH = 24;
  private blocks = new Map<string, B>();
  private byHeight = new Map<number, Set<string>>();
  private finalizedAt = new Map<number, string>();
  private maxFinalized = 0;
  counts = { events: 0, emitted: 0, finalized: 0, abandoned: 0, unresolved: 0, partial: 0 };

  constructor(
    private session: string,
    private emit: (r: BlockRecord) => void,
  ) {}

  ingest(ev: HeadEvent): void {
    this.counts.events++;
    let b = this.blocks.get(ev.hash);
    if (!b) {
      b = { number: ev.number, hash: ev.hash, parentHash: ev.parentHash, blockId: ev.blockId, headerTs: ev.timestamp, at: {} };
      this.blocks.set(ev.hash, b);
      let s = this.byHeight.get(ev.number);
      if (!s) this.byHeight.set(ev.number, (s = new Set()));
      s.add(ev.hash);
    }
    if (b.at[ev.commitState] === undefined) b.at[ev.commitState] = ev.recvMs;
    if (ev.commitState === 'Finalized') {
      this.finalizedAt.set(ev.number, ev.hash);
      if (ev.number > this.maxFinalized) this.maxFinalized = ev.number;
      this.evict(this.maxFinalized - Tracker.EVICT_DEPTH);
    }
  }

  /** True once a sibling at the same height finalized and this (previously Proposed) hash did not. */
  isAbandoned(hash: string): boolean {
    const b = this.blocks.get(hash);
    if (!b || b.at.Proposed === undefined || b.at.Finalized !== undefined) return false;
    const f = this.finalizedAt.get(b.number);
    return f !== undefined && f !== hash;
  }

  private evict(upTo: number): void {
    for (const [h, set] of [...this.byHeight]) {
      if (h > upTo) continue;
      for (const hash of set) this.out(this.blocks.get(hash)!);
      for (const hash of set) this.blocks.delete(hash);
      this.byHeight.delete(h);
      this.finalizedAt.delete(h);
    }
  }

  private out(b: B): void {
    const fin = this.finalizedAt.get(b.number);
    let outcome: Outcome;
    if (b.at.Proposed === undefined) outcome = 'partial';
    else if (b.at.Finalized !== undefined) outcome = 'finalized';
    else if (fin !== undefined && fin !== b.hash) outcome = 'abandoned';
    else outcome = 'unresolved';
    this.counts.emitted++;
    this.counts[outcome]++;
    const rec: BlockRecord = {
      t: 'block',
      session: this.session,
      number: b.number,
      hash: b.hash,
      parentHash: b.parentHash,
      blockId: b.blockId,
      headerTs: b.headerTs,
      proposedAt: b.at.Proposed,
      votedAt: b.at.Voted,
      finalizedAt: b.at.Finalized,
      verifiedAt: b.at.Verified,
      outcome,
    };
    if (outcome === 'abandoned') rec.finalizedHash = fin;
    this.emit(rec);
  }

  /** Emit everything still held (connection closed / shutdown). Unfinalized heights become 'unresolved'. */
  flush(): void {
    this.evict(Infinity);
  }
}

// ---------------------------------------------------------------- runner

export const ENDPOINTS: Record<string, string[]> = {
  mainnet: ['wss://rpc.monad.xyz', 'wss://rpc-mainnet.monadinfra.com', 'wss://rpc1.monad.xyz'],
  testnet: ['wss://testnet-rpc.monad.xyz'],
};

export interface LoggerOptions {
  network: string;
  hours?: number;
  file?: string;
  endpoints?: string[];
  log?: (s: string) => void;
}

export async function runLogger(opts: LoggerOptions): Promise<{ file: string; counts: Tracker['counts']; reconnects: number }> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const file = resolve(opts.file ?? `.readset/abandonment/${opts.network}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const endpoints = opts.endpoints ?? ENDPOINTS[opts.network];
  if (!endpoints?.length) throw new Error(`no endpoints for network ${opts.network}`);
  const write = (o: unknown) => appendFileSync(file, JSON.stringify(o) + '\n');
  const deadline = opts.hours ? Date.now() + opts.hours * 3600_000 : Infinity;
  const totals = { events: 0, emitted: 0, finalized: 0, abandoned: 0, unresolved: 0, partial: 0 };
  let reconnects = 0;
  let stop = false;
  let current: WebSocket | null = null;
  const onSig = () => {
    stop = true;
    try {
      current?.close();
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  let attempt = 0;
  while (!stop && Date.now() < deadline) {
    const url = endpoints[attempt++ % endpoints.length];
    const session = `${Date.now().toString(36)}-${attempt}`;
    const tracker = new Tracker(session, write);
    let lastMsg = Date.now();
    let nMsgs = 0;
    log(`[${new Date().toISOString()}] connecting ${url} session=${session}`);
    await new Promise<void>((done) => {
      let finished = false;
      const ws = new WebSocket(url);
      current = ws;
      const end = (why: string) => {
        if (finished) return;
        finished = true;
        clearInterval(hb);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        tracker.flush();
        write({ t: 'session_end', session, at: Date.now(), why, messages: nMsgs, counts: tracker.counts });
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += tracker.counts[k];
        log(`[${new Date().toISOString()}] session ended (${why}) msgs=${nMsgs}`);
        done();
      };
      const hb = setInterval(() => {
        const idle = Date.now() - lastMsg;
        if (idle > 10_000) return end(`no messages for ${idle}ms`);
        if (Date.now() >= deadline) return end('deadline');
        const c = tracker.counts;
        write({ t: 'heartbeat', session, at: Date.now(), msgs: nMsgs, finalized: c.finalized, abandoned: c.abandoned });
        log(`[${new Date().toISOString()}] hb msgs=${nMsgs} finalized=${c.finalized} abandoned=${c.abandoned} (this session)`);
      }, 30_000);
      ws.addEventListener('open', () => {
        write({ t: 'session_start', session, at: Date.now(), network: opts.network, url });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['monadNewHeads'] }));
      });
      ws.addEventListener('message', (e) => {
        lastMsg = Date.now();
        const ev = parseHead(String(e.data), lastMsg);
        if (!ev) return;
        nMsgs++;
        tracker.ingest(ev);
      });
      ws.addEventListener('error', () => end('error'));
      ws.addEventListener('close', () => end(stop ? 'signal' : 'closed'));
    });
    if (!stop && Date.now() < deadline) {
      reconnects++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
    }
  }
  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
  log(`done: ${JSON.stringify(totals)} reconnects=${reconnects} file=${file}`);
  return { file, counts: totals, reconnects };
}
