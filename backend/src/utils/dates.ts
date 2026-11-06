/**
 * Date helpers. WhizUnik is operated in India, so "today" is the calendar day in
 * IST (UTC+05:30). All business dates are stored as `YYYY-MM-DD` strings.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** a - b in whole days. */
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

export function startOfMonth(date: string): string {
  const [y, m] = parts(date);
  return new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
}

export function endOfMonth(date: string): string {
  const [y, m] = parts(date);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function startOfNextMonth(date: string): string {
  return addDays(endOfMonth(date), 1);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  const [y, m, d] = parts(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
