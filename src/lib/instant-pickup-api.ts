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

/**
 * SQL contract (db/migrations/0056, 0069, 0070):
 *   accept_instant_pickup_request(p_request_id uuid)
 *   cancel_instant_pickup_request(p_request_id uuid)
 *   check_in_instant_pickup(p_request_id uuid, p_confirm boolean)
 *   get_instant_pickup_chat(p_request_id uuid)
 * PostgREST JSON keys must match those parameter names exactly.
 */
type AcceptRpcArgs = { p_request_id: string };
type CancelRpcArgs = { p_request_id: string };
type CheckInRpcArgs = { p_request_id: string; p_confirm: boolean };
type OpenChatRpcArgs = { p_request_id: string };

type ErrorParts = {
  message: string;
  details: string;
  hint: string;
  code?: string;
  status?: number;
};

function extractErrorParts(error: unknown): ErrorParts {
  const bag = (value: unknown): ErrorParts => {
    if (!value || typeof value !== 'object') {
      return {
        message: typeof value === 'string' ? value : '',
        details: '',
        hint: '',
      };
    }
    const row = value as Record<string, unknown>;
    return {
      message: typeof row.message === 'string' ? row.message : '',
      details: typeof row.details === 'string' ? row.details : '',
      hint: typeof row.hint === 'string' ? row.hint : '',
      code: typeof row.code === 'string' ? row.code : undefined,
      status: typeof row.status === 'number' ? row.status : undefined,
    };
  };

  const primary = bag(error);
  const cause = error instanceof Error && 'cause' in error ? bag(error.cause) : bag(null);
  return {
    message: primary.message || cause.message,
    details: primary.details || cause.details,
    hint: primary.hint || cause.hint,
    code: primary.code || cause.code,
    status: primary.status ?? cause.status,
  };
}

function logPickupError(scope: string, error: unknown, meta?: Record<string, unknown>): void {
  const parts = extractErrorParts(error);
  console.error('Request match detailed error:', error);
  console.error('Request match detailed error:', {
    scope,
    message: parts.message,
    details: parts.details,
    hint: parts.hint,
    code: parts.code,
    status: parts.status,
    ...meta,
  });
}

function friendlyPickupError(error: unknown, fallback: string): Error {
  const parts = extractErrorParts(error);
  const lower = `${parts.message} ${parts.details} ${parts.hint}`.toLowerCase();
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
  if (lower.includes('request unavailable') || lower.includes('requester unavailable')) {
    return new Error('That pickup request is not available for your school right now.');
  }
  if (
    lower.includes('membership')
    || lower.includes('join a school')
    || lower.includes('verified')
    || lower.includes('no verified school')
  ) {
    return new Error('Join and verify your school profile before requesting a match.');
  }
  if (lower.includes('window has already passed')) {
    return new Error('That pickup window has already passed.');
  }
  if (lower.includes('p_request_id is required')) {
    return new Error('That pickup request id is missing. Refresh and try again.');
  }
  // PostgREST param / signature mismatches (PGRST202 / 42883).
  if (
    parts.code === 'PGRST202'
    || parts.code === '42883'
    || lower.includes('could not find the function')
    || lower.includes('function public.accept_instant_pickup')
    || lower.includes('unexpected argument')
  ) {
    return new Error(
      'That match could not be started because the database RPC is out of date. Refresh after migration 0070, then try again.',
    );
  }
  return new Error(fallback);
}

function assertRequestId(requestId: string): string {
  const id = requestId?.trim() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('That pickup request id is invalid.');
  }
  return id;
}

async function rpc<T>(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    logPickupError(name, error, { rpc: name, args });
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
    // Columns are requester_id / matched_user_id — never user_id on this table.
    let query = client
      .from('instant_pickup_requests')
      .select(
        'id, school_id, requester_id, matched_user_id, intent, direction, target_date, area_label, notes, status, check_in_status, final_check_at, chat_room_id, created_at',
      )
      .order('created_at', { ascending: false })
      .limit(50);

    if (!includeClosed) {
      // Open board posts + anything the caller requested or accepted.
      query = query.or(
        `status.eq.open,requester_id.eq.${userId},matched_user_id.eq.${userId}`,
      );
    } else {
      query = query.or(
        `requester_id.eq.${userId},matched_user_id.eq.${userId}`,
      );
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
    const args: CancelRpcArgs = { p_request_id: assertRequestId(requestId) };
    return rpc<InstantPickupRequest>(client, 'cancel_instant_pickup_request', args);
  },
  /**
   * SQL: accept_instant_pickup_request(p_request_id uuid) → { request, chatRoom }
   * Arg key MUST be `p_request_id` (see db/migrations/0070_accept_instant_pickup_rpc_contract.sql).
   */
  accept: async (client: SupabaseClient, requestId: string) => {
    await requireSessionUserId(client);
    const args: AcceptRpcArgs = { p_request_id: assertRequestId(requestId) };
    try {
      // Literal key `p_request_id` — must match the Postgres parameter name exactly.
      const { data, error } = await client.rpc('accept_instant_pickup_request', {
        p_request_id: args.p_request_id,
      });
      if (error) {
        console.error('Request match detailed error:', error);
        console.error('Request match detailed error:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          rpc: 'accept_instant_pickup_request',
          args,
          expectedParams: ['p_request_id'],
        });
        throw Object.assign(
          friendlyPickupError(error, 'That match request could not be started right now.'),
          { cause: error },
        );
      }

      const row = (data ?? {}) as InstantPickupAcceptResult & Record<string, unknown>;
      const chatRoom = (row.chatRoom ?? row.chat_room) as ChatRoom | undefined;
      const request = (row.request ?? row) as InstantPickupRequest;
      if (!chatRoom || !chatRoom.id) {
        console.error('Request match detailed error:', {
          reason: 'missing_chatRoom_in_rpc_payload',
          message: 'RPC returned without chatRoom',
          details: '',
          hint: 'Expected jsonb { request, chatRoom } from accept_instant_pickup_request',
          args,
          data,
        });
        throw new Error('That match request could not be started right now.');
      }
      return { request, chatRoom } satisfies InstantPickupAcceptResult;
    } catch (error) {
      if (!(error instanceof Error && error.cause)) {
        logPickupError('accept', error, {
          rpc: 'accept_instant_pickup_request',
          args,
          expectedParams: ['p_request_id'],
        });
      }
      if (error instanceof Error && error.message.trim()) {
        throw error;
      }
      throw Object.assign(
        friendlyPickupError(error, 'That match request could not be started right now.'),
        { cause: error instanceof Error ? error.cause ?? error : error },
      );
    }
  },
  checkIn: async (client: SupabaseClient, requestId: string, confirm: boolean) => {
    await requireSessionUserId(client);
    const args: CheckInRpcArgs = {
      p_request_id: assertRequestId(requestId),
      p_confirm: confirm,
    };
    return rpc<InstantPickupRequest>(client, 'check_in_instant_pickup', args);
  },
  /**
   * get_instant_pickup_chat(p_request_id) — get or create room for matched parties.
   * Do not require chatRoomId on the client; the RPC heals a missing chat_room_id.
   */
  openChat: async (client: SupabaseClient, requestId: string) => {
    await requireSessionUserId(client);
    const args: OpenChatRpcArgs = { p_request_id: assertRequestId(requestId) };
    try {
      const { data, error } = await client.rpc('get_instant_pickup_chat', {
        p_request_id: args.p_request_id,
      });
      if (error) {
        console.error('Failed to open chat room:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
          rpc: 'get_instant_pickup_chat',
          args,
        });
        throw Object.assign(
          friendlyPickupError(error, 'Could not open chat room due to a permission or network error.'),
          { cause: error },
        );
      }
      const room = data as ChatRoom | null;
      if (!room?.id) {
        console.error('Failed to open chat room:', { reason: 'empty_chat_payload', args, data });
        throw new Error('Chat room is not ready yet.');
      }
      return room;
    } catch (error) {
      if (error instanceof Error && error.message.trim()) throw error;
      console.error('Failed to open chat room:', error);
      throw Object.assign(
        friendlyPickupError(error, 'Could not open chat room due to a permission or network error.'),
        { cause: error },
      );
    }
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
