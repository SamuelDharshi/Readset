const nf = new Intl.NumberFormat('en-US');

export const n = (x: number | bigint) => nf.format(x);
export const pct = (x: number, dp?: number) => `${(x * 100).toFixed(dp ?? (x < 0.1 ? 2 : 1))}%`;
export const mon = (x: number) => `${nf.format(Math.round(x))} MON`;
export const monFine = (wei: string | bigint) => `${(Number(wei) / 1e18).toFixed(6)} MON`;
export const short = (s?: string | null, h = 10, t = 8) =>
  !s ? '—' : s.length <= h + t + 1 ? s : `${s.slice(0, h)}…${s.slice(-t)}`;
