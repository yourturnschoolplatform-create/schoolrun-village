import appConfig from '../app.config.js';

export type PublicSupabaseConfig = {
  url: string;
  anonKey: string;
};

export type PublicRuntimeConfig = {
  appName: string;
  supabase: PublicSupabaseConfig | null;
};

function legacyJwtRole(value: string): string | null {
  if (!value.startsWith('eyJ') || value.split('.').length !== 3) return null;
  try {
    const encodedPayload = value.split('.')[1];
    if (!encodedPayload) return null;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/** Supabase keys are opaque; remove copy/paste line-wrap whitespace before use. */
export function normaliseSupabaseKey(value: string): string {
  return value.replace(/\s/g, '');
}

function hasCurrentSupabaseKeyPrefix(value: string, prefix: 'sb_publishable_' | 'sb_secret_'): boolean {
  return value.startsWith(prefix) && value.length > prefix.length + 11 && !/\s/.test(value);
}

/** Supabase supports legacy JWT anon keys and current sb_publishable_ keys. */
export function isBrowserSafeSupabaseKey(value: string): boolean {
  const normalised = normaliseSupabaseKey(value);
  return legacyJwtRole(normalised) === 'anon' || hasCurrentSupabaseKeyPrefix(normalised, 'sb_publishable_');
}

/** Supabase supports legacy JWT service_role keys and current sb_secret_ keys. */
export function isServerOnlySupabaseKey(value: string): boolean {
  const normalised = normaliseSupabaseKey(value);
  return legacyJwtRole(normalised) === 'service_role' || hasCurrentSupabaseKeyPrefix(normalised, 'sb_secret_');
}

function isSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function requiredEnvironmentValue(name: 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Supabase runtime configuration.`);
  return value;
}

export function readPublicSupabaseConfig(): PublicSupabaseConfig {
  const url = requiredEnvironmentValue('SUPABASE_URL');
  const anonKey = normaliseSupabaseKey(requiredEnvironmentValue('SUPABASE_ANON_KEY'));

  if (!isSupabaseUrl(url)) {
    throw new Error('SUPABASE_URL must be a valid HTTPS Supabase project URL.');
  }
  if (!isBrowserSafeSupabaseKey(anonKey)) {
    throw new Error('SUPABASE_ANON_KEY must be a Supabase anon JWT or sb_publishable_ key.');
  }

  return { url, anonKey };
}

/** This is the only shape sent to the browser. Service-role configuration is never read here. */
export function readPublicRuntimeConfig(): PublicRuntimeConfig {
  try {
    return { appName: appConfig.appName, supabase: readPublicSupabaseConfig() };
  } catch {
    return { appName: appConfig.appName, supabase: null };
  }
}
