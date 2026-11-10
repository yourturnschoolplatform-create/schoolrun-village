import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { onboardingApi } from '../../src/lib/onboarding-api';

function chain(result: { data: unknown; error: null }) {
  const api: Record<string, unknown> = {};
  const self = new Proxy(api, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve(result);
      }
      return () => self;
    },
  });
  return self;
}

describe('onboardingApi.status (direct Supabase)', () => {
  it('loads status from Supabase tables without calling /api/onboarding/status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const from = vi.fn((table: string) => {
      if (table === 'profiles') {
        return chain({
          data: {
            id: 'user-1',
            display_name: 'Alex',
          },
          error: null,
        });
      }
      if (table === 'school_memberships') return chain({ data: null, error: null });
      if (table === 'consent_acceptances') return chain({ data: [], error: null });
      if (table === 'consent_documents') {
        return chain({
          data: [{ id: 'doc-1', document_type: 'terms', version: 1, title: 'Terms', summary: 'Summary' }],
          error: null,
        });
      }
      if (table === 'child_profiles') return chain({ data: [], error: null });
      if (table === 'safety_declarations') return chain({ data: [], error: null });
      if (table === 'role_assignments') return chain({ data: [], error: null });
      return chain({ data: null, error: null });
    });

    const client = {
      auth: {
        getSession: async () => ({
          data: {
            session: {
              access_token: 'token',
              user: { id: 'user-1', email_confirmed_at: '2026-01-01T00:00:00Z' },
            },
          },
          error: null,
        }),
      },
      from,
    } as unknown as SupabaseClient;

    const status = await onboardingApi.status(client);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(status.emailVerified).toBe(true);
    expect(status.profile?.displayName).toBe('Alex');
    expect(status.profile?.suburb).toBeNull();
    expect(status.membership).toBeNull();
    expect(status.consentDocuments).toHaveLength(1);
    expect(from).toHaveBeenCalledWith('profiles');
    fetchSpy.mockRestore();
  });
});
