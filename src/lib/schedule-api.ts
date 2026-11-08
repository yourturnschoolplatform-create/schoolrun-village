import type { SupabaseClient } from '@supabase/supabase-js';
import type { CalendarPeriod, SchoolRunDirection, ScheduleInstanceStatus, ScheduleIntent } from '../../shared/schedules';

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

async function token(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  if (!data.session?.access_token) throw new Error('Please sign in again to use your schedule.');
  return data.session.access_token;
}

async function request<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await token(client);
  const response = await fetch(`/api/schedules${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Your verified school session is required.');
    if (response.status === 400) throw new Error('Please check the time window, date and suburb-level area label.');
    throw new Error('That schedule change could not be completed.');
  }
  return response.json() as Promise<T>;
}

export const scheduleApi = {
  overview: (client: SupabaseClient, start?: string) => request<ScheduleOverview>(client, start ? `/overview?start=${encodeURIComponent(start)}` : '/overview'),
  createPattern: (client: SupabaseClient, input: SchedulePatternInput) => request<{ patternId: string }>(client, '/patterns', { method: 'POST', body: JSON.stringify(input) }),
  updatePattern: (client: SupabaseClient, patternId: string, input: SchedulePatternInput) => request<{ patternId: string }>(client, `/patterns/${encodeURIComponent(patternId)}`, { method: 'PUT', body: JSON.stringify(input) }),
  cancelInstance: (client: SupabaseClient, instanceId: string) => request<{ status: string }>(client, `/instances/${encodeURIComponent(instanceId)}/cancel`, { method: 'POST' }),
  cancelPattern: (client: SupabaseClient, patternId: string) => request<{ cancelledInstances: number }>(client, `/patterns/${encodeURIComponent(patternId)}/cancel`, { method: 'POST' }),
  confirmHousehold: (client: SupabaseClient, householdLinkId: string) => request<{ status: string }>(client, `/households/${encodeURIComponent(householdLinkId)}/confirm`, { method: 'POST' }),
  createHouseholdCode: (client: SupabaseClient) => request<{ code: string }>(client, '/households/invitations', { method: 'POST' }),
  claimHouseholdCode: (client: SupabaseClient, code: string) => request<{ householdLinkId: string }>(client, '/households/invitations/claim', { method: 'POST', body: JSON.stringify({ code }) }),
  async confirmedTripsIcs(client: SupabaseClient): Promise<Blob> {
    const accessToken = await token(client);
    const response = await fetch('/api/schedules/confirmed-trips.ics', { cache: 'no-store', headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error('The confirmed-trip calendar could not be exported.');
    return response.blob();
  },
};
