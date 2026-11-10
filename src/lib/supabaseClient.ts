import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  fallbackRuntimeConfig,
  type BrowserRuntimeConfig,
} from './runtime-config';

let browserClient: SupabaseClient | null = null;
let browserClientKey: string | null = null;

function clientKeyFor(config: BrowserRuntimeConfig): string | null {
  if (!config.supabase?.url || !config.supabase.anonKey) return null;
  return `${config.supabase.url.trim()}|${config.supabase.anonKey.trim()}`;
}

/**
 * Single browser GoTrue/Supabase client for the SPA.
 * Reuses the same instance whenever URL + anon key are unchanged so
 * detectSessionInUrl / onAuthStateChange cannot race across duplicates.
 */
export function getSupabaseBrowserClient(
  config: BrowserRuntimeConfig = fallbackRuntimeConfig,
): SupabaseClient | null {
  const nextKey = clientKeyFor(config);
  if (!nextKey || !config.supabase) {
    return browserClient;
  }

  if (browserClient && browserClientKey === nextKey) {
    return browserClient;
  }

  // Credentials changed (rare) — replace the singleton.
  browserClient = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  });
  browserClientKey = nextKey;
  return browserClient;
}

/** @deprecated Prefer getSupabaseBrowserClient — kept as alias for older imports. */
export function createBrowserSupabaseClient(
  config: BrowserRuntimeConfig,
): SupabaseClient | null {
  return getSupabaseBrowserClient(config);
}

/** Env-backed singleton (may be null until public config / env is present). */
export const supabase: SupabaseClient | null = getSupabaseBrowserClient(fallbackRuntimeConfig);
