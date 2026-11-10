import type { SupabaseClient } from '@supabase/supabase-js';
import { buildConfirmedTripsIcs } from '../../shared/ics';
import { addDays, isIsoDate, type CalendarPeriod, type SchoolRunDirection, type ScheduleInstanceStatus, type ScheduleIntent } from '../../shared/schedules';

export type SchedulePattern = {
  id: string;
  school_id: string;
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  weekday: number;
  window_start: string;
  window_end: string;
  area_label: string;
  capacity: number;
  starts_on: string;
  is_active: boolean;
};

export type ScheduleInstance = {
  id: string;
  pattern_id: string;
  service_date: string;
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  window_start: string;
  window_end: string;
  area_label: string;
  capacity: number;
  status: ScheduleInstanceStatus;
};

export type HouseholdLink = {
  id: string;
  status: 'pending' | 'confirmed' | 'declined' | 'cancelled';
  requested_by: string;
  requester_confirmed_at: string;
  other_parent_confirmed_at: string | null;
};

export type ScheduleOverview = {
  schoolId: string | null;
  timezone: string;
  schoolDisplayName: string | null;
  schoolSuburb: string | null;
  schoolSector: string | null;
  start: string;
  end: string;
  patterns: SchedulePattern[];
  instances: ScheduleInstance[];
  calendarPeriods: CalendarPeriod[];
  householdLinks: HouseholdLink[];
};

export type SchedulePatternInput = {
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  weekday: number;
  windowStart: string;
  windowEnd: string;
  areaLabel: string;
  capacity: number;
  startsOn: string;
};

function localDateInTimeZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function emptyOverview(start?: string): ScheduleOverview {
  const resolvedStart = start && isIsoDate(start) ? start : localDateInTimeZone('Australia/Melbourne');
  return {
    schoolId: null,
    timezone: 'Australia/Melbourne',
    schoolDisplayName: null,
    schoolSuburb: null,
    schoolSector: null,
    start: resolvedStart,
    end: addDays(resolvedStart, 27),
    patterns: [],
    instances: [],
    calendarPeriods: [],
    householdLinks: [],
  };
}

async function requireUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.user?.id) {
    throw new Error('Please sign in again to use your schedule.');
  }
  return data.session.user.id;
}

async function verifiedSchoolId(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from('school_memberships')
    .select('school_id')
    .eq('user_id', userId)
    .eq('status', 'verified')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.school_id ?? null;
}

async function rpcOrThrow<T>(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  fallbackMessage: string,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(fallbackMessage);
  return data as T;
}

export const scheduleApi = {
  /**
   * Schedule hub overview via Supabase RLS (no /api/schedules/overview).
   * Soft-empty when membership/tables/RPCs are unavailable on static hosts.
   */
  overview: async (client: SupabaseClient, start?: string): Promise<ScheduleOverview> => {
    const userId = await requireUserId(client);
    const schoolId = await verifiedSchoolId(client, userId);
    if (!schoolId) return emptyOverview(start);

    let school = await client
      .from('schools')
      .select('timezone, display_name, suburb, school_sector')
      .eq('id', schoolId)
      .maybeSingle();
    if (school.error) {
      school = await client
        .from('schools')
        .select('timezone, display_name')
        .eq('id', schoolId)
        .maybeSingle();
    }

    const timezone = school.data?.timezone ?? 'Australia/Melbourne';
    const resolvedStart = start && isIsoDate(start) ? start : localDateInTimeZone(timezone);
    const end = addDays(resolvedStart, 27);

    // Best-effort refresh; missing RPC must not block the hub.
    await client.rpc('refresh_my_availability_instances');

    const [patterns, instances, calendarPeriods, householdLinks] = await Promise.all([
      client
        .from('availability_patterns')
        .select('*')
        .eq('owner_id', userId)
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false }),
      client
        .from('availability_instances')
        .select('*')
        .eq('owner_id', userId)
        .eq('school_id', schoolId)
        .gte('service_date', resolvedStart)
        .lte('service_date', end)
        .order('service_date', { ascending: true })
        .order('window_start', { ascending: true }),
      client
        .from('school_calendar_periods')
        .select('id, period_type, label, starts_on, ends_on')
        .eq('school_id', schoolId)
        .lte('starts_on', end)
        .gte('ends_on', resolvedStart)
        .order('starts_on', { ascending: true }),
      client
        .from('household_links')
        .select('id, status, requested_by, requester_confirmed_at, other_parent_confirmed_at, created_at')
        .eq('school_id', schoolId)
        .or(`first_parent_id.eq.${userId},second_parent_id.eq.${userId}`)
        .order('created_at', { ascending: false }),
    ]);

    const schoolRow = school.data as {
      timezone?: string;
      display_name?: string;
      suburb?: string | null;
      school_sector?: string | null;
    } | null;

    return {
      schoolId,
      timezone,
      schoolDisplayName: schoolRow?.display_name ?? null,
      schoolSuburb: schoolRow?.suburb ?? null,
      schoolSector: schoolRow?.school_sector ?? null,
      start: resolvedStart,
      end,
      patterns: (patterns.error ? [] : patterns.data ?? []) as SchedulePattern[],
      instances: (instances.error ? [] : instances.data ?? []) as ScheduleInstance[],
      calendarPeriods: (calendarPeriods.error ? [] : calendarPeriods.data ?? []) as CalendarPeriod[],
      householdLinks: (householdLinks.error ? [] : householdLinks.data ?? []) as HouseholdLink[],
    };
  },

  createPattern: async (client: SupabaseClient, input: SchedulePatternInput) => {
    const userId = await requireUserId(client);
    const schoolId = await verifiedSchoolId(client, userId);
    if (!schoolId) throw new Error('Your verified school session is required.');
    const patternId = await rpcOrThrow<string>(
      client,
      'create_availability_pattern',
      {
        p_school_id: schoolId,
        p_intent: input.intent,
        p_direction: input.direction,
        p_weekday: input.weekday,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
        p_area_label: input.areaLabel,
        p_capacity: input.capacity,
        p_starts_on: input.startsOn,
      },
      'Please check the time window, date and suburb-level area label.',
    );
    return { patternId };
  },

  updatePattern: async (client: SupabaseClient, patternId: string, input: SchedulePatternInput) => {
    await requireUserId(client);
    const updatedId = await rpcOrThrow<string>(
      client,
      'update_availability_pattern',
      {
        p_pattern_id: patternId,
        p_intent: input.intent,
        p_direction: input.direction,
        p_weekday: input.weekday,
        p_window_start: input.windowStart,
        p_window_end: input.windowEnd,
        p_area_label: input.areaLabel,
        p_capacity: input.capacity,
        p_starts_on: input.startsOn,
      },
      'Please check the time window, date and suburb-level area label.',
    );
    return { patternId: updatedId };
  },

  cancelInstance: async (client: SupabaseClient, instanceId: string) => {
    await requireUserId(client);
    const status = await rpcOrThrow<string>(
      client,
      'cancel_availability_instance',
      { p_instance_id: instanceId },
      'That schedule change could not be completed.',
    );
    return { status };
  },

  cancelPattern: async (client: SupabaseClient, patternId: string) => {
    await requireUserId(client);
    const cancelledInstances = await rpcOrThrow<number>(
      client,
      'cancel_availability_pattern',
      { p_pattern_id: patternId },
      'That schedule change could not be completed.',
    );
    return { cancelledInstances };
  },

  confirmHousehold: async (client: SupabaseClient, householdLinkId: string) => {
    await requireUserId(client);
    const status = await rpcOrThrow<string>(
      client,
      'confirm_household_link',
      { link_id: householdLinkId },
      'That schedule change could not be completed.',
    );
    return { status };
  },

  createHouseholdCode: async (client: SupabaseClient) => {
    await requireUserId(client);
    const code = await rpcOrThrow<string>(
      client,
      'create_household_link_invitation',
      {},
      'That schedule change could not be completed.',
    );
    return { code };
  },

  claimHouseholdCode: async (client: SupabaseClient, code: string) => {
    await requireUserId(client);
    const { data, error } = await client.rpc('claim_household_link_invitation', { p_token: code });
    if (error) throw new Error('That household confirmation code is unavailable.');
    return { householdLinkId: data as string };
  },

  async confirmedTripsIcs(client: SupabaseClient): Promise<Blob> {
    const userId = await requireUserId(client);
    const schoolId = await verifiedSchoolId(client, userId);
    if (!schoolId) throw new Error('Your verified school session is required.');

    const [instances, school] = await Promise.all([
      client
        .from('availability_instances')
        .select('id, service_date, window_start, window_end, direction, capacity')
        .eq('owner_id', userId)
        .eq('school_id', schoolId)
        .eq('status', 'confirmed')
        .order('service_date', { ascending: true }),
      client.from('schools').select('timezone').eq('id', schoolId).maybeSingle(),
    ]);

    if (instances.error) throw new Error('The confirmed-trip calendar could not be exported.');
    const schoolTimezone = school.data?.timezone ?? 'Australia/Melbourne';
    const today = localDateInTimeZone(schoolTimezone);
    const ics = buildConfirmedTripsIcs(
      (instances.data ?? [])
        .filter((item) => item.service_date >= today)
        .map((item) => ({
          id: item.id,
          serviceDate: item.service_date,
          windowStart: String(item.window_start).slice(0, 5),
          windowEnd: String(item.window_end).slice(0, 5),
          direction: item.direction as SchoolRunDirection,
          capacity: item.capacity,
          timezone: schoolTimezone,
        })),
    );
    return new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  },
};
