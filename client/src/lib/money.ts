// Money rounding helpers. All journal amounts must be rounded to 2 decimal
// places BEFORE they are summed and BEFORE they are written to CSV, otherwise
// binary-float artifacts (e.g. 1013.1810570000001) and per-line vs total
// rounding drift make NetSuite reject the journal entry as unbalanced.

/** Round to 2 decimal places (banker-safe enough for HKD cents). */
export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Sum an array of amounts, rounding the result to 2dp. */
export function sum2(values: (number | null | undefined)[]): number {
  return round2(values.reduce<number>((s, v) => s + (Number(v) || 0), 0));
}
