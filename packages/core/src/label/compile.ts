import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const require = createRequire(import.meta.url);

/** Loosely typed solc-js wrapper (the package ships no types). */
interface SolcJs {
  version(): string;
  compile(input: string, callbacks?: { import: (p: string) => { contents: string } | { error: string } }): string;
}

export interface Remapping {
  prefix: string;
  /** Target as written (relative targets are resolved against basePath). */
  target: string;
}

export interface CompileOptions {
  /** Root files to compile: paths absolute or relative to basePath. */
  files: string[];
  /** Directory that relative source names / remapping targets resolve against (project dir). */
  basePath: string;
  /** "prefix=target" strings or parsed objects. If omitted, remappings.txt / foundry.toml in basePath are used. */
  remappings?: Array<string | Remapping>;
  /** Overrides foundry.toml's evm_version (e.g. "prague", "cancun"). Omitted = compiler default. */
  evmVersion?: string;
  /** Exact solc version (e.g. "0.8.26"). Omitted = the solc bundled in node_modules. */
  solcVersion?: string;
  /** Where downloaded soljson builds are cached. Default: <cwd>/.readset/solc-cache */
  cacheDir?: string;
  optimizer?: { enabled: boolean; runs: number };
}

export interface SolcDiagnostic {
  severity: 'error' | 'warning' | 'info';
  type: string;
  message: string;
  formattedMessage: string;
  sourceLocation?: { file: string; start: number; end: number };
}

export interface StorageLayoutEntry {
  astId: number;
  /** "<sourceUnit>:<ContractName>" of the declaring contract */
  contract: string;
  label: string;
  offset: number;
  /** decimal string */
  slot: string;
  type: string;
}

export interface StorageLayoutType {
  encoding: 'inplace' | 'mapping' | 'dynamic_array' | 'bytes';
  label: string;
  numberOfBytes: string;
  base?: string;
  key?: string;
  value?: string;
  members?: StorageLayoutEntry[];
}

export interface StorageLayout {
  storage: StorageLayoutEntry[];
  types: Record<string, StorageLayoutType> | null;
}

export interface CompiledSource {
  /** Source unit name as solc saw it (relative path with '/', or remapped name like "@openzeppelin/..."). */
  name: string;
  /** Solc's numeric file id (the 3rd field of every `src`). */
  id: number;
  content: string;
  /** Root `SourceUnit` of the compact AST (untyped; use ast.ts helpers). */
  ast: any;
  /** True when the file was explicitly requested (not pulled in via import). */
  isRoot: boolean;
}

export interface CompiledContract {
  sourceName: string;
  name: string;
  storageLayout: StorageLayout;
  abi: unknown[];
}

export interface CompiledProject {
  solcVersion: string;
  /** How the compiler was obtained: bundled npm package, or a cached/downloaded soljson. */
  solcOrigin: 'npm' | 'cache' | 'download';
  evmVersion?: string;
  basePath: string;
  sources: CompiledSource[];
  contracts: CompiledContract[];
  warnings: SolcDiagnostic[];
}

export class CompileError extends Error {
  constructor(public readonly diagnostics: SolcDiagnostic[]) {
    super(
      `Solidity compilation failed with ${diagnostics.length} error(s):\n` +
        diagnostics.map((d) => d.formattedMessage.trimEnd()).join('\n\n'),
    );
    this.name = 'CompileError';
  }
}

// ---------------------------------------------------------------- remappings

export function parseRemapping(s: string): Remapping {
  let r = s.trim();
  const colon = r.indexOf(':');
  const eq = r.indexOf('=');
  if (colon !== -1 && colon < eq) r = r.slice(colon + 1); // drop "context:" part
  const i = r.indexOf('=');
  if (i === -1) throw new Error(`Invalid remapping "${s}" (expected prefix=target)`);
  return { prefix: r.slice(0, i), target: r.slice(i + 1) };
}

/** Reads remappings.txt and foundry.toml `remappings = [...]` from a Foundry project dir. */
export function readFoundryProject(projectDir: string): {
  remappings: Remapping[];
  evmVersion?: string;
  src: string;
  optimizer?: { enabled: boolean; runs: number };
} {
  const remappings: Remapping[] = [];
  let evmVersion: string | undefined;
  let src = 'src';
  let optimizer: { enabled: boolean; runs: number } | undefined;
  const toml = path.join(projectDir, 'foundry.toml');
  if (fs.existsSync(toml)) {
    const text = fs.readFileSync(toml, 'utf8');
    const m = /^\s*remappings\s*=\s*\[([\s\S]*?)\]/m.exec(text);
    if (m) for (const q of m[1]!.matchAll(/"([^"]+)"|'([^']+)'/g)) remappings.push(parseRemapping((q[1] ?? q[2])!));
    const ev = /^\s*evm_version\s*=\s*["']([^"']+)["']/m.exec(text);
    if (ev) evmVersion = ev[1];
    const sm = /^\s*src\s*=\s*["']([^"']+)["']/m.exec(text);
    if (sm) src = sm[1]!;
    const oe = /^\s*optimizer\s*=\s*(true|false)/m.exec(text);
    const or = /^\s*optimizer_runs\s*=\s*(\d+)/m.exec(text);
    if (oe) optimizer = { enabled: oe[1] === 'true', runs: or ? Number(or[1]) : 200 };
  }
  const txt = path.join(projectDir, 'remappings.txt');
  if (fs.existsSync(txt)) {
    for (const line of fs.readFileSync(txt, 'utf8').split(/\r?\n/)) {
      const l = line.trim();
      if (l && !l.startsWith('#')) remappings.push(parseRemapping(l));
    }
  }
  return { remappings, evmVersion, src, optimizer };
}

// ---------------------------------------------------------------- solc loading

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(download(new URL(res.headers.location, url).toString()));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function loadSolc(
  wanted: string | undefined,
  cacheDir: string,
): Promise<{ solc: SolcJs; origin: CompiledProject['solcOrigin'] }> {
  const bundled: SolcJs = require('solc');
  const bundledVersion = bundled.version().split('+')[0]!;
  if (!wanted || wanted === bundledVersion) return { solc: bundled, origin: 'npm' };

  const wrapper = require('solc/wrapper') as (soljson: unknown) => SolcJs;
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = (v: string) =>
    fs.readdirSync(cacheDir).find((f) => f.startsWith(`soljson-v${v}+commit.`) && f.endsWith('.js'));
  let file = cached(wanted);
  let origin: CompiledProject['solcOrigin'] = 'cache';
  if (!file) {
    const list = JSON.parse((await download('https://binaries.soliditylang.org/bin/list.json')).toString('utf8'));
    const rel = list.releases?.[wanted] as string | undefined;
    if (!rel) throw new Error(`solc ${wanted} not found in binaries.soliditylang.org list`);
    const buf = await download(`https://binaries.soliditylang.org/bin/${rel}`);
    fs.writeFileSync(path.join(cacheDir, rel), buf);
    file = rel;
    origin = 'download';
  }
  return { solc: wrapper(require(path.resolve(cacheDir, file))), origin };
}

// ---------------------------------------------------------------- compile

const toSlash = (p: string) => p.split(path.sep).join('/');

function normaliseRemappings(input: Array<string | Remapping>): Remapping[] {
  return input
    .map((r) => (typeof r === 'string' ? parseRemapping(r) : r))
    .sort((a, b) => b.prefix.length - a.prefix.length); // longest prefix wins
}

/** Resolves a solc source unit name to an absolute disk path (applying remappings). */
export function resolveSourcePath(unit: string, basePath: string, remappings: Remapping[]): string {
  for (const r of remappings) {
    if (unit.startsWith(r.prefix)) return path.resolve(basePath, r.target + unit.slice(r.prefix.length));
  }
  return path.resolve(basePath, unit);
}

export async function compileSources(opts: CompileOptions): Promise<CompiledProject> {
  const basePath = path.resolve(opts.basePath);
  const foundry = readFoundryProject(basePath);
  const remappings = normaliseRemappings(opts.remappings ?? foundry.remappings);
  const evmVersion = opts.evmVersion ?? foundry.evmVersion;
  const optimizer = opts.optimizer ?? foundry.optimizer;
  const cacheDir = opts.cacheDir ?? path.resolve(process.cwd(), '.readset', 'solc-cache');

  const { solc, origin } = await loadSolc(opts.solcVersion, cacheDir);

  const sources: Record<string, { content: string }> = {};
  const rootNames = new Set<string>();
  for (const f of opts.files) {
    const abs = path.resolve(basePath, f);
    const rel = path.relative(basePath, abs);
    const name = rel.startsWith('..') || path.isAbsolute(rel) ? toSlash(abs) : toSlash(rel);
    sources[name] = { content: fs.readFileSync(abs, 'utf8') };
    rootNames.add(name);
  }

  const settings: Record<string, unknown> = {
    remappings: [], // handled by our import callback via source-unit names
    outputSelection: { '*': { '*': ['storageLayout', 'abi'], '': ['ast'] } },
  };
  if (evmVersion) settings.evmVersion = evmVersion;
  if (optimizer) settings.optimizer = optimizer;

  const out = JSON.parse(
    solc.compile(JSON.stringify({ language: 'Solidity', sources, settings }), {
      import: (unit) => {
        try {
          return { contents: fs.readFileSync(resolveSourcePath(unit, basePath, remappings), 'utf8') };
        } catch (e) {
          return { error: `Cannot read import "${unit}": ${(e as Error).message}` };
        }
      },
    }),
  );

  const diags: SolcDiagnostic[] = (out.errors ?? []) as SolcDiagnostic[];
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length) throw new CompileError(errors);

  const outSources: CompiledSource[] = Object.entries<any>(out.sources ?? {})
    .map(([name, s]) => {
      const content =
        sources[name]?.content ?? fs.readFileSync(resolveSourcePath(name, basePath, remappings), 'utf8');
      return { name, id: s.id as number, content, ast: s.ast, isRoot: rootNames.has(name) };
    })
    .sort((a, b) => a.id - b.id);

  const contracts: CompiledContract[] = [];
  for (const [sourceName, cs] of Object.entries<any>(out.contracts ?? {})) {
    for (const [name, c] of Object.entries<any>(cs)) {
      contracts.push({
        sourceName,
        name,
        storageLayout: c.storageLayout ?? { storage: [], types: null },
        abi: c.abi ?? [],
      });
    }
  }

  return {
    solcVersion: solc.version(),
    solcOrigin: origin,
    evmVersion,
    basePath,
    sources: outSources,
    contracts,
    warnings: diags.filter((d) => d.severity !== 'error'),
  };
}
