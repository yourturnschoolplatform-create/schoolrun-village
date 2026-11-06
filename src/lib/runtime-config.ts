import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import appConfig from '../../app.config';

export type BrowserRuntimeConfig = {
  appName: string;
  supabase: {
    url: string;
    anonKey: string;
  } | null;
};

export const fallbackRuntimeConfig: BrowserRuntimeConfig = {
  appName: appConfig.appName,
  supabase: null,
};

export async function fetchRuntimeConfig(): Promise<BrowserRuntimeConfig> {
  const response = await fetch('/api/public-config', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) return fallbackRuntimeConfig;
  const config = (await response.json()) as BrowserRuntimeConfig;
  return { appName: config.appName || appConfig.appName, supabase: config.supabase ?? null };
}

/**
 * Day 1 does not start an auth flow. When one is added, this client receives
 * only the Supabase anon/publishable key from the public configuration endpoint.
 */
export function createBrowserSupabaseClient(config: BrowserRuntimeConfig): SupabaseClient | null {
  if (!config.supabase) return null;
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
