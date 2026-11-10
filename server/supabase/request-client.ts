import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request } from 'express';
import { readPublicSupabaseConfig } from '../config.js';

export class RequestAuthenticationError extends Error {
  constructor() {
    super('A signed-in Supabase user token is required.');
    this.name = 'RequestAuthenticationError';
  }
}

export function bearerTokenFrom(request: Request): string {
  const header = request.header('authorization');
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new RequestAuthenticationError();
  return match[1];
}

/**
 * Do not replace this client with a service-role client. Its bearer token is the
 * visitor JWT, so all database access in the request remains subject to Supabase RLS.
 */
export class PublicConfigUnavailableError extends Error {
  constructor() {
    super('Public Supabase configuration is unavailable.');
    this.name = 'PublicConfigUnavailableError';
  }
}

export function createRequestScopedSupabaseClient(request: Request): SupabaseClient {
  // Prefer 401 for missing bearer over 500 from missing server env during SPA boot probes.
  const accessToken = bearerTokenFrom(request);
  let url: string;
  let anonKey: string;
  try {
    ({ url, anonKey } = readPublicSupabaseConfig());
  } catch (error) {
    console.error('request-scoped supabase config missing', {
      name: error instanceof Error ? error.name : 'Error',
    });
    throw new PublicConfigUnavailableError();
  }

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

export async function loadVerifiedSchoolScope(request: Request) {
  const client = createRequestScopedSupabaseClient(request);
  const { data, error } = await client
    .from('school_memberships')
    .select('school_id, status')
    .eq('status', 'verified');

  if (error) throw error;
  return data;
}
