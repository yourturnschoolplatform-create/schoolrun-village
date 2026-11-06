import { Router, type Request, type Response } from 'express';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

class ContactInputError extends Error {}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ContactInputError();
  }
  return value;
};
async function context(request: Request) {
  const client = createRequestScopedSupabaseClient(request);
  const result = await client.auth.getUser();
  if (result.error || !result.data.user) throw new RequestAuthenticationError();
  return client;
}
function reject(response: Response, error: unknown) {
  // Never echo or log a driver error, request body, number or underlying detail.
  if (error instanceof RequestAuthenticationError) {
    response.status(401).json({ error: 'authentication_required' });
  } else if (error instanceof ContactInputError) {
    response.status(400).json({ error: 'invalid_contact_input' });
  } else {
    response.status(403).json({ error: 'contact_action_unavailable' });
  }
}

export function createContactsRouter(): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });
  router.post('/swaps/:swapId/grant', async (request, response) => {
    try {
      const client = await context(request);
      const swapId = identifier(request.params.swapId);
      const mobile = request.body?.mobileNumber;
      const backups: unknown = request.body?.chosenBackups ?? [];
      if (typeof mobile !== 'string' || !/^\+614\d{8}$/.test(mobile)
        || !Array.isArray(backups) || backups.length > 2) throw new ContactInputError();
      const chosen = backups.map(identifier);
      const result = await client.rpc('grant_contact_sharing', {
        p_swap_id: swapId, p_mobile_number: mobile, p_chosen_backups: chosen,
      });
      if (result.error) throw new ContactInputError();
      // The SQL return shape is metadata only; never return the input mobile.
      const consent = result.data as Record<string, unknown>;
      response.status(201).json({ consent: {
        id: consent.id, consentVersion: consent.consentVersion,
        policyVersion: consent.policyVersion, scope: consent.scope,
        grantedAt: consent.grantedAt, defaultContactMethod: 'email_relay',
      } });
    } catch (error) { reject(response, error); }
  });
  router.post('/swaps/:swapId/revoke', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.rpc('revoke_contact_sharing', { p_swap_id: identifier(request.params.swapId) });
      if (result.error) throw new Error('unavailable');
      response.json({ status: result.data });
    } catch (error) { reject(response, error); }
  });
  router.get('/swaps/:swapId/shared/:memberId', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.rpc('get_shared_contact', {
        p_swap_id: identifier(request.params.swapId), p_member: identifier(request.params.memberId),
      });
      if (result.error) throw new Error('unavailable');
      response.json({ mobileNumber: typeof result.data === 'string' && /^\+614\d{8}$/.test(result.data) ? result.data : null });
    } catch (error) { reject(response, error); }
  });
  router.get('/notifications', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.from('swap_contact_notifications')
        .select('id,swap_id,kind,message,created_at').order('created_at', { ascending: false }).limit(50);
      if (result.error) throw new Error('unavailable');
      response.json({ notifications: (result.data ?? []).map((notification) => ({
        id: notification.id, swap_id: notification.swap_id, kind: 'contact_consent_revoked',
        message: 'Contact sharing was withdrawn. This swap has ended.', created_at: notification.created_at,
      })) });
    } catch (error) { reject(response, error); }
  });
  return router;
}
