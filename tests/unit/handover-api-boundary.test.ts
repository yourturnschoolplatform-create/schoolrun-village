import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn(), from: vi.fn() }));
vi.mock('../../server/supabase/request-client.js', () => ({
  createRequestScopedSupabaseClient: () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc, from: mocks.from }),
  RequestAuthenticationError: class RequestAuthenticationError extends Error {},
}));
import { createHandoverRouter } from '../../server/handover-router';

const leg = '81000000-0000-4000-8000-000000000001';
const user = '81000000-0000-4000-8000-000000000002';
describe('Task 5.3 handover HTTP boundary (mock JWT; not RLS proof)', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/api/handover', createHandoverRouter());
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.resetAllMocks(); mocks.getUser.mockResolvedValue({ data: { user: { id: user } }, error: null });
  });
  const post = (path: string, body: unknown = {}) => fetch(`${origin}/api/handover${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  it.each([['pickup', 'confirm_pickup_done'], ['arrival', 'confirm_child_arrived']])(
    'passes only the leg ID for %s, ignoring forged actor school time and completion input', async (path, rpc) => {
      mocks.rpc.mockResolvedValue({ data: { legId: leg, confirmationKind: path === 'pickup' ? 'pickup_done' : 'child_arrived',
        confirmedAt: '2026-11-03T00:00:00Z', completedAt: null, unrelatedField: 'must not echo' }, error: null });
      const response = await post(`/legs/${leg}/${path}`, { actorId: user, schoolId: user, confirmedAt: '2099-01-01', completed: true });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(mocks.rpc).toHaveBeenCalledWith(rpc, { p_leg_id: leg });
      const body = await response.json();
      expect(Object.keys(body.confirmation).sort()).toEqual(['completedAt', 'confirmationKind', 'confirmedAt', 'legId']);
      expect(body.confirmation.completedAt).toBeNull();
    },
  );
  it('rejects invalid leg identifiers before database RPC execution', async () => {
    const response = await post('/legs/not-a-leg/pickup');
    expect(response.status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('requires authenticated identity before RPC execution', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await post(`/legs/${leg}/arrival`);
    expect(response.status).toBe(401); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('suppresses database diagnostics and never labels denied confirmation as completion', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'private diagnostic' } });
    const response = await post(`/legs/${leg}/arrival`);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'handover_unavailable' });
  });
});
