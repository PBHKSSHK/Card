// Hong Kong local-date helpers. HK is UTC+8 with no DST. The app runs in the
// browser's timezone but all business dates (claim dates, journal dates,
// period_month buckets) must be HK-local — otherwise `new Date().toISOString()`
// yields *yesterday* for staff working before 08:00 HKT, and mis-buckets the
// 1st of a month into the previous month.

const HK_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Today's date in HK time as YYYY-MM-DD. */
export function todayHK(): string {
  return new Date(Date.now() + HK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Current HK month as YYYY-MM. */
export function currentMonthHK(): string {
  return todayHK().slice(0, 7);
}

/**
 * Convert an ISO timestamp / timestamptz string to its HK-local YYYY-MM-DD.
 * A plain YYYY-MM-DD passes through unchanged.
 */
export function toHKDate(iso: string | null | undefined): string {
  if (!iso) return "";
  // Already a bare calendar date — no timezone shift to apply.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso).slice(0, 10);
  return new Date(t + HK_OFFSET_MS).toISOString().slice(0, 10);
}
