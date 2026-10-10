import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The site reads committed measurement output. Nothing here invents a number: a missing file
 * means the page says "not measured yet" and prints the command that produces it.
 * Server-only — these paths do not exist in the browser.
 */
export const RESULTS_DIR =
  process.env.READSET_RESULTS_DIR ?? path.resolve(process.cwd(), '../../results');

export async function readResult<T>(rel: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path.join(RESULTS_DIR, rel), 'utf8')) as T;
  } catch {
    return null;
  }
}
