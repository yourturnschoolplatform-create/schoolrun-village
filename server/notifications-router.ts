import { Router, type Request, type Response } from 'express';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

class NotificationInputError extends Error {}

const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new NotificationInputError();
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
  } else if (error instanceof NotificationInputError) {
    response.status(400).json({ error: 'invalid_notification_input' });
  } else {
    response.status(403).json({ error: 'notification_action_unavailable' });
  }
}

type NotificationRow = {
  id?: unknown;
  title?: unknown;
  body?: unknown;
  kind?: unknown;
  is_read?: unknown;
  created_at?: unknown;
};

function project(row: NotificationRow) {
  if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.body !== 'string'
    || typeof row.kind !== 'string' || typeof row.is_read !== 'boolean'
    || typeof row.created_at !== 'string') {
    throw new Error('unavailable');
  }
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    is_read: row.is_read,
    created_at: row.created_at,
  };
}

export function createNotificationsRouter(): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/', async (request, response) => {
    try {
      const client = await context(request);
      const unreadOnly = request.query.unreadOnly === 'true';
      const result = await client.rpc('list_my_notifications', { p_unread_only: unreadOnly });
      if (result.error) throw new Error('unavailable');
      const rows = Array.isArray(result.data) ? result.data as NotificationRow[] : [];
      response.json({ notifications: rows.map(project) });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/:notificationId/read', async (request, response) => {
    try {
      const client = await context(request);
      const notificationId = identifier(request.params.notificationId);
      const result = await client.rpc('mark_notification_read', { p_notification_id: notificationId });
      if (result.error) throw new Error('unavailable');
      response.json({ notification: project((result.data ?? {}) as NotificationRow) });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/read-all', async (request, response) => {
    try {
      const client = await context(request);
      const result = await client.rpc('mark_all_notifications_read');
      if (result.error) throw new Error('unavailable');
      const payload = (result.data ?? {}) as { outcome?: unknown; marked_count?: unknown };
      response.json({
        outcome: payload.outcome === 'marked_read' ? 'marked_read' : 'marked_read',
        markedCount: typeof payload.marked_count === 'number' ? payload.marked_count : 0,
      });
    } catch (error) {
      reject(response, error);
    }
  });

  return router;
}
