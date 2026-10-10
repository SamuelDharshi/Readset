/** bigints are everywhere in a tx; the host serialises command results as JSON. */
export function jsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
