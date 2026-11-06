import { describe, expect, it } from 'vitest';
import { fmtDate, inr, inrSmall, statusTone, titleCase } from './format';

describe('formatting helpers', () => {
  it('formats rupees with Indian grouping', () => {
    expect(inr(185000)).toBe('₹1,85,000');
    expect(inr(1234567)).toBe('₹12,34,567');
    expect(inr(-5000)).toBe('-₹5,000');
    expect(inr(null)).toBe('—');
  });
  it('shows small AI costs with enough precision', () => {
    expect(inrSmall(0)).toBe('₹0');
    expect(inrSmall(0.0315)).toBe('₹0.0315');
    expect(inrSmall(12.5)).toBe('₹12.50');
  });
  it('formats dates and labels', () => {
    expect(fmtDate('2026-11-05')).toContain('2026');
    expect(fmtDate(null)).toBe('—');
    expect(titleCase('waiting_stock')).toBe('Waiting Stock');
  });
  it('maps statuses to tones', () => {
    expect(statusTone('overdue')).toBe('red');
    expect(statusTone('waiting_stock')).toBe('amber');
    expect(statusTone('paid')).toBe('green');
    expect(statusTone('refused')).toBe('red');
    expect(statusTone('open')).toBe('blue');
  });
});
