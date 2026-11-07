import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock('../../server/supabase/request-client.js', () => ({
  createRequestScopedSupabaseClient: () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }),
  RequestAuthenticationError: class RequestAuthenticationError extends Error {},
}));
import { createNotificationsRouter } from '../../server/notifications-router';

const noteId = '91000000-0000-4000-8000-000000000001';
const user = '91000000-0000-4000-8000-000000000002';

describe('Task 10 notifications HTTP boundary (mock JWT; not RLS proof)', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/notifications', createNotificationsRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: user } }, error: null });
  });

  it('lists via list_my_notifications and never echoes forged actor fields', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        id: noteId,
        title: 'Swap accepted',
        body: 'Your swap proposal was accepted.',
        kind: 'swap_accepted',
        is_read: false,
        created_at: '2026-11-07T00:00:00Z',
        phone: 'must-not-echo',
      }],
      error: null,
    });
    const response = await fetch(`${origin}/api/notifications`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.rpc).toHaveBeenCalledWith('list_my_notifications', { p_unread_only: false });
    const body = await response.json();
    expect(body.notifications).toEqual([{
      id: noteId,
      title: 'Swap accepted',
      body: 'Your swap proposal was accepted.',
      kind: 'swap_accepted',
      is_read: false,
      created_at: '2026-11-07T00:00:00Z',
    }]);
  });

  it('marks one notification read through mark_notification_read only', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        id: noteId,
        title: 'Swap accepted',
        body: 'Your swap proposal was accepted.',
        kind: 'swap_accepted',
        is_read: true,
        created_at: '2026-11-07T00:00:00Z',
        read_at: '2026-11-07T01:00:00Z',
      },
      error: null,
    });
    const response = await fetch(`${origin}/api/notifications/${noteId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorId: user, is_read: false }),
    });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('mark_notification_read', { p_notification_id: noteId });
    const body = await response.json();
    expect(body.notification.is_read).toBe(true);
    expect(body.notification).not.toHaveProperty('read_at');
  });

  it('requires authentication before RPC execution', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await fetch(`${origin}/api/notifications`);
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects invalid notification identifiers before RPC execution', async () => {
    const response = await fetch(`${origin}/api/notifications/not-a-uuid/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
