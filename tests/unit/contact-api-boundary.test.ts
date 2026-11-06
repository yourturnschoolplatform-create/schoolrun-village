import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn(), from: vi.fn() }));
vi.mock('../../server/supabase/request-client.js', () => ({
  createRequestScopedSupabaseClient: () => ({ auth: { getUser: mocks.getUser }, rpc: mocks.rpc, from: mocks.from }),
  RequestAuthenticationError: class RequestAuthenticationError extends Error {},
}));
import { createContactsRouter } from '../../server/contacts-router';

const swap = '71000000-0000-4000-8000-000000000001';
const member = '71000000-0000-4000-8000-000000000002';
const fakeMobile = ['+61', '400', '000', '000'].join('');

describe('Task 5.2 contact HTTP response boundary (mock JWT client; not RLS proof)', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/contacts', createContactsRouter());
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: member } }, error: null });
  });
  const post = (path: string, body?: unknown) => fetch(`${origin}/api/contacts${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });

  it('whitelists grant metadata and never echoes a mobile even if an RPC adds extra fields', async () => {
    mocks.rpc.mockResolvedValue({ error: null, data: {
      id: member, consentVersion: 2, policyVersion: 1, scope: 'swap_partner_and_chosen_backups',
      grantedAt: '2026-11-02T00:00:00Z', defaultContactMethod: 'email_relay', mobile_number: fakeMobile,
    } });
    const response = await post(`/swaps/${swap}/grant`, { mobileNumber: fakeMobile, chosenBackups: [] });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(JSON.stringify(body).includes(fakeMobile)).toBe(false);
    expect(Object.keys(body.consent).sort()).toEqual(['consentVersion', 'defaultContactMethod', 'grantedAt', 'id', 'policyVersion', 'scope']);
    expect(mocks.rpc).toHaveBeenCalledWith('grant_contact_sharing', { p_swap_id: swap, p_mobile_number: fakeMobile, p_chosen_backups: [] });
  });

  it('returns null for a denied getter without response-body diagnostics', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const response = await fetch(`${origin}/api/contacts/swaps/${swap}/shared/${member}`);
    expect(await response.json()).toEqual({ mobileNumber: null });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('permits a number only in the dedicated shared-contact response field', async () => {
    mocks.rpc.mockResolvedValue({ data: fakeMobile, error: null });
    const response = await fetch(`${origin}/api/contacts/swaps/${swap}/shared/${member}`);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['mobileNumber']);
    expect(body.mobileNumber === fakeMobile).toBe(true);
  });

  it('redacts underlying driver errors rather than logging or returning submitted contact data', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mocks.rpc.mockResolvedValue({ data: null, error: { message: fakeMobile, details: fakeMobile } });
      const response = await post(`/swaps/${swap}/revoke`);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body.includes(fakeMobile)).toBe(false);
      expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });

  it('renders a fixed phone-free notification DTO even if an upstream message contains a number', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ id: member, swap_id: swap, kind: 'contact_consent_revoked',
      message: fakeMobile, created_at: '2026-11-02T00:00:00Z', mobile_number: fakeMobile }], error: null });
    mocks.from.mockReturnValue({ select: () => ({ order: () => ({ limit }) }) });
    const response = await fetch(`${origin}/api/contacts/notifications`);
    const body = await response.json();
    expect(JSON.stringify(body).includes(fakeMobile)).toBe(false);
    expect(body.notifications[0].message).toBe('Contact sharing was withdrawn. This swap has ended.');
    expect(mocks.from).toHaveBeenCalledWith('swap_contact_notifications');
  });

  it('requires a valid session before invoking a contact RPC', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const response = await post(`/swaps/${swap}/revoke`);
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('passes only the swap identifier to withdrawal and preserves its exact terminal state', async () => {
    mocks.rpc.mockResolvedValue({ data: 'cancelled_consent_revoked', error: null });
    const response = await post(`/swaps/${swap}/revoke`, { userId: member });
    expect(await response.json()).toEqual({ status: 'cancelled_consent_revoked' });
    expect(mocks.rpc).toHaveBeenCalledWith('revoke_contact_sharing', { p_swap_id: swap });
  });
});
