import { Router, type Request, type Response } from 'express';
import webpush from 'web-push';
import { logSafeServerError } from './safe-error-log.js';
import { createServerOnlyAdminClient } from './admin/service-role.js';
import {
  createRequestScopedSupabaseClient,
  RequestAuthenticationError,
} from './supabase/request-client.js';

class PushInputError extends Error {}

type PushTarget = {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
};

function readVapidConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim()
    || process.env.VITE_VAPID_PUBLIC_KEY?.trim()
    || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || '';
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:support@schoolrunvillage.local';
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PushInputError();
  }
  return value;
}

function safePreview(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const clipped = (text || fallback).slice(0, 120);
  // Keep phone-free: strip long digit runs that look like phone numbers.
  return clipped.replace(/\+?\d[\d\s()-]{7,}\d/g, '•••');
}

function asTargets(raw: unknown): PushTarget[] {
  if (!raw || typeof raw !== 'object') return [];
  const bag = raw as { subscriptions?: unknown };
  return Array.isArray(bag.subscriptions) ? bag.subscriptions as PushTarget[] : [];
}

async function sendToTargets(
  targets: PushTarget[],
  payload: Record<string, unknown>,
): Promise<{ sent: number; gone: string[] }> {
  const vapid = readVapidConfig();
  if (!vapid) return { sent: 0, gone: [] };

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const body = JSON.stringify(payload);
  let sent = 0;
  const gone: string[] = [];

  await Promise.all(targets.map(async (target) => {
    if (
      typeof target.endpoint !== 'string'
      || typeof target.p256dh !== 'string'
      || typeof target.auth !== 'string'
    ) return;
    try {
      await webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        body,
        { TTL: 60 * 60 },
      );
      sent += 1;
    } catch (error) {
      const status = typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
      if (status === 404 || status === 410) gone.push(target.endpoint);
    }
  }));

  return { sent, gone };
}

function reject(response: Response, error: unknown): void {
  if (error instanceof RequestAuthenticationError) {
    response.status(401).json({ error: 'authentication_required' });
  } else if (error instanceof PushInputError) {
    response.status(400).json({ error: 'invalid_push_input' });
  } else {
    logSafeServerError('push', error);
    response.status(503).json({ error: 'push_unavailable' });
  }
}

export function createPushRouter(): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get('/vapid-public-key', (_request, response) => {
    const vapid = readVapidConfig();
    response.status(200).json({
      publicKey: vapid?.publicKey ?? null,
      configured: Boolean(vapid),
    });
  });

  router.post('/notify-chat', async (request, response) => {
    try {
      const client = createRequestScopedSupabaseClient(request);
      const roomId = uuid(request.body?.roomId);
      const preview = safePreview(request.body?.preview, 'New message');
      const result = await client.rpc('list_push_targets_for_chat_peer', { p_room_id: roomId });
      if (result.error) throw new Error('unavailable');
      const targets = asTargets(result.data);
      const title = typeof request.body?.title === 'string' && request.body.title.trim()
        ? request.body.title.trim().slice(0, 80)
        : 'New message';
      const context = typeof request.body?.context === 'string'
        ? request.body.context.trim().slice(0, 80)
        : null;
      const { sent, gone } = await sendToTargets(targets, {
        title,
        body: preview,
        roomId,
        kind: 'chat',
        context,
        url: `/?view=messages&openChat=${roomId}`,
      });
      if (gone.length > 0) {
        try {
          const admin = createServerOnlyAdminClient();
          await admin.from('push_subscriptions').delete().in('endpoint', gone);
        } catch {
          /* best-effort cleanup */
        }
      }
      response.status(200).json({ ok: true, sent, cleaned: gone.length });
    } catch (error) {
      reject(response, error);
    }
  });

  router.post('/notify-match', async (request, response) => {
    try {
      const client = createRequestScopedSupabaseClient(request);
      const requestId = uuid(request.body?.requestId);
      const roomId = typeof request.body?.roomId === 'string' && request.body.roomId
        ? uuid(request.body.roomId)
        : null;
      const result = await client.rpc('list_push_targets_for_pickup_peer', {
        p_request_id: requestId,
      });
      if (result.error) throw new Error('unavailable');
      const bag = (result.data ?? {}) as { chatRoomId?: unknown; subscriptions?: unknown };
      const targets = asTargets(result.data);
      const openRoom = roomId
        || (typeof bag.chatRoomId === 'string' ? bag.chatRoomId : null);
      const { sent, gone } = await sendToTargets(targets, {
        title: 'Pickup match',
        body: 'Your instant pickup was matched. Open chat when ready.',
        roomId: openRoom,
        requestId,
        kind: 'match',
        context: 'Instant Pickup',
        url: openRoom
          ? `/?view=messages&openChat=${openRoom}&chatKind=match`
          : '/?view=messages',
      });
      if (gone.length > 0) {
        try {
          const admin = createServerOnlyAdminClient();
          await admin.from('push_subscriptions').delete().in('endpoint', gone);
        } catch {
          /* best-effort cleanup */
        }
      }
      response.status(200).json({ ok: true, sent, cleaned: gone.length });
    } catch (error) {
      reject(response, error);
    }
  });

  return router;
}

export function readPublicVapidKey(): string | null {
  return readVapidConfig()?.publicKey ?? null;
}
