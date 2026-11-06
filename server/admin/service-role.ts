import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isServerOnlySupabaseKey, normaliseSupabaseKey } from '../config.js';

/**
 * Server-only administrative client. This module must never be imported by src/.
 * Permitted callers: bootstrap, scheduled jobs, and notification sending modules.
 */
export function createServerOnlyAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = normaliseSupabaseKey(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '');

  if (!url || !/^https:\/\//.test(url)) {
    throw new Error('SUPABASE_URL must be configured for server administration.');
  }
  if (!serviceRoleKey || !isServerOnlySupabaseKey(serviceRoleKey)) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a legacy service-role JWT or sb_secret_ key.');
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
