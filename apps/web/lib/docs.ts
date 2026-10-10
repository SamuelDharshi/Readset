import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';

/**
 * The docs page renders the repo's own markdown rather than a second copy of it. One source,
 * so a doc cannot drift from the site. Server-only.
 */
export const DOCS_DIR = process.env.READSET_DOCS_DIR ?? path.resolve(process.cwd(), '../../docs');

export interface DocEntry {
  slug: string;
  title: string;
  file: string;
  group: 'Using Readset' | 'How it works' | 'Evidence';
}

/** Curated order and grouping: the repo has more docs than a reader needs up front. */
const INDEX: DocEntry[] = [
  { slug: 'mcp', title: 'MCP server', file: 'mcp.md', group: 'Using Readset' },
  { slug: 'viem', title: 'viem wrapper', file: 'viem.md', group: 'Using Readset' },
  { slug: 'breaker', title: 'Breaker & policy', file: 'breaker.md', group: 'Using Readset' },
  { slug: 'receipts', title: 'Dependency receipts', file: 'receipts.md', group: 'Using Readset' },
  { slug: 'gate', title: 'The gate', file: 'gate.md', group: 'How it works' },
  { slug: 'explain', title: 'Explaining a failure', file: 'explain.md', group: 'How it works' },
  { slug: 'architecture', title: 'Architecture', file: 'architecture.md', group: 'How it works' },
  { slug: 'benchmark', title: 'Benchmark method', file: 'benchmark.md', group: 'Evidence' },
  { slug: 'facts', title: 'Fact-check of every claim', file: 'facts.md', group: 'Evidence' },
  { slug: 'k1', title: 'Kill test K1 — tracing', file: 'kill-tests/K1.md', group: 'Evidence' },
  { slug: 'k2', title: 'Kill test K2 — is the loss real', file: 'kill-tests/K2.md', group: 'Evidence' },
  { slug: 'k3', title: 'Kill test K3 — MetaMask plugin', file: 'kill-tests/K3.md', group: 'Evidence' },
  { slug: 'k4', title: 'Kill test K4 — block sockets', file: 'kill-tests/K4.md', group: 'Evidence' },
];

export function docIndex(): DocEntry[] {
  return INDEX;
}

export function findDoc(slug: string): DocEntry | undefined {
  return INDEX.find((d) => d.slug === slug);
}

export async function listAvailable(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const d of INDEX) {
    try {
      await readFile(path.join(DOCS_DIR, d.file), 'utf8');
      out.add(d.slug);
    } catch {
      /* a doc that is not on disk simply does not appear */
    }
  }
  return out;
}

export async function renderDoc(entry: DocEntry): Promise<string | null> {
  try {
    const md = await readFile(path.join(DOCS_DIR, entry.file), 'utf8');
    // The docs are our own committed files, not user input, so rendering them is safe.
    return await marked.parse(md, { async: true, gfm: true });
  } catch {
    return null;
  }
}

/** Unused by the page, but keeps the directory listing available for a future index. */
export async function allDocFiles(): Promise<string[]> {
  try {
    return (await readdir(DOCS_DIR)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
