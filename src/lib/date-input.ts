// Pure helpers for the date text input: progressive YYYY/MM/DD masking,
// parsing forgiving formats into an ISO date, and caret bookkeeping. Kept
// framework-free so they can be unit-tested in isolation.

/**
 * Progressively mask raw input toward `YYYY/MM/DD` using only its digits, so a
 * user can type `20100212` and see `2010/02/12` without typing any separators.
 * Extra digits beyond 8 are dropped.
 */
export function formatDateDraft(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  let out = year;
  if (digits.length > 4) out += `/${month}`;
  if (digits.length > 6) out += `/${day}`;
  return out;
}

/**
 * Parse a forgiving date entry into a canonical `YYYY-MM-DD` string, or `null`
 * if it is not a real calendar date. Accepts `/` or `-` separators, single
 * digit month/day, and bare 8-digit `YYYYMMDD`.
 */
export function parseDateInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replaceAll("/", "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y: string;
  let rawMonth: string;
  let rawDay: string;
  if (match) {
    [, y, rawMonth, rawDay] = match;
  } else if (/^\d{8}$/.test(trimmed)) {
    // Bare digits (e.g. pasted "20100212") → YYYYMMDD.
    y = trimmed.slice(0, 4);
    rawMonth = trimmed.slice(4, 6);
    rawDay = trimmed.slice(6, 8);
  } else {
    return null;
  }
  const m = rawMonth.padStart(2, "0");
  const d = rawDay.padStart(2, "0");
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return `${y}-${m}-${d}`;
}

/** Render an ISO/stored date with `/` separators for display. */
export function toDisplayDate(value: string): string {
  if (!value) return "";
  return value.replaceAll("-", "/");
}

/** Count how many digit characters appear before `caret` in `value`. */
export function countDigits(value: string, caret: number): number {
  let count = 0;
  for (let i = 0; i < caret && i < value.length; i++) {
    if (value[i] >= "0" && value[i] <= "9") count++;
  }
  return count;
}

/** Find the caret offset in `formatted` that sits just after the Nth digit. */
export function caretForDigit(formatted: string, digitIndex: number): number {
  if (digitIndex <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (formatted[i] >= "0" && formatted[i] <= "9") {
      seen++;
      if (seen === digitIndex) return i + 1;
    }
  }
  return formatted.length;
}
