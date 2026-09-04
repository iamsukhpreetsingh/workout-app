import { describe, it, expect } from 'vitest';
import { formatMoney } from './billing';

describe('formatMoney', () => {
  it('formats INR (paise → rupees) with Indian grouping', () => {
    expect(formatMoney(250000, 'INR')).toBe('₹2,500');
    expect(formatMoney(123456789, 'INR')).toBe('₹12,34,567.89');
  });

  it('formats other known currencies with their symbols', () => {
    expect(formatMoney(1999, 'USD')).toBe('$19.99');
    expect(formatMoney(500, 'EUR')).toBe('€5');
    expect(formatMoney(1000, 'GBP')).toBe('£10');
  });

  it('falls back to the currency code prefix for unknown currencies', () => {
    expect(formatMoney(1250, 'AUD')).toBe('AUD 12.5');
  });

  it('handles zero and fractional paise edge cases', () => {
    expect(formatMoney(0, 'INR')).toBe('₹0');
    expect(formatMoney(99, 'INR')).toBe('₹0.99');
    expect(formatMoney(1, 'INR')).toBe('₹0.01');
  });

  it('keeps at most 2 decimals (no floating point drift)', () => {
    expect(formatMoney(1234, 'INR')).toBe('₹12.34');
  });
});
