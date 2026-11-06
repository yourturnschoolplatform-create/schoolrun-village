import { describe, expect, it } from 'vitest';
import { expandPatternForFourWeeks, isInstructionalDate, isSuburbAreaLabel } from '../../shared/schedules';

describe('Day 3 recurring schedule expansion', () => {
  const periods = [
    { period_type: 'term' as const, label: 'Term 2', starts_on: '2026-04-06', ends_on: '2026-04-30' },
    { period_type: 'holiday' as const, label: 'Sample closure', starts_on: '2026-04-13', ends_on: '2026-04-13' },
  ];

  it('expands the next four calendar weeks and skips a holiday', () => {
    const instances = expandPatternForFourWeeks({
      weekday: 1,
      starts_on: '2026-04-06',
      window_start: '08:00',
      window_end: '08:30',
      timezone: 'Australia/Melbourne',
    }, '2026-04-06', periods);

    expect(instances.map((instance) => instance.serviceDate)).toEqual(['2026-04-06', '2026-04-20', '2026-04-27']);
    expect(instances.some((instance) => instance.serviceDate === '2026-04-13')).toBe(false);
  });

  it('does not create instances outside configured term periods', () => {
    expect(isInstructionalDate('2026-05-04', periods)).toBe(false);
    expect(isInstructionalDate('2026-04-13', periods)).toBe(false);
    expect(isInstructionalDate('2026-04-20', periods)).toBe(true);
  });

  it('retains the same local time across the Melbourne daylight-saving transition', () => {
    const instances = expandPatternForFourWeeks({
      weekday: 7,
      starts_on: '2026-03-29',
      window_start: '08:00',
      window_end: '08:30',
      timezone: 'Australia/Melbourne',
    }, '2026-03-29', []);
    const dstEndDate = instances.find((instance) => instance.serviceDate === '2026-04-05');

    expect(dstEndDate).toEqual({ serviceDate: '2026-04-05', windowStart: '08:00', windowEnd: '08:30', timezone: 'Australia/Melbourne' });
  });

  it('supports a moving four-week horizon for an active recurring pattern', () => {
    const instances = expandPatternForFourWeeks({
      weekday: 1,
      starts_on: '2026-04-06',
      window_start: '08:00',
      window_end: '08:30',
      timezone: 'Australia/Melbourne',
    }, '2026-04-07', []);

    expect(instances.map((instance) => instance.serviceDate)).toEqual(['2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04']);
  });

  it('allows a broad suburb label but rejects addresses and coordinate-like values', () => {
    expect(isSuburbAreaLabel('Carlton')).toBe(true);
    expect(isSuburbAreaLabel("St Kilda")).toBe(true);
    expect(isSuburbAreaLabel('12 Smith Street')).toBe(false);
    expect(isSuburbAreaLabel('Smith Street')).toBe(false);
    expect(isSuburbAreaLabel('Main Road')).toBe(false);
    expect(isSuburbAreaLabel('-37.8136, 144.9631')).toBe(false);
  });
});
