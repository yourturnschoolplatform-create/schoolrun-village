import { Router, type Request, type Response } from 'express';
import { logSafeServerError } from './safe-error-log.js';
import { createServerOnlyAdminClient } from './admin/service-role.js';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

class AdminInputError extends Error {}
class AdminSecretError extends Error {}

const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AdminInputError();
  }
  return value;
};

const reasonCode = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{2,60}$/.test(value)) {
    throw new AdminInputError();
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
  if (error instanceof RequestAuthenticationError) {
    response.status(401).json({ error: 'authentication_required' });
  } else if (error instanceof AdminInputError) {
    response.status(400).json({ error: 'invalid_admin_input' });
  } else {
    logSafeServerError('admin', error);
    response.status(403).json({ error: 'admin_action_unavailable' });
  }
}

function asRows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

function readAdminSecret(): string {
  return (
    process.env.ADMIN_SECRET_KEY?.trim()
    || process.env.YOURTURN_ADMIN_SECRET_KEY?.trim()
    || ''
  );
}

export function createAdminRouter(): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  /** Dual-signup admin registration — secured by ADMIN_SECRET_KEY. */
  router.post('/signup', async (request, response) => {
    try {
      const expected = readAdminSecret();
      if (!expected) throw new AdminSecretError();
      const provided = typeof request.body?.adminSecret === 'string' ? request.body.adminSecret.trim() : '';
      if (!provided || provided !== expected) throw new AdminSecretError();

      const email = typeof request.body?.email === 'string' ? request.body.email.trim() : '';
      const password = typeof request.body?.password === 'string' ? request.body.password : '';
      const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim() : '';
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || displayName.length < 2) {
        throw new AdminInputError();
      }

      const admin = createServerOnlyAdminClient();
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName, account_role: 'admin' },
      });
      if (created.error || !created.data.user) throw created.error ?? new Error('create_failed');

      const userId = created.data.user.id;
      await admin.from('profiles').upsert({
        id: userId,
        display_name: displayName.slice(0, 80),
        account_status: 'verified',
        account_role: 'admin',
        account_verified_at: new Date().toISOString(),
      });
      await admin.rpc('mark_admin_account_verified', { p_user_id: userId });
      await admin.from('role_assignments').upsert({
        user_id: userId,
        role: 'admin',
        school_id: null,
        granted_at: new Date().toISOString(),
      }, { onConflict: 'user_id', ignoreDuplicates: true }).select();

      // Ensure an active admin assignment even if upsert conflict target differs.
      const existing = await admin
        .from('role_assignments')
        .select('id')
        .eq('user_id', userId)
        .eq('role', 'admin')
        .is('revoked_at', null)
        .maybeSingle();
      if (!existing.data) {
        await admin.from('role_assignments').insert({
          user_id: userId,
          role: 'admin',
          school_id: null,
        });
      }

      response.status(201).json({
        ok: true,
        message: 'Admin account created. Sign in at the home page to open the Admin Dashboard.',
      });
    } catch (error) {
      if (error instanceof AdminSecretError) {
        response.status(403).json({ error: 'invalid_admin_secret' });
      } else if (error instanceof AdminInputError) {
        response.status(400).json({ error: 'invalid_admin_input' });
      } else {
        logSafeServerError('admin-signup', error);
        response.status(400).json({ error: 'admin_signup_unavailable' });
      }
    }
  });

  router.get('/users/pending-verifications', async (request, response) => {
    try {
      const client = await context(request);
      const schoolId = typeof request.query.schoolId === 'string' && request.query.schoolId.trim()
        ? request.query.schoolId.trim()
        : null;
      const result = await client.rpc('list_pending_account_verifications', { p_school_id: schoolId });
      if (result.error) throw new Error('unavailable');
      const rows = Array.isArray(result.data) ? result.data : [];
      response.json({ users: rows });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/users/:userId/verify', async (request, response) => {
    try {
      const client = await context(request);
      const userId = identifier(request.params.userId);
      const decision = request.body?.decision === 'reject' ? 'reject' : request.body?.decision === 'approve' ? 'approve' : null;
      if (!decision) throw new AdminInputError();
      const result = await client.rpc('verify_account_user', {
        p_user_id: userId,
        p_decision: decision,
      });
      if (result.error) throw new Error('unavailable');
      response.json({ result: result.data });
    } catch (error) {
      reject(response, error);
    }
  });

  router.get('/audit-actions', async (request, response) => {
    try {
      const client = await context(request);
      const limitRaw = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
      const result = await client.rpc('list_admin_audit_actions', { p_limit: limit });
      if (result.error) throw new Error('unavailable');
      response.json({
        actions: asRows(result.data).map((row) => ({
          id: row.id,
          actor_id: row.actor_id,
          school_id: row.school_id ?? null,
          action: row.action,
          entity_type: row.entity_type,
          entity_id: row.entity_id ?? null,
          occurred_at: row.occurred_at,
          payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
        })),
      });
    } catch (error) {
      reject(response, error);
    }
  });

  router.get('/safety-holds', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.rpc('list_admin_safety_holds');
      if (result.error) throw new Error('unavailable');
      response.json({
        holds: asRows(result.data).map((row) => ({
          id: row.id,
          school_id: row.school_id,
          subject_user_id: row.subject_user_id,
          status: row.status,
          reason_code: row.reason_code,
          placed_at: row.placed_at,
          review_due_at: row.review_due_at ?? null,
          resolved_at: row.resolved_at ?? null,
        })),
      });
    } catch (error) {
      reject(response, error);
    }
  });

  router.get('/suspended-users', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.rpc('list_admin_suspended_users');
      if (result.error) throw new Error('unavailable');
      response.json({
        users: asRows(result.data).map((row) => ({
          user_id: row.user_id,
          admin_suspended: row.admin_suspended === true,
          updated_at: row.updated_at,
        })),
      });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/users/:userId/suspend', async (request, response) => {
    try {
      const client = await context(request);
      const userId = identifier(request.params.userId);
      const code = reasonCode(request.body?.reasonCode);
      const result = await client.rpc('admin_suspend_user', {
        p_user_id: userId,
        p_reason_code: code,
      });
      if (result.error) throw new Error('unavailable');
      response.json({ result: result.data });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/users/:userId/unsuspend', async (request, response) => {
    try {
      const client = await context(request);
      const userId = identifier(request.params.userId);
      const code = reasonCode(request.body?.reasonCode);
      const result = await client.rpc('admin_unsuspend_user', {
        p_user_id: userId,
        p_reason_code: code,
      });
      if (result.error) throw new Error('unavailable');
      response.json({ result: result.data });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/users/:userId/safety-holds/resolve', async (request, response) => {
    try {
      const client = await context(request);
      const userId = identifier(request.params.userId);
      const outcome = request.body?.outcome;
      if (outcome !== 'lift' && outcome !== 'uphold') throw new AdminInputError();
      const code = reasonCode(request.body?.reasonCode ?? 'admin_review');
      const result = await client.rpc('admin_resolve_safety_hold', {
        p_subject_user_id: userId,
        p_outcome: outcome,
        p_reason_code: code,
      });
      if (result.error) throw new Error('unavailable');
      response.json({ result: result.data });
    } catch (error) {
      reject(response, error);
    }
  });

  return router;
}
