import { Router, type Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { buildConfirmedTripsIcs } from '../shared/ics.js';
import { addDays, isIsoDate, isLocalTime, isSuburbAreaLabel, type SchoolRunDirection, type ScheduleIntent } from '../shared/schedules.js';
import { databaseErrorCode } from './safe-error-log.js';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

export class ScheduleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleInputError';
  }
}

type SignedInContext = {
  user: User;
  client: ReturnType<typeof createRequestScopedSupabaseClient>;
};

function noStore(response: { setHeader: (name: string, value: string) => void }): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
}

function stringField(value: unknown, field: string, min = 1, max = 160): string {
  if (typeof value !== 'string') throw new ScheduleInputError(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new ScheduleInputError(`${field} is invalid.`);
  return trimmed;
}

function uuidField(value: unknown, field: string): string {
  const parsed = stringField(value, field, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) throw new ScheduleInputError(`${field} is invalid.`);
  return parsed;
}

function integerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ScheduleInputError(`${field} is invalid.`);
  return value;
}

function dateField(value: unknown, field: string): string {
  const parsed = stringField(value, field, 10, 10);
  if (!isIsoDate(parsed)) throw new ScheduleInputError(`${field} is invalid.`);
  return parsed;
}

function timeField(value: unknown, field: string): string {
  const parsed = stringField(value, field, 5, 5);
  if (!isLocalTime(parsed)) throw new ScheduleInputError(`${field} is invalid.`);
  return parsed;
}

function localDateInTimeZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function signedInContext(request: Request): Promise<SignedInContext> {
  const client = createRequestScopedSupabaseClient(request);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new RequestAuthenticationError();
  return { client, user: data.user };
}

async function verifiedSchoolId(context: SignedInContext): Promise<string | null> {
  const { data, error } = await context.client
    .from('school_memberships')
    .select('school_id')
    .eq('user_id', context.user.id)
    .eq('status', 'verified')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.school_id ?? null;
}

function patternPayload(body: Record<string, unknown>) {
  const intent = stringField(body.intent, 'intent', 8, 8);
  const direction = stringField(body.direction, 'direction', 6, 7);
  if (intent !== 'can_help' && intent !== 'need_help') throw new ScheduleInputError('intent is invalid.');
  if (direction !== 'pickup' && direction !== 'dropoff') throw new ScheduleInputError('direction is invalid.');
  const areaLabel = stringField(body.areaLabel, 'areaLabel', 2, 64);
  if (!isSuburbAreaLabel(areaLabel)) throw new ScheduleInputError('areaLabel must be a suburb-level label, not an address.');
  const start = timeField(body.windowStart, 'windowStart');
  const end = timeField(body.windowEnd, 'windowEnd');
  if (end <= start) throw new ScheduleInputError('windowEnd must be after windowStart.');
  return {
    intent: intent as ScheduleIntent,
    direction: direction as SchoolRunDirection,
    weekday: integerField(body.weekday, 'weekday', 1, 7),
    windowStart: start,
    windowEnd: end,
    areaLabel,
    capacity: integerField(body.capacity, 'capacity', 1, 8),
    startsOn: dateField(body.startsOn, 'startsOn'),
  };
}

export function createSchedulesRouter(): Router {
  const router = Router();

  router.get('/overview', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const schoolId = await verifiedSchoolId(context);
      if (!schoolId) {
        const start = typeof request.query.start === 'string' && isIsoDate(request.query.start) ? request.query.start : localDateInTimeZone('Australia/Melbourne');
        const end = addDays(start, 27);
        noStore(response);
        response.json({
          schoolId: null,
          timezone: 'Australia/Melbourne',
          schoolDisplayName: null,
          schoolSuburb: null,
          schoolSector: null,
          start,
          end,
          patterns: [],
          instances: [],
          calendarPeriods: [],
          householdLinks: [],
        });
        return;
      }
      let school = await context.client
        .from('schools')
        .select('timezone, display_name, suburb, school_sector')
        .eq('id', schoolId)
        .maybeSingle();
      if (school.error) {
        // Pre-0057 databases may not have suburb/school_sector yet.
        school = await context.client
          .from('schools')
          .select('timezone, display_name')
          .eq('id', schoolId)
          .maybeSingle();
      }
      if (school.error) throw school.error;
      const timezone = school.data?.timezone ?? 'Australia/Melbourne';
      const start = typeof request.query.start === 'string' && isIsoDate(request.query.start) ? request.query.start : localDateInTimeZone(timezone);
      const end = addDays(start, 27);
      const refreshResult = await context.client.rpc('refresh_my_availability_instances');
      if (refreshResult.error) throw refreshResult.error;
      const [patterns, instances, calendarPeriods, householdLinks] = await Promise.all([
        context.client.from('availability_patterns').select('*').eq('owner_id', context.user.id).eq('school_id', schoolId).order('created_at', { ascending: false }),
        context.client.from('availability_instances').select('*').eq('owner_id', context.user.id).eq('school_id', schoolId).gte('service_date', start).lte('service_date', end).order('service_date', { ascending: true }).order('window_start', { ascending: true }),
        context.client.from('school_calendar_periods').select('id, period_type, label, starts_on, ends_on').eq('school_id', schoolId).lte('starts_on', end).gte('ends_on', start).order('starts_on', { ascending: true }),
        context.client.from('household_links').select('id, status, requested_by, requester_confirmed_at, other_parent_confirmed_at, created_at').eq('school_id', schoolId).or(`first_parent_id.eq.${context.user.id},second_parent_id.eq.${context.user.id}`).order('created_at', { ascending: false }),
      ]);
      for (const result of [patterns, instances, calendarPeriods, householdLinks]) if (result.error) throw result.error;
      const schoolRow = school.data as {
        timezone?: string;
        display_name?: string;
        suburb?: string | null;
        school_sector?: string | null;
      } | null;
      noStore(response);
      response.json({
        schoolId,
        timezone,
        schoolDisplayName: schoolRow?.display_name ?? null,
        schoolSuburb: schoolRow?.suburb ?? null,
        schoolSector: schoolRow?.school_sector ?? null,
        start,
        end,
        patterns: patterns.data ?? [],
        instances: instances.data ?? [],
        calendarPeriods: calendarPeriods.data ?? [],
        householdLinks: householdLinks.data ?? [],
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/patterns', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const schoolId = await verifiedSchoolId(context);
      if (!schoolId) throw new RequestAuthenticationError();
      const payload = patternPayload(request.body ?? {});
      const { data, error } = await context.client.rpc('create_availability_pattern', {
        p_school_id: schoolId,
        p_intent: payload.intent,
        p_direction: payload.direction,
        p_weekday: payload.weekday,
        p_window_start: payload.windowStart,
        p_window_end: payload.windowEnd,
        p_area_label: payload.areaLabel,
        p_capacity: payload.capacity,
        p_starts_on: payload.startsOn,
      });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ patternId: data });
    } catch (error) {
      next(error);
    }
  });

  router.put('/patterns/:patternId', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const payload = patternPayload(request.body ?? {});
      const patternId = uuidField(request.params.patternId, 'patternId');
      const { data, error } = await context.client.rpc('update_availability_pattern', {
        p_pattern_id: patternId,
        p_intent: payload.intent,
        p_direction: payload.direction,
        p_weekday: payload.weekday,
        p_window_start: payload.windowStart,
        p_window_end: payload.windowEnd,
        p_area_label: payload.areaLabel,
        p_capacity: payload.capacity,
        p_starts_on: payload.startsOn,
      });
      if (error) throw error;
      noStore(response);
      response.json({ patternId: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/instances/:instanceId/cancel', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const instanceId = uuidField(request.params.instanceId, 'instanceId');
      const { data, error } = await context.client.rpc('cancel_availability_instance', { p_instance_id: instanceId });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ status: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/patterns/:patternId/cancel', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const patternId = uuidField(request.params.patternId, 'patternId');
      const { data, error } = await context.client.rpc('cancel_availability_pattern', { p_pattern_id: patternId });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ cancelledInstances: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/households', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const otherParentId = uuidField(request.body?.otherParentId, 'otherParentId');
      const { data, error } = await context.client.rpc('request_household_link', { other_parent: otherParentId });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ householdLinkId: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/households/invitations', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const { data, error } = await context.client.rpc('create_household_link_invitation');
      if (error) throw error;
      noStore(response);
      response.status(201).json({ code: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/households/invitations/claim', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const code = stringField(request.body?.code, 'household confirmation code', 48, 48);
      const { data, error } = await context.client.rpc('claim_household_link_invitation', { p_token: code });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ householdLinkId: data });
    } catch (error) {
      if (databaseErrorCode(error) === 'P0002') {
        noStore(response);
        response.status(404).json({ error: 'invitation_unavailable' });
        return;
      }
      next(error);
    }
  });

  router.post('/households/:householdLinkId/confirm', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const householdLinkId = uuidField(request.params.householdLinkId, 'householdLinkId');
      const { data, error } = await context.client.rpc('confirm_household_link', { link_id: householdLinkId });
      if (error) throw error;
      noStore(response);
      response.status(201).json({ status: data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/confirmed-trips.ics', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const schoolId = await verifiedSchoolId(context);
      if (!schoolId) throw new RequestAuthenticationError();
      const [instances, school] = await Promise.all([
        context.client.from('availability_instances').select('id, service_date, window_start, window_end, direction, capacity').eq('owner_id', context.user.id).eq('school_id', schoolId).eq('status', 'confirmed').order('service_date', { ascending: true }),
        context.client.from('schools').select('timezone').eq('id', schoolId).maybeSingle(),
      ]);
      if (instances.error) throw instances.error;
      if (school.error) throw school.error;
      const schoolTimezone = school.data?.timezone ?? 'Australia/Melbourne';
      const today = localDateInTimeZone(schoolTimezone);
      const ics = buildConfirmedTripsIcs((instances.data ?? []).filter((item) => item.service_date >= today).map((item) => ({
        id: item.id,
        serviceDate: item.service_date,
        windowStart: item.window_start.slice(0, 5),
        windowEnd: item.window_end.slice(0, 5),
        direction: item.direction as SchoolRunDirection,
        capacity: item.capacity,
        timezone: schoolTimezone,
      })));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      response.setHeader('Content-Disposition', 'attachment; filename="yourturn-confirmed-trips.ics"');
      response.status(200).send(ics);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
