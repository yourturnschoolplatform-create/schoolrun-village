import { describe, expect, it } from 'vitest';
import { buildConfirmedTripsIcs } from '../../shared/ics';

describe('confirmed trip ICS export', () => {
  it('uses school-local times, escapes text, and omits address-like location data', () => {
    const ics = buildConfirmedTripsIcs([{
      id: 'trip,one',
      serviceDate: '2026-04-05',
      windowStart: '08:00',
      windowEnd: '08:30',
      direction: 'pickup',
      capacity: 2,
      timezone: 'Australia/Melbourne',
    }]);

    expect(ics).toContain('DTSTART;TZID=Australia/Melbourne:20260405T080000');
    expect(ics).toContain('DTEND;TZID=Australia/Melbourne:20260405T083000');
    expect(ics).toContain('UID:trip\\,one@yourturn');
    expect(ics).toContain('SUMMARY:YourTurn confirmed pickup');
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toContain('address');
  });

  it('returns a valid empty calendar until a later matching stage creates confirmed trips', () => {
    const ics = buildConfirmedTripsIcs([]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
