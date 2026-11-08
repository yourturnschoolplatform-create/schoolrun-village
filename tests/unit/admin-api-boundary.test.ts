import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock('../../server/supabase/request-client.js', () => ({
  createRequestScopedSupabaseClient: () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc }),
  RequestAuthenticationError: class RequestAuthenticationError extends Error {},
}));
import { createAdminRouter } from '../../server/admin-router';

const user = 'a1000000-0000-4000-8000-000000000001';
const subject = 'a1000000-0000-4000-8000-000000000002';

describe('Task 10.3 admin HTTP boundary (mock JWT; not RLS proof)', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', createAdminRouter());
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

  it('lists safety holds without inventing admin_email fields', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        id: 'a1000000-0000-4000-8000-000000000099',
        school_id: 'a1000000-0000-4000-8000-000000000010',
        subject_user_id: subject,
        status: 'active',
        reason_code: 'safety_hold',
        placed_at: '2026-11-07T00:00:00Z',
        review_due_at: '2026-11-08T00:00:00Z',
        resolved_at: null,
        admin_email: 'must-not-echo@example.invalid',
      }],
      error: null,
    });
    const response = await fetch(`${origin}/api/admin/safety-holds`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.rpc).toHaveBeenCalledWith('list_admin_safety_holds');
    const body = await response.json();
    expect(body.holds[0]).toEqual({
      id: 'a1000000-0000-4000-8000-000000000099',
      school_id: 'a1000000-0000-4000-8000-000000000010',
      subject_user_id: subject,
      status: 'active',
      reason_code: 'safety_hold',
      placed_at: '2026-11-07T00:00:00Z',
      review_due_at: '2026-11-08T00:00:00Z',
      resolved_at: null,
    });
    expect(body.holds[0]).not.toHaveProperty('admin_email');
  });

  it('suspends with p_reason_code not p_reason', async () => {
    mocks.rpc.mockResolvedValue({
      data: { user_id: subject, admin_suspended: true, outcome: 'suspended' },
      error: null,
    });
    const response = await fetch(`${origin}/api/admin/users/${subject}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasonCode: 'policy_breach', reason: 'ignored free text' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_suspend_user', {
      p_user_id: subject,
      p_reason_code: 'policy_breach',
    });
  });

  it('resolves holds with p_subject_user_id and p_outcome', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        hold_id: 'a1000000-0000-4000-8000-000000000099',
        subject_user_id: subject,
        school_id: 'a1000000-0000-4000-8000-000000000010',
        outcome: 'lifted',
      },
      error: null,
    });
    const response = await fetch(`${origin}/api/admin/users/${subject}/safety-holds/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'lift', reasonCode: 'admin_review' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_resolve_safety_hold', {
      p_subject_user_id: subject,
      p_outcome: 'lift',
      p_reason_code: 'admin_review',
    });
  });

  it('requires authentication before RPC execution', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await fetch(`${origin}/api/admin/suspended-users`);
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
