import { Router, type Request, type Response } from 'express';
import { logSafeServerError } from './safe-error-log.js';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

class HandoverInputError extends Error {}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HandoverInputError();
  }
  return value;
};
async function context(request: Request) {
  const client = createRequestScopedSupabaseClient(request);
  const result = await client.auth.getUser();
  if (result.error || !result.data.user) throw new RequestAuthenticationError();
  return { client, userId: result.data.user.id };
}
function reject(response: Response, error: unknown) {
  if (error instanceof RequestAuthenticationError) response.status(401).json({ error: 'authentication_required' });
  else if (error instanceof HandoverInputError) response.status(400).json({ error: 'invalid_handover_input' });
  else {
    logSafeServerError('handover', error);
    response.status(403).json({ error: 'handover_unavailable' });
  }
}
export function createHandoverRouter(): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });
  router.get('/swaps/:swapId', async (request, response) => {
    try {
      const { client, userId } = await context(request);
      const swapId = identifier(request.params.swapId);
      const source = await client.from('swap_proposals').select('id,school_id,status,proposer_id,recipient_id')
        .eq('id', swapId).maybeSingle();
      if (source.error || !source.data || ![source.data.proposer_id, source.data.recipient_id].includes(userId)) {
        throw new Error('unavailable');
      }
      const refreshed = await client.rpc('refresh_my_handover_reminders');
      if (refreshed.error) throw new Error('unavailable');
      const result = await client.from('swap_legs')
        .select('id,service_date,expected_arrival_at,completed_at,helper_id,requester_id')
        .eq('swap_id', swapId).eq('school_id', source.data.school_id).order('service_date').order('id');
      if (result.error) throw new Error('unavailable');
      const ids = (result.data ?? []).map((leg) => leg.id);
      const [confirmations, reminders, school] = await Promise.all([
        ids.length ? client.from('swap_leg_confirmations').select('swap_leg_id,confirmation_kind,confirmed_at')
          .in('swap_leg_id', ids).eq('school_id', source.data.school_id) : Promise.resolve({ data: [], error: null }),
        ids.length ? client.from('swap_leg_reminders').select('swap_leg_id,missing_confirmation,due_at,created_at')
          .in('swap_leg_id', ids).eq('school_id', source.data.school_id) : Promise.resolve({ data: [], error: null }),
        client.from('schools').select('timezone').eq('id', source.data.school_id).maybeSingle(),
      ]);
      if (confirmations.error || reminders.error || school.error || !school.data) throw new Error('unavailable');
      response.json({ timeZone: school.data.timezone, legs: (result.data ?? []).map((leg) => {
        const reminder = (reminders.data ?? []).find((row) => row.swap_leg_id === leg.id);
        return {
          id: leg.id, serviceDate: leg.service_date, expectedArrivalAt: leg.expected_arrival_at,
          completedAt: leg.completed_at, isProvider: leg.helper_id === userId, isRecipient: leg.requester_id === userId,
          confirmations: (confirmations.data ?? []).filter((row) => row.swap_leg_id === leg.id)
            .map((row) => ({ kind: row.confirmation_kind, confirmedAt: row.confirmed_at })),
          reminder: reminder ? { missingConfirmation: reminder.missing_confirmation, dueAt: reminder.due_at,
            createdAt: reminder.created_at, resolved: leg.completed_at !== null || source.data!.status !== 'accepted' } : null,
        };
      }) });
    } catch (error) { reject(response, error); }
  });
  for (const [path, rpc] of [['pickup', 'confirm_pickup_done'], ['arrival', 'confirm_child_arrived']] as const) {
    router.post(`/legs/:legId/${path}`, async (request, response) => {
      try {
        const { client } = await context(request);
        const result = await client.rpc(rpc, { p_leg_id: identifier(request.params.legId) });
        if (result.error || !result.data) throw new Error('unavailable');
        const value = result.data as Record<string, unknown>;
        response.json({ confirmation: {
          legId: value.legId, confirmationKind: value.confirmationKind,
          confirmedAt: value.confirmedAt, completedAt: value.completedAt,
        } });
      } catch (error) { reject(response, error); }
    });
  }
  return router;
}
