import { Router, type Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { handleOnboardingStatus } from './api/onboarding/status.js';
import { databaseErrorCode } from './safe-error-log.js';
import { createPublicSupabaseClient } from './supabase/public-client.js';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

export class OnboardingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingInputError';
  }
}

type SignedInContext = {
  user: User;
  client: ReturnType<typeof createRequestScopedSupabaseClient>;
};

function stringField(value: unknown, field: string, min = 1, max = 160): string {
  if (typeof value !== 'string') throw new OnboardingInputError(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new OnboardingInputError(`${field} is invalid.`);
  return trimmed;
}

function uuidField(value: unknown, field: string): string {
  const parsed = stringField(value, field, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new OnboardingInputError(`${field} is invalid.`);
  }
  return parsed;
}

function smallInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new OnboardingInputError(`${field} is invalid.`);
  }
  return value;
}

async function signedInContext(request: Request): Promise<SignedInContext> {
  const client = createRequestScopedSupabaseClient(request);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new RequestAuthenticationError();
  return { client, user: data.user };
}

async function requireVerifiedEmail(context: SignedInContext): Promise<void> {
  if (!context.user.email_confirmed_at) {
    throw new RequestAuthenticationError();
  }
}

function rpcData<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw result.error;
  if (result.data === null) throw new Error('Expected onboarding RPC response was empty.');
  return result.data;
}

function rpcVoid(result: { error: { message: string } | null }): void {
  if (result.error) throw result.error;
}

export function createOnboardingRouter(): Router {
  const router = Router();

  // all(): GET returns status; other methods get 405 from the handler (not a Vite/SPA 404).
  router.all('/status', handleOnboardingStatus);

  router.get('/consent-documents', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      await requireVerifiedEmail(context);
      const { data, error } = await context.client
        .from('consent_documents')
        .select('id, document_type, version, title, summary')
        .eq('is_active', true)
        .order('document_type');
      if (error) throw error;
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.json({ documents: data });
    } catch (error) {
      next(error);
    }
  });

  router.post('/consents', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      await requireVerifiedEmail(context);
      const documentType = stringField(request.body?.documentType, 'documentType', 3, 32);
      const version = smallInteger(request.body?.version, 'version', 1, 10_000);
      rpcVoid(await context.client.rpc('accept_current_consent', { p_document_type: documentType, p_version: version }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/school-options', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      await requireVerifiedEmail(context);
      const options = rpcData(await context.client.rpc('list_onboarding_school_options'));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.json({ schools: options });
    } catch (error) {
      next(error);
    }
  });

  router.post('/school-membership', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      await requireVerifiedEmail(context);
      const schoolId = uuidField(request.body?.schoolId, 'schoolId');
      const inviteCode = stringField(request.body?.inviteCode, 'inviteCode', 6, 128);
      const status = rpcData(await context.client.rpc('redeem_school_invite_code', { p_school_id: schoolId, p_code: inviteCode }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      if (status !== 'pending' && status !== 'already_verified') {
        response.status(400).json({ status: 'invalid' });
        return;
      }
      response.status(201).json({ status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/profile', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const displayName = stringField(request.body?.displayName, 'displayName', 2, 80);
      rpcVoid(await context.client.rpc('update_onboarding_parent_profile', { p_display_name: displayName }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/children', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const membershipId = uuidField(request.body?.membershipId, 'membershipId');
      const nickname = stringField(request.body?.nickname, 'nickname', 1, 32);
      const yearLevel = smallInteger(request.body?.yearLevel, 'yearLevel', 0, 12);
      const childId = rpcData(await context.client.rpc('add_onboarding_child', {
        p_membership_id: membershipId,
        p_nickname: nickname,
        p_year_level: yearLevel,
      }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ childId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/safety-declaration', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const membershipId = uuidField(request.body?.membershipId, 'membershipId');
      const declarationVersionId = uuidField(request.body?.declarationVersionId, 'declarationVersionId');
      const status = rpcData(await context.client.rpc('sign_onboarding_safety_declaration', {
        p_membership_id: membershipId,
        p_declaration_version_id: declarationVersionId,
      }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/invitations/open', async (request, response) => {
    try {
      const token = stringField(request.body?.token, 'invitation token', 24, 256);
      // Day 4 revoked anon EXECUTE on open_school_invitation; prefer the caller JWT
      // when present so signed-in invite opens work. Unsigned calls still use anon.
      const authorization = request.header('Authorization');
      const client = authorization?.startsWith('Bearer ')
        ? createRequestScopedSupabaseClient(request)
        : createPublicSupabaseClient();
      const status = rpcData(await client.rpc('open_school_invitation', { p_token: token }));
      // Deliberately generic: no school name, ID, config, roster or inviter data.
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.json({ status });
    } catch {
      // Missing token row or EXECUTE denial → treat as unavailable (no school leak).
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(200).json({ status: 'unavailable' });
    }
  });

  router.post('/invitations/claim', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      await requireVerifiedEmail(context);
      const token = stringField(request.body?.token, 'invitation token', 24, 256);
      const status = rpcData(await context.client.rpc('claim_school_invitation', { p_token: token }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ status });
    } catch (error) {
      // Missing/expired/revoked/already-used invite → P0002 from claim_school_invitation.
      if (databaseErrorCode(error) === 'P0002') {
        response.setHeader('Cache-Control', 'no-store, max-age=0');
        response.status(404).json({ error: 'invitation_unavailable' });
        return;
      }
      next(error);
    }
  });

  router.get('/moderation/pending-memberships', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const memberships = rpcData(await context.client.rpc('list_pending_school_memberships'));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.json({ memberships });
    } catch (error) {
      next(error);
    }
  });

  router.post('/moderation/invitations', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const schoolId = uuidField(request.body?.schoolId, 'schoolId');
      const invitations = rpcData(await context.client.rpc('create_school_invitation', { p_school_id: schoolId }));
      const invitation = Array.isArray(invitations) ? invitations[0] : null;
      if (!invitation || typeof invitation.invitation_token !== 'string') throw new Error('Invitation creation returned no token.');
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ token: invitation.invitation_token });
    } catch (error) {
      next(error);
    }
  });

  router.post('/moderation/memberships/:membershipId/approve', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const membershipId = uuidField(request.params.membershipId, 'membershipId');
      const status = rpcData(await context.client.rpc('approve_school_membership', { p_membership_id: membershipId }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/moderation/memberships/:membershipId/review', async (request, response, next) => {
    try {
      const context = await signedInContext(request);
      const membershipId = uuidField(request.params.membershipId, 'membershipId');
      const state = stringField(request.body?.state, 'state', 8, 10);
      if (state !== 'rejected' && state !== 'suspended') throw new OnboardingInputError('state is invalid.');
      const status = rpcData(await context.client.rpc('set_school_membership_review_state', { p_membership_id: membershipId, p_state: state }));
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.status(201).json({ status });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
