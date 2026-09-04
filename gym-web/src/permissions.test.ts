import { describe, it, expect } from 'vitest';
import { hasPermission } from './permissions';

describe('hasPermission', () => {
  it('returns false without a resolved gym context', () => {
    expect(hasPermission(null, 'members.view')).toBe(false);
  });

  it('returns false when the context holds no permissions', () => {
    expect(hasPermission({ permissions: [] }, 'members.view')).toBe(false);
  });

  it('grants access when ANY of the listed permissions matches', () => {
    const ctx = { permissions: ['attendance.manage'] };
    expect(hasPermission(ctx, 'attendance.manage', 'checkin.manage')).toBe(true);
    expect(hasPermission({ permissions: ['checkin.manage'] }, 'attendance.manage', 'checkin.manage')).toBe(true);
  });

  it('denies when none of the listed permissions match', () => {
    expect(hasPermission({ permissions: ['members.view'] }, 'payments.manage')).toBe(false);
    expect(hasPermission({ permissions: ['members.view'] }, 'payments.manage', 'reports.view')).toBe(false);
  });

  it('matches exact permission strings only (no prefixes)', () => {
    expect(hasPermission({ permissions: ['members.view.all'] }, 'members.view')).toBe(false);
  });
});
