// CSV helpers shared by every export path.
//
// Two problems these fix:
//  1. Formula injection — a cell whose text starts with = + - @ (or a tab/CR)
//     is executed as a formula when the CSV is opened in Excel/Sheets. Merchant
//     names, memos, descriptions etc. are statement/user-controlled, so they
//     must be neutralized.
//  2. Column shifting — any embedded " must be doubled, and text cells must be
//     wrapped in quotes, or a stray quote/comma pushes amounts into the wrong
//     column on import.

/** Encode an arbitrary text value as a safe, quoted CSV cell. */
export function csvText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  // Neutralize spreadsheet formula injection by prefixing a single quote.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Encode a money amount as a plain (unquoted) 2-dp cell; empty for null. */
export function csvAmount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

/** Join a row of already-encoded cells. */
export function csvRow(cells: (string | number)[]): string {
  return cells.join(",");
}
