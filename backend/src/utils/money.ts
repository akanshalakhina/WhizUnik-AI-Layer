/** Format a number using Indian digit grouping, e.g. 185000 -> ₹1,85,000 */
export function formatInr(value: number): string {
  const neg = value < 0;
  const abs = Math.abs(Math.round(value * 100) / 100);
  const [int, dec] = abs.toFixed(2).split('.');
  let head = int.slice(0, -3);
  const tail = int.slice(-3);
  head = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${head},${tail}` : tail;
  return `${neg ? '-' : ''}₹${grouped}${dec === '00' ? '' : `.${dec}`}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  l: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
  m: 1_000_000,
  million: 1_000_000,
};

/**
 * Parse an amount phrase such as "₹1 lakh", "50k", "2.5 crore" or "1,25,000".
 * Returns null when no amount is present.
 */
export function parseAmount(text: string): number | null {
  const m = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|thousand|million|k|l|m)?\b/i.exec(text);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult = m[2] ? UNIT_MULTIPLIERS[m[2].toLowerCase()] ?? 1 : 1;
  return base * mult;
}
