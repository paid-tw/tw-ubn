/**
 * Convert a Republic-of-China (民國) date string to ISO (Gregorian).
 *
 * Government registries encode dates as a 7-digit string: 3-digit ROC year,
 * 2-digit month, 2-digit day. ROC year + 1911 = Gregorian year.
 * Example: "0760321" -> "1987-03-21".
 *
 * Returns null for empty / malformed values (month or day "00" included),
 * which the source data uses for "unknown".
 */
export function rocToISO(roc: string | null | undefined): string | null {
  if (!roc || !/^\d{7}$/.test(roc)) return null;
  const year = Number(roc.slice(0, 3)) + 1911;
  const mm = roc.slice(3, 5);
  const dd = roc.slice(5, 7);
  if (mm === '00' || dd === '00') return null;
  return `${year}-${mm}-${dd}`;
}
