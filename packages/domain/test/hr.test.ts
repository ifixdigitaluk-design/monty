import { describe, expect, it } from 'vitest';
import { addDays } from '../src/dates';
import { allReports, canApproveLeave, canSeePrivate, leaveBalance, managementChain, overlaps, workingDays, workingDaysInYear, wouldCreateManagerCycle } from '../src/hr';

describe('leave days', () => {
  it('counts Monday–Friday only, half days for single days', () => {
    expect(workingDays('2026-11-02', '2026-11-06')).toBe(5); // Mon–Fri
    expect(workingDays('2026-11-06', '2026-11-09')).toBe(2); // Fri–Mon over a weekend
    expect(workingDays('2026-11-07', '2026-11-08')).toBe(0); // weekend only
    expect(workingDays('2026-11-03', '2026-11-03', true)).toBe(0.5);
    expect(workingDays('2026-11-03', '2026-11-05', true)).toBe(3); // half day ignored for ranges
    expect(workingDays('2026-11-05', '2026-11-03')).toBe(0);
  });
  it('splits requests across years', () => {
    // Wed 30 Dec 2026 – Fri 8 Jan 2027: 2 days in 2026, 6 in 2027.
    expect(workingDaysInYear('2026-12-30', '2027-01-08', false, 2026)).toBe(2);
    expect(workingDaysInYear('2026-12-30', '2027-01-08', false, 2027)).toBe(6);
    expect(workingDaysInYear('2026-12-30', '2027-01-08', false, 2028)).toBe(0);
  });
  it('balance deducts approved annual leave only; pending shown separately', () => {
    const b = leaveBalance(25, [
      { type: 'annual', status: 'approved', startDate: '2026-11-02', endDate: '2026-11-06', halfDay: false },
      { type: 'annual', status: 'pending', startDate: '2026-12-14', endDate: '2026-12-15', halfDay: false },
      { type: 'annual', status: 'declined', startDate: '2026-12-01', endDate: '2026-12-01', halfDay: false },
      { type: 'sick', status: 'approved', startDate: '2026-10-01', endDate: '2026-10-02', halfDay: false },
      { type: 'annual', status: 'approved', startDate: '2026-10-20', endDate: '2026-10-20', halfDay: true },
    ], 2026);
    expect(b).toEqual({ allowance: 25, taken: 5.5, pending: 2, remaining: 19.5, remainingAfterPending: 17.5 });
  });
  it('overlap and date helpers', () => {
    expect(overlaps({ startDate: '2026-11-02', endDate: '2026-11-04' }, { startDate: '2026-11-04', endDate: '2026-11-10' })).toBe(true);
    expect(overlaps({ startDate: '2026-11-02', endDate: '2026-11-03' }, { startDate: '2026-11-04', endDate: '2026-11-10' })).toBe(false);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('reporting lines and privacy', () => {
  // ceo ← cto ← lead ← dev ; ceo ← hrp ; outsider has no manager
  const m = new Map<string, string | null>([['ceo', null], ['cto', 'ceo'], ['lead', 'cto'], ['dev', 'lead'], ['hrp', 'ceo'], ['peer', 'cto']]);
  it('walks the chain and finds reports', () => {
    expect(managementChain('dev', m)).toEqual(['lead', 'cto', 'ceo']);
    expect(allReports('cto', m).sort()).toEqual(['dev', 'lead', 'peer']);
    expect(managementChain('loop', new Map([['loop', 'a'], ['a', 'loop']]))).toEqual(['a']);
  });
  it('prevents cycles', () => {
    expect(wouldCreateManagerCycle('cto', 'dev', m)).toBe(true);
    expect(wouldCreateManagerCycle('dev', 'dev', m)).toBe(true);
    expect(wouldCreateManagerCycle('dev', 'hrp', m)).toBe(false);
    expect(wouldCreateManagerCycle('dev', null, m)).toBe(false);
  });
  it('private details: self, HR admins, management chain — not peers or reports', () => {
    expect(canSeePrivate({ userId: 'dev', isHrAdmin: false }, 'dev', m)).toBe(true);
    expect(canSeePrivate({ userId: 'cto', isHrAdmin: false }, 'dev', m)).toBe(true);
    expect(canSeePrivate({ userId: 'peer', isHrAdmin: false }, 'dev', m)).toBe(false);
    expect(canSeePrivate({ userId: 'dev', isHrAdmin: false }, 'lead', m)).toBe(false);
    expect(canSeePrivate({ userId: 'hrp', isHrAdmin: true }, 'cto', m)).toBe(true);
  });
  it('leave approval never by the requester', () => {
    expect(canApproveLeave({ userId: 'lead', isHrAdmin: false }, 'dev', m)).toBe(true);
    expect(canApproveLeave({ userId: 'peer', isHrAdmin: false }, 'dev', m)).toBe(false);
    expect(canApproveLeave({ userId: 'hrp', isHrAdmin: true }, 'hrp', m)).toBe(false);
  });
});
