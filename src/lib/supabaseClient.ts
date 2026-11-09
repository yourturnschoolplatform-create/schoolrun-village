import type { SupabaseClient } from '@supabase/supabase-js';
import { createBrowserSupabaseClient, fallbackRuntimeConfig } from './runtime-config';

/**
 * Env-backed browser client (VITE_ / NEXT_PUBLIC_ / YOURTURN_ aliases).
 * Prefer the App-owned client from createBrowserSupabaseClient(runtimeConfig)
 * when /api/public-config may supply credentials; this export is for simple imports.
 */
export const supabase: SupabaseClient | null = createBrowserSupabaseClient(fallbackRuntimeConfig);
