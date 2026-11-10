import type { AuthTokenResponse, EmailOtpType, Session, SupabaseClient } from '@supabase/supabase-js';

/** Query/hash shapes used by Supabase email verify + OAuth/PKCE returns. */
export function hasAuthCallbackParams(location: Location = window.location): boolean {
  const search = new URLSearchParams(location.search);
  if (
    search.has('code')
    || search.has('token_hash')
    || search.has('error')
    || search.has('error_description')
  ) {
    return true;
  }
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return false;
  const hashParams = new URLSearchParams(hash);
  return hashParams.has('access_token')
    || hashParams.has('refresh_token')
    || hashParams.has('error')
    || hashParams.has('error_description')
    || (hashParams.has('type') && (hashParams.has('access_token') || hashParams.has('token_hash')));
}

/**
 * Consume email-verify / magic-link query params (`token_hash` + `type`) when present.
 * PKCE `?code=` and implicit `#access_token` are handled by detectSessionInUrl on getSession.
 */
export async function exchangeAuthCallbackParams(
  client: SupabaseClient,
): Promise<Session | null> {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  const tokenHash = search.get('token_hash') || hash.get('token_hash');
  const typeRaw = (search.get('type') || hash.get('type') || '').trim();

  if (tokenHash && typeRaw) {
    const { data, error } = await client.auth.verifyOtp({
      token_hash: tokenHash,
      type: typeRaw as EmailOtpType,
    });
    if (!error && data.session) return data.session;
  }

  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

/** Drop auth callback noise from the address bar; keep school ?invite= when present. */
export function stripAuthCallbackFromUrl(): void {
  const queryParams = new URLSearchParams(window.location.search);
  const invite = queryParams.get('invite')?.trim() ?? '';
  const authKeys = new Set([
    'code',
    'state',
    'token_hash',
    'type',
    'error',
    'error_description',
    'error_code',
  ]);

  let changed = Boolean(window.location.hash);
  const kept = new URLSearchParams();
  if (invite) kept.set('invite', invite);

  queryParams.forEach((value, key) => {
    if (key === 'invite') return;
    if (authKeys.has(key)) {
      changed = true;
      return;
    }
    kept.set(key, value);
  });

  if (!changed && !window.location.hash) return;

  const qs = kept.toString();
  const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, document.title, next || '/');
}

export async function refreshBrowserSession(
  client: SupabaseClient,
): Promise<Session | null> {
  const refreshed: AuthTokenResponse = await client.auth.refreshSession();
  if (!refreshed.error && refreshed.data.session) return refreshed.data.session;
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}
