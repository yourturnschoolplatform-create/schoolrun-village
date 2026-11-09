import { useEffect, useRef } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

type AuthCallbackProps = {
  client: SupabaseClient;
  onResolved: (session: Session | null) => void;
};

let exchangeStarted = false;

/**
 * OAuth PKCE return page at /auth/callback.
 * Vite SPA equivalent of Next.js pages/auth/callback — no next/router.
 */
export default function AuthCallback({ client, onResolved }: AuthCallbackProps) {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const finish = (session: Session | null) => {
      const invite = new URLSearchParams(window.location.search).get('invite')?.trim();
      const next = invite ? `/?invite=${encodeURIComponent(invite)}` : '/';
      window.history.replaceState({}, document.title, next);
      onResolved(session);
    };

    const handleAuthCallback = async () => {
      const code = new URLSearchParams(window.location.search).get('code');

      if (code && !exchangeStarted) {
        exchangeStarted = true;
        const { data, error } = await client.auth.exchangeCodeForSession(code);
        if (!error && data.session) {
          finish(data.session);
          return;
        }
      }

      const { data } = await client.auth.getSession();
      finish(data.session ?? null);
    };

    void handleAuthCallback();
  }, [client, onResolved]);

  return (
    <section className="onboarding-card centre-card" aria-live="polite" aria-busy="true">
      <p className="section-copy">Completing sign-in…</p>
    </section>
  );
}
