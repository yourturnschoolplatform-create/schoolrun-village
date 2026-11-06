export const SCHEDULE_INTENTS = ['can_help', 'need_help'] as const;
export const SCHOOL_RUN_DIRECTIONS = ['pickup', 'dropoff'] as const;
export const SCHEDULE_INSTANCE_STATUSES = ['open', 'cancelled', 'confirmed'] as const;

export type ScheduleIntent = (typeof SCHEDULE_INTENTS)[number];
export type SchoolRunDirection = (typeof SCHOOL_RUN_DIRECTIONS)[number];
export type ScheduleInstanceStatus = (typeof SCHEDULE_INSTANCE_STATUSES)[number];
export type CalendarPeriod = {
  period_type: 'term' | 'holiday';
  starts_on: string;
  ends_on: string;
  label: string;
};

export type WeeklyPatternForExpansion = {
  weekday: number;
  starts_on: string;
  window_start: string;
  window_end: string;
  timezone: string;
};

export type ExpandedScheduleDate = {
  serviceDate: string;
  windowStart: string;
  windowEnd: string;
  timezone: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SUBURB_LABEL = /^[A-Za-z][A-Za-z '-]{1,63}$/;
const STREET_SUFFIX = /(?:^|\s)(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|crescent|cres|place|pl|boulevard|bvd|way|highway|hwy|terrace|tce|close|circuit|parade|pde|esplanade|esp)\.?$/i;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

export function isSuburbAreaLabel(value: string): boolean {
  return value === value.trim() && SUBURB_LABEL.test(value) && !STREET_SUFFIX.test(value);
}

function parseIsoDate(value: string): Date {
  if (!isIsoDate(value)) throw new Error('A valid ISO calendar date is required.');
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(date: string, amount: number): string {
  const next = parseIsoDate(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
}

/** ISO weekday: Monday = 1, Sunday = 7. This operates on calendar dates only. */
export function isoWeekday(date: string): number {
  const weekday = parseIsoDate(date).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function dateInPeriod(date: string, period: Pick<CalendarPeriod, 'starts_on' | 'ends_on'>): boolean {
  return date >= period.starts_on && date <= period.ends_on;
}

export function isInstructionalDate(date: string, periods: CalendarPeriod[]): boolean {
  const holidays = periods.filter((period) => period.period_type === 'holiday');
  if (holidays.some((period) => dateInPeriod(date, period))) return false;
  const terms = periods.filter((period) => period.period_type === 'term');
  return terms.length === 0 || terms.some((period) => dateInPeriod(date, period));
}

/**
 * Expands a weekly pattern for exactly 28 school-local calendar dates. Local
 * time strings are copied verbatim; no UTC conversion can move a DST date.
 */
export function expandPatternForFourWeeks(
  pattern: WeeklyPatternForExpansion,
  fromDate: string,
  periods: CalendarPeriod[],
): ExpandedScheduleDate[] {
  if (!Number.isInteger(pattern.weekday) || pattern.weekday < 1 || pattern.weekday > 7) throw new Error('weekday is invalid.');
  if (!isLocalTime(pattern.window_start) || !isLocalTime(pattern.window_end) || pattern.window_end <= pattern.window_start) {
    throw new Error('A valid local time window is required.');
  }
  const start = fromDate > pattern.starts_on ? fromDate : pattern.starts_on;
  parseIsoDate(start);
  const instances: ExpandedScheduleDate[] = [];
  for (let offset = 0; offset < 28; offset += 1) {
    const serviceDate = addDays(start, offset);
    if (isoWeekday(serviceDate) === pattern.weekday && isInstructionalDate(serviceDate, periods)) {
      instances.push({ serviceDate, windowStart: pattern.window_start, windowEnd: pattern.window_end, timezone: pattern.timezone });
    }
  }
  return instances;
}

export function shortWeekday(weekday: number): string {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekday - 1] ?? '—';
}
