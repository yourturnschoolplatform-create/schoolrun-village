import type { SchoolRunDirection } from './schedules';

export type ConfirmedTripCalendarItem = {
  id: string;
  serviceDate: string;
  windowStart: string;
  windowEnd: string;
  direction: SchoolRunDirection;
  capacity: number;
  timezone: string;
};

function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function localDateTime(date: string, time: string): string {
  return `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
}

export function buildConfirmedTripsIcs(items: ConfirmedTripCalendarItem[]): string {
  const events = items.map((item) => {
    const direction = item.direction === 'pickup' ? 'pickup' : 'drop-off';
    return [
      'BEGIN:VEVENT',
      `UID:${icsEscape(item.id)}@yourturn`,
      `DTSTART;TZID=${icsEscape(item.timezone)}:${localDateTime(item.serviceDate, item.windowStart)}`,
      `DTEND;TZID=${icsEscape(item.timezone)}:${localDateTime(item.serviceDate, item.windowEnd)}`,
      `SUMMARY:${icsEscape(`SchoolRun Village confirmed ${direction}`)}`,
      `DESCRIPTION:${icsEscape(`Confirmed school-run trip. Capacity ${item.capacity}. Pickup details are arranged separately.`)}`,
      'END:VEVENT',
    ].join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SchoolRun Village//Confirmed school trips//EN',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
