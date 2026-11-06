import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readPublicSupabaseConfig } from '../config.js';

/**
 * Anonymous client for the one safe public action: opening an opaque invitation
 * token. It may call no direct table query and receives no school data.
 */
export function createPublicSupabaseClient(): SupabaseClient {
  const { url, anonKey } = readPublicSupabaseConfig();
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}
