import appConfig from '../../app.config';

export type BrowserRuntimeConfig = {
  appName: string;
  supabase: {
    url: string;
    anonKey: string;
  } | null;
};

const CONFIG_FETCH_TIMEOUT_MS = 4000;

type PublicEnvBag = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  YOURTURN_SUPABASE_URL?: string;
  YOURTURN_SUPABASE_ANON_KEY?: string;
};

function readMetaEnv(): PublicEnvBag {
  try {
    return (import.meta as ImportMeta & { env?: PublicEnvBag }).env ?? {};
  } catch {
    return {};
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed) return trimmed;
  }
  return '';
}

function isHttpsSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function looksLikeBrowserAnonKey(value: string): boolean {
  const normalised = value.replace(/\s/g, '');
  if (!normalised) return false;
  if (normalised.startsWith('sb_publishable_') && normalised.length > 20) return true;
  if (!normalised.startsWith('eyJ') || normalised.split('.').length !== 3) return false;
  try {
    const payload = JSON.parse(atob(normalised.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return payload.role === 'anon';
  } catch {
    return false;
  }
}

/**
 * Browser-safe env fallback when `/api/public-config` is unreachable.
 * Reads Vite-injected public values only (never service-role).
 * Supports VITE_*, NEXT_PUBLIC_*, and YOURTURN_* aliases mapped from SUPABASE_URL / SUPABASE_ANON_KEY at build time.
 */
export function readEnvRuntimeFallback(): BrowserRuntimeConfig {
  const env = readMetaEnv();
  const url = firstNonEmpty(
    env.YOURTURN_SUPABASE_URL,
    env.VITE_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const anonKey = firstNonEmpty(
    env.YOURTURN_SUPABASE_ANON_KEY,
    env.VITE_SUPABASE_ANON_KEY,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ).replace(/\s/g, '');

  if (!isHttpsSupabaseUrl(url) || !looksLikeBrowserAnonKey(anonKey)) {
    return { appName: appConfig.appName, supabase: null };
  }
  return { appName: appConfig.appName, supabase: { url, anonKey } };
}

export const fallbackRuntimeConfig: BrowserRuntimeConfig = readEnvRuntimeFallback();

function mergeConfig(primary: BrowserRuntimeConfig | null | undefined, fallback: BrowserRuntimeConfig): BrowserRuntimeConfig {
  const appName = primary?.appName?.trim() || fallback.appName || appConfig.appName;
  const supabase = primary?.supabase?.url && primary.supabase.anonKey
    ? primary.supabase
    : fallback.supabase;
  return { appName, supabase };
}

export async function fetchRuntimeConfig(): Promise<BrowserRuntimeConfig> {
  const envFallback = readEnvRuntimeFallback();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch('/api/public-config', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });

    if (!response.ok) {
      return mergeConfig(null, envFallback.supabase ? envFallback : fallbackRuntimeConfig);
    }

    const config = (await response.json()) as BrowserRuntimeConfig;
    return mergeConfig(
      { appName: config.appName || appConfig.appName, supabase: config.supabase ?? null },
      envFallback,
    );
  } catch {
    // Network / timeout / parse failures must never leave the app stuck on boot.
    return envFallback.supabase ? envFallback : { appName: appConfig.appName, supabase: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
