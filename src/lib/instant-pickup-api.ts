import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { SchoolRunDirection, ScheduleIntent } from '../../shared/schedules';
import type { ChatRoom } from './chat-api';

export type InstantPickupCheckInStatus = 'pending' | 'confirmed' | null;

export type InstantPickupRequest = {
  id: string;
  schoolId: string;
  requesterId: string;
  requesterDisplayName: string;
  matchedUserId: string | null;
  matchedDisplayName: string | null;
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  targetDate: string;
  areaLabel: string;
  notes: string | null;
  status: 'open' | 'matched' | 'expired' | 'cancelled';
  checkInStatus: InstantPickupCheckInStatus;
  finalCheckAt: string | null;
  pickupAt: string | null;
  chatRoomId: string | null;
  mine: boolean;
  iAmMatched: boolean;
  createdAt: string;
  schoolSuburb?: string;
  requesterTrustBand?: string;
  requesterParentTrustBand?: string;
};

export type InstantPickupAcceptResult = {
  request: InstantPickupRequest;
  chatRoom: ChatRoom;
};

type InstantPickupRow = {
  id: string;
  school_id: string;
  requester_id: string;
  matched_user_id?: string | null;
  intent: ScheduleIntent;
  direction: SchoolRunDirection;
  target_date: string;
  area_label: string;
  notes: string | null;
  status: InstantPickupRequest['status'];
  check_in_status?: InstantPickupCheckInStatus;
  final_check_at?: string | null;
  chat_room_id?: string | null;
  created_at: string;
};

function logPickupError(scope: string, error: unknown): void {
  if (error && typeof error === 'object') {
    const row = error as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
      status?: number;
    };
    console.error(`instantPickup.${scope}`, {
      message: row.message,
      code: row.code,
      details: row.details,
      hint: row.hint,
      status: row.status,
    });
    return;
  }
  console.error(`instantPickup.${scope}`, error);
}

function friendlyPickupError(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : '';
  const lower = message.toLowerCase();
  if (
    lower.includes('sign in')
    || lower.includes('authentication')
    || lower.includes('jwt')
    || lower.includes('not authenticated')
  ) {
    return new Error('Please sign in again, then finish school onboarding before requesting a match.');
  }
  if (lower.includes('own instant pickup') || lower.includes('your own')) {
    return new Error('You cannot request a match on your own pickup post.');
  }
  if (lower.includes('not open')) {
    return new Error('That pickup request is no longer open.');
  }
  if (lower.includes('membership') || lower.includes('join a school') || lower.includes('verified')) {
    return new Error('Join and verify your school profile before requesting a match.');
  }
  if (lower.includes('window has already passed')) {
    return new Error('That pickup window has already passed.');
  }
  return new Error(fallback);
}

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    logPickupError(name, error);
    throw Object.assign(
      friendlyPickupError(error, 'That instant pickup action is not available right now.'),
      { cause: error },
    );
  }
  return data as T;
}

function mapRow(row: InstantPickupRow, userId: string): InstantPickupRequest {
  return {
    id: row.id,
    schoolId: row.school_id,
    requesterId: row.requester_id,
    requesterDisplayName: 'Parent',
    matchedUserId: row.matched_user_id ?? null,
    matchedDisplayName: null,
    intent: row.intent,
    direction: row.direction,
    targetDate: row.target_date,
    areaLabel: row.area_label,
    notes: row.notes,
    status: row.status,
    checkInStatus: row.check_in_status ?? null,
    finalCheckAt: row.final_check_at ?? null,
    pickupAt: null,
    chatRoomId: row.chat_room_id ?? null,
    mine: row.requester_id === userId,
    iAmMatched: row.matched_user_id === userId,
    createdAt: row.created_at,
    schoolSuburb: row.area_label,
  };
}

async function requireSessionUserId(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error) {
    logPickupError('getSession', error);
    throw new Error('Please sign in again, then finish school onboarding before continuing.');
  }
  if (!data.session?.user?.id) {
    console.error('instantPickup.getSession', { reason: 'empty_session' });
    throw new Error('Please sign in again, then finish school onboarding before continuing.');
  }
  if (!data.session.user.email_confirmed_at) {
    throw new Error('Verify your email, then complete your school profile before requesting a match.');
  }
  return data.session.user.id;
}

async function resolveCallerSchoolId(client: SupabaseClient, userId: string): Promise<string | null> {
  const membership = await client
    .from('school_memberships')
    .select('school_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership.error && membership.data?.school_id) {
    return membership.data.school_id as string;
  }

  // Avoid profiles.signup_school_id (Day-15) — missing cols cause console 400s.
  // School comes from school_memberships only (id, school_id, status live there).
  return null;
}

export const instantPickupApi = {
  /**
   * Board list — direct table read (no list RPC).
   * Uses Day-11 columns: intent / direction / area_label / status open|matched|…
   */
  list: async (client: SupabaseClient, includeClosed = false) => {
    const userId = await requireSessionUserId(client);
    let query = client
      .from('instant_pickup_requests')
      .select(
        'id, school_id, requester_id, matched_user_id, intent, direction, target_date, area_label, notes, status, check_in_status, final_check_at, chat_room_id, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(50);

    if (!includeClosed) {
      query = query.or(`status.eq.open,requester_id.eq.${userId}`);
    }

    const { data, error } = await query;
    if (error) {
      logPickupError('list', error);
      throw friendlyPickupError(error, 'That instant pickup action is not available right now.');
    }
    return (data as InstantPickupRow[] | null ?? []).map((row) => mapRow(row, userId));
  },

  /** Post to school board — direct table insert only (never via create RPC). */
  create: async (
    client: SupabaseClient,
    input: {
      intent: ScheduleIntent;
      direction: SchoolRunDirection;
      areaLabel: string;
      targetDate?: string | null;
      notes?: string | null;
    },
  ) => {
    const userId = await requireSessionUserId(client);
    const schoolId = await resolveCallerSchoolId(client, userId);
    if (!schoolId) {
      throw new Error('Join a school before posting an instant pickup request.');
    }

    const payload: Record<string, unknown> = {
      school_id: schoolId,
      requester_id: userId,
      intent: input.intent,
      direction: input.direction,
      area_label: input.areaLabel.trim(),
      notes: input.notes?.trim() || null,
      status: 'open',
    };
    if (input.targetDate) payload.target_date = input.targetDate;

    const { data, error } = await client
      .from('instant_pickup_requests')
      .insert(payload)
      .select(
        'id, school_id, requester_id, matched_user_id, intent, direction, target_date, area_label, notes, status, check_in_status, final_check_at, chat_room_id, created_at',
      )
      .single();

    if (error || !data) {
      console.error('Insert error:', error?.message ?? 'no row returned');
      throw new Error('That request could not be posted. Use a suburb label and keep notes phone-free.');
    }

    return mapRow(data as InstantPickupRow, userId);
  },

  cancel: async (client: SupabaseClient, requestId: string) => {
    await requireSessionUserId(client);
    return rpc<InstantPickupRequest>(client, 'cancel_instant_pickup_request', {
      p_request_id: requestId,
    });
  },
  accept: async (client: SupabaseClient, requestId: string) => {
    await requireSessionUserId(client);
    try {
      return await rpc<InstantPickupAcceptResult>(client, 'accept_instant_pickup_request', {
        p_request_id: requestId,
      });
    } catch (error) {
      logPickupError('accept', error);
      throw friendlyPickupError(
        error,
        'That match request could not be started right now.',
      );
    }
  },
  checkIn: async (client: SupabaseClient, requestId: string, confirm: boolean) => {
    await requireSessionUserId(client);
    return rpc<InstantPickupRequest>(client, 'check_in_instant_pickup', {
      p_request_id: requestId,
      p_confirm: confirm,
    });
  },
  openChat: async (client: SupabaseClient, requestId: string) => {
    await requireSessionUserId(client);
    return rpc<ChatRoom>(client, 'get_instant_pickup_chat', {
      p_request_id: requestId,
    });
  },
  subscribe: (
    client: SupabaseClient,
    schoolId: string,
    onChange: () => void,
  ): RealtimeChannel => {
    const channel = client
      .channel(`instant-pickup:${schoolId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'instant_pickup_requests',
          filter: `school_id=eq.${schoolId}`,
        },
        () => { onChange(); },
      )
      .subscribe();
    return channel;
  },
};
