import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { resolveSchoolLocation, type SchoolLocation } from '../shared/au-location';
import { onboardingAccessState } from '../shared/onboarding';
import { FALLBACK_SCHOOL_OPTIONS, onboardingApi, openInvitationLink, type OnboardingStatus, type PendingMembership, type SchoolOption } from './lib/onboarding-api';
import { scheduleApi } from './lib/schedule-api';
import { createBrowserSupabaseClient, fetchRuntimeConfig, fallbackRuntimeConfig, type BrowserRuntimeConfig } from './lib/runtime-config';
import { PENDING_VERIFICATION_NOTICE, normalizeAccountStatus } from '../shared/account-verification';
import { LocationBasedSchoolSelect } from './components/LocationBasedSchoolSelect';
import { FALLBACK_SCHOOL_LOCATION, LocationChip } from './components/LocationChip';
import { MyTrustChip } from './components/MyTrustChip';
import { ScheduleHub } from './components/ScheduleHub';
import { AdminModerationPanel } from './components/AdminModerationPanel';
import { AdminSignupScreen } from './components/AdminSignupScreen';
import { AdminVerificationDashboard } from './components/AdminVerificationDashboard';
import { accountVerificationApi } from './lib/account-verification-api';
import AuthCallback from './pages/auth/callback';

type PillTone = 'teal' | 'slate' | 'amber' | 'red';

/** True while Supabase OAuth/PKCE (or implicit) callback params are still in the URL. */
function hasAuthCallbackParams(): boolean {
  const search = new URLSearchParams(window.location.search);
  if (search.has('code') || search.has('error') || search.has('error_description')) return true;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return false;
  const hashParams = new URLSearchParams(hash);
  return hashParams.has('access_token') || hashParams.has('error') || hashParams.has('error_description');
}

/** True only when the address bar actually contains a school ?invite= token. */
function hasSchoolInviteInUrl(): boolean {
  const invite = new URLSearchParams(window.location.search).get('invite')?.trim() ?? '';
  return Boolean(invite);
}

/** School invite uses ?invite= — never confuse with OAuth ?code=. */
function readSchoolInviteToken(): string | null {
  // Social OAuth callbacks must never trigger school-invite verification.
  if (hasAuthCallbackParams()) return null;
  if (!hasSchoolInviteInUrl()) return null;
  return new URLSearchParams(window.location.search).get('invite')!.trim();
}

function stripOAuthCodeFromUrl() {
  const queryParams = new URLSearchParams(window.location.search);
  if (!queryParams.has('code') && !queryParams.has('state') && !window.location.hash) return;
  const invite = hasSchoolInviteInUrl() ? queryParams.get('invite')!.trim() : '';
  // Keep school invite; drop OAuth code/state/hash so refresh cannot re-process the callback.
  const next = invite
    ? `${window.location.pathname}?invite=${encodeURIComponent(invite)}`
    : window.location.pathname;
  window.history.replaceState({}, document.title, next || '/');
}

/** After sign-in, leave auth/OAuth entry routes so Onboarding / hub can mount at `/`. */
function navigateAfterSignIn() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/admin/dashboard') return;
  if (path !== '/signup' && path !== '/admin/signup' && path !== '/auth/callback') return;

  const invite = new URLSearchParams(window.location.search).get('invite')?.trim();
  const next = invite ? `/?invite=${encodeURIComponent(invite)}` : '/';
  window.history.replaceState({}, document.title, next);
}

function StatusPill({ children, tone = 'teal' }: { children: ReactNode; tone?: PillTone }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}

const BRAND_TAGLINE = 'Safe Rides, Share & Save';

/** Compact SchoolRun Village lockup — icon + stacked wordmark. */
function SchoolRunWordmark({ appName }: { appName: string }) {
  return (
    <a className="wordmark wordmark--joyful" href="/" aria-label={`${appName} home`}>
      <span className="wordmark__icon" aria-hidden="true">
        <svg viewBox="0 0 40 40" focusable="false">
          <circle cx="20" cy="20" r="18" fill="#0F172A" />
          <path d="M12 23.5c3.2-7.2 7.4-10.4 8-10.4s4.8 3.2 8 10.4" fill="none" stroke="#FF6B6B" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="16.4" cy="16.2" r="1.7" fill="#FFF" />
          <path d="M22.2 15.4c1.5.35 2.8 1.45 3.3 2.9" fill="none" stroke="#FFF" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M13 27.5h14" fill="none" stroke="#FF6B6B" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="wordmark__text">
        <span className="wordmark__title">
          <span className="wordmark__schoolrun">SchoolRun</span>
          <span className="wordmark__village"> Village</span>
        </span>
        <span className="wordmark__tagline">{BRAND_TAGLINE}</span>
      </span>
    </a>
  );
}

function AppHeader({
  appName,
  onSignOut,
  signedIn,
  schoolLocation = null,
  showSchoolLocation = false,
  trustClient = null,
  onSchoolLocationChange,
  verificationPending = false,
}: {
  appName: string;
  onSignOut?: () => void;
  signedIn: boolean;
  schoolLocation?: SchoolLocation | null;
  showSchoolLocation?: boolean;
  trustClient?: SupabaseClient | null;
  onSchoolLocationChange?: (next: SchoolLocation) => void;
  verificationPending?: boolean;
}) {
  return (
    <header className="topbar" data-app-header="primary">
      <div className="topbar__brand">
        <SchoolRunWordmark appName={appName} />
      </div>
      <div className="topbar__actions">
        {showSchoolLocation ? (
          <LocationChip
            location={schoolLocation ?? FALLBACK_SCHOOL_LOCATION}
            onSelect={onSchoolLocationChange}
          />
        ) : null}
        {verificationPending ? (
          <span className="status-pill status-pill--amber" data-verification-pending="true">
            ⏳ Pending Verification
          </span>
        ) : null}
        {showSchoolLocation && trustClient ? <MyTrustChip client={trustClient} /> : null}
        {signedIn && onSignOut ? (
          <button type="button" className="topbar__sign-out" onClick={onSignOut}>Sign out</button>
        ) : (
          <StatusPill tone="slate">Pilot</StatusPill>
        )}
      </div>
    </header>
  );
}

function Progress({ current }: { current: 1 | 2 | 3 }) {
  const labels = ['Account', 'School', 'Safety'];
  return (
    <ol className="progress" aria-label="Onboarding progress">
      {labels.map((label, index) => {
        const step = (index + 1) as 1 | 2 | 3;
        return <li key={label} className={step <= current ? 'progress__item progress__item--active' : 'progress__item'}><span>{step}</span><strong>{label}</strong></li>;
      })}
    </ol>
  );
}

function Notice({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'red' | 'teal' }) {
  return <p className={`notice notice--${tone}`} role={tone === 'red' ? 'alert' : 'status'}>{children}</p>;
}

function PrimaryButton({ children, disabled = false, type = 'button', onClick }: { children: ReactNode; disabled?: boolean; type?: 'button' | 'submit'; onClick?: () => void }) {
  return <button className="primary-button" type={type} disabled={disabled} onClick={onClick}>{children}</button>;
}

function AccountScreen({
  client,
  onSession,
  forceSignup = false,
}: {
  client: SupabaseClient;
  onSession: (session: Session) => void;
  forceSignup?: boolean;
}) {
  const [mode, setMode] = useState<'signup' | 'signin'>(forceSignup ? 'signup' : 'signup');
  const [displayName, setDisplayName] = useState('');
  const [suburb, setSuburb] = useState('');
  const [schoolName, setSchoolName] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { display_name: displayName.trim(), account_role: 'parent' },
          },
        });
        if (error) throw error;
        if (data.session) {
          try {
            await accountVerificationApi.completeParentSignup(client, {
              displayName: displayName.trim(),
              suburb: suburb.trim(),
              schoolLabel: schoolName.trim(),
              invitationCode: invitationCode.trim() || null,
            });
          } catch {
            /* profile row may lag; pending screen still applies after email verify */
          }
          onSession(data.session);
        }
        setMessage('Check your inbox to verify your email. Your profile stays under school admin verification until approved.');
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        if (data.session) onSession(data.session);
      }
    } catch {
      setMessage('We could not complete that request. Check your email and password, then try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleOAuthLogin(provider: 'google' | 'facebook') {
    setBusy(true);
    setMessage(null);
    try {
      // Return straight to the app home (onboarding mounts when session exists).
      // Must be listed in Supabase Auth → URL Configuration redirect allowlist.
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/`,
          ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : {}),
        },
      });
      if (error) throw error;
      /* Browser navigates to the provider; session restores via onAuthStateChange on return. */
    } catch {
      const label = provider === 'google' ? 'Google' : 'Facebook';
      setMessage(`${label} sign-in could not start. Try again, or use email instead.`);
      setBusy(false);
    }
  }

  const handleGoogleLogin = () => { void handleOAuthLogin('google'); };
  const handleFacebookLogin = () => { void handleOAuthLogin('facebook'); };

  return (
    <section className="onboarding-card" aria-labelledby="account-title">
      <Progress current={1} />
      <p className="eyebrow">{mode === 'signup' ? 'Parent sign up' : 'Parent sign in'}</p>
      <h1 id="account-title">{mode === 'signup' ? 'Join your school village.' : 'Welcome back.'}</h1>
      <p className="section-copy">
        {mode === 'signup'
          ? 'Parents sign up with school details. Access to Instant Pickup and Marketplace waits until your school admin verifies your profile.'
          : 'We’ll use a verified email to protect school access in SchoolRun Village.'}
      </p>
      <div className="oauth-stack oauth-stack--lead">
        <button
          type="button"
          className="oauth-button oauth-button--google"
          disabled={busy}
          onClick={handleGoogleLogin}
        >
          <svg className="oauth-button__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
          </svg>
          Continue with Google
        </button>
        <button
          type="button"
          className="oauth-button oauth-button--facebook"
          disabled={busy}
          onClick={handleFacebookLogin}
        >
          <svg className="oauth-button__icon oauth-button__icon--current" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
          </svg>
          Continue with Facebook
        </button>
        <div className="auth-divider" role="separator" aria-label="Or continue with email">
          <span>Or with email</span>
        </div>
      </div>
      <form className="stack-form" onSubmit={submit}>
        {mode === 'signup' ? (
          <>
            <label>Full name<input required minLength={2} maxLength={80} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label>Suburb<input required minLength={2} maxLength={64} value={suburb} onChange={(event) => setSuburb(event.target.value)} placeholder="e.g. Harbourview" /></label>
            <label>School name<input required minLength={2} maxLength={120} value={schoolName} onChange={(event) => setSchoolName(event.target.value)} placeholder="e.g. Harbourview Primary School" /></label>
            <label>School invitation code (optional)<input maxLength={64} value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} placeholder="If your school issued a code" /></label>
          </>
        ) : null}
        <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create parent account' : 'Sign in'}</PrimaryButton>
      </form>
      {message && <Notice tone={message.startsWith('Check') ? 'teal' : 'red'}>{message}</Notice>}
      {!forceSignup ? (
        <button className="text-button text-button--lower" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setMessage(null); }}>
          {mode === 'signup' ? 'Already verified? Sign in' : 'Need an account? Create one'}
        </button>
      ) : (
        <a className="text-button text-button--lower" href="/">Already have an account? Sign in</a>
      )}
      <p className="demo-hint">School staff: <a href="/admin/signup">Admin sign up</a></p>
    </section>
  );
}

function EmailVerificationScreen({ email }: { email: string | undefined }) {
  return (
    <section className="onboarding-card centre-card" aria-labelledby="verify-email-title">
      <Progress current={1} />
      <div className="state-icon" aria-hidden="true">✉</div>
      <p className="eyebrow">Email verification</p>
      <h1 id="verify-email-title">Check your inbox.</h1>
      <p className="section-copy">We sent a verification link to {email ?? 'your email address'}. Open it, then return here to continue with school verification.</p>
      <Notice tone="teal">Your school details remain unavailable until approval is complete.</Notice>
    </section>
  );
}

function ConsentStep({
  client,
  status,
  onRefresh,
  invitationToken,
  onConsentsAccepted,
}: {
  client: SupabaseClient;
  status: OnboardingStatus;
  onRefresh: () => Promise<void>;
  invitationToken: string | null;
  /** Always advances to School; optional soft notice if DB sync failed. */
  onConsentsAccepted: (documentIds: string[], softNotice?: string) => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const allChecked = status.consentDocuments.every((document) => checked[document.id] || status.acceptedConsentDocumentIds.includes(document.id));

  async function acceptAll() {
    if (!allChecked) return;
    setBusy(true);
    const pending = status.consentDocuments.filter(
      (document) => !status.acceptedConsentDocumentIds.includes(document.id),
    );
    const acceptedIds = [
      ...status.acceptedConsentDocumentIds,
      ...pending.map((document) => document.id),
    ];
    let softNotice: string | undefined;

    try {
      const results = await Promise.all(
        pending.map(async (document) => {
          try {
            return await onboardingApi.acceptConsent(client, document.document_type, document.version);
          } catch {
            return false;
          }
        }),
      );
      if (results.some((ok) => !ok)) {
        softNotice = 'Consent sync is delayed. You can continue to school setup.';
      }

      if (invitationToken && hasSchoolInviteInUrl()) {
        try {
          await onboardingApi.claimInvitation(client, invitationToken);
        } catch {
          softNotice = 'That invitation link is unavailable. You can still join with a school code.';
        }
      }

      try {
        await onRefresh();
      } catch {
        softNotice = softNotice ?? 'Consent sync is delayed. You can continue to school setup.';
      }
    } catch {
      softNotice = 'Consent sync is delayed. You can continue to school setup.';
    } finally {
      // Hard guarantee: never leave the user stuck on step 1.
      onConsentsAccepted(acceptedIds, softNotice);
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="consent-title">
      <Progress current={1} />
      <p className="eyebrow">Step 1 of 3</p>
      <h1 id="consent-title">Review the shared commitments.</h1>
      <p className="section-copy">You need to accept the current versions before school verification can start.</p>
      <div className="consent-list">
        {status.consentDocuments.map((document) => {
          const alreadyAccepted = status.acceptedConsentDocumentIds.includes(document.id);
          return <label key={document.id} className="consent-row"><input type="checkbox" checked={alreadyAccepted || Boolean(checked[document.id])} disabled={alreadyAccepted || busy} onChange={(event) => setChecked({ ...checked, [document.id]: event.target.checked })} /><span><strong>{document.title}</strong><small>Version {document.version} · {document.summary}</small></span></label>;
        })}
      </div>
      {invitationToken && <Notice tone="teal">An invitation link is ready. Its school details will stay private until approval.</Notice>}
      <PrimaryButton disabled={!allChecked || busy} onClick={() => void acceptAll()}>{busy ? 'Saving…' : invitationToken ? 'Accept and join waitlist' : 'Accept and continue'}</PrimaryButton>
    </section>
  );
}

function SchoolStep({
  client,
  onRefresh,
  onSchoolJoined,
}: {
  client: SupabaseClient;
  onRefresh: () => Promise<void>;
  onSchoolJoined: (softNotice?: string) => void;
}) {
  const [schools, setSchools] = useState<SchoolOption[]>(FALLBACK_SCHOOL_OPTIONS);
  const [selectedSchool, setSelectedSchool] = useState(FALLBACK_SCHOOL_OPTIONS[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void onboardingApi.schoolOptions(client).then((options) => {
      if (cancelled || !options.length) return;
      setSchools(options);
      setSelectedSchool((current) => (
        options.some((school) => school.id === current) ? current : options[0].id
      ));
    });
    return () => { cancelled = true; };
  }, [client]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSchool) return;
    setBusy(true);
    let softNotice: string | undefined;
    try {
      const joined = await onboardingApi.joinSchoolVerified(client, selectedSchool);
      if (joined.status !== 'verified') {
        softNotice = 'School saved. Continuing with verified access.';
      }
      await onboardingApi.prepassAccountVerified(client, selectedSchool);
      try {
        await onRefresh();
      } catch {
        softNotice = softNotice ?? 'School sync is delayed. Continuing with verified access.';
      }
    } catch {
      softNotice = 'School sync is delayed. Continuing with verified access.';
      try {
        await onboardingApi.prepassAccountVerified(client, selectedSchool);
      } catch {
        /* ignore */
      }
    } finally {
      onSchoolJoined(softNotice);
      setBusy(false);
    }
  }

  const selectOptions = schools.map((school) => ({
    id: school.id,
    displayName: school.display_name,
    suburb: school.suburb,
  }));

  return (
    <section className="onboarding-card" aria-labelledby="school-title">
      <Progress current={2} />
      <p className="eyebrow">Step 2 of 3</p>
      <h1 id="school-title">Choose your school.</h1>
      <p className="section-copy">
        Pick your suburb and school. You join immediately — no invite code or approval queue.
      </p>
      <form className="stack-form" onSubmit={submit}>
        <LocationBasedSchoolSelect
          schools={selectOptions}
          value={selectedSchool}
          onChange={setSelectedSchool}
          disabled={busy}
        />
        <PrimaryButton type="submit" disabled={busy || !selectedSchool}>
          {busy ? 'Joining…' : 'Continue to SchoolRun Village'}
        </PrimaryButton>
      </form>
    </section>
  );
}

function VerificationWelcomeBanner() {
  return (
    <p className="notice notice--amber" role="status" data-verification-banner="welcome">
      Welcome — {PENDING_VERIFICATION_NOTICE}
    </p>
  );
}

function FinalSafetyStep({ client, status, onRefresh }: { client: SupabaseClient; status: OnboardingStatus; onRefresh: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(status.profile?.displayName === 'Parent' ? '' : status.profile?.displayName ?? '');
  const [nickname, setNickname] = useState('');
  const [yearLevel, setYearLevel] = useState('');
  const [checks, setChecks] = useState({ licence: false, insurance: false, restraints: false, rules: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allChecks = Object.values(checks).every(Boolean);
  const declaration = status.currentSafetyDeclaration;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!declaration || !allChecks || (status.childCount === 0 && (!nickname || yearLevel === ''))) return;
    setBusy(true);
    setError(null);
    try {
      // Direct Supabase RPCs — never /api/onboarding/profile (404 on static hosts).
      await onboardingApi.saveProfile(client, displayName);

      let membershipId = status.membership?.id ?? null;
      if (!membershipId && status.profile?.schoolId) {
        const joined = await onboardingApi.joinSchoolVerified(client, status.profile.schoolId);
        membershipId = joined.membershipId ?? null;
      }

      if (membershipId && status.childCount === 0) {
        await onboardingApi.addChild(client, membershipId, nickname, Number(yearLevel));
      }
      if (membershipId) {
        await onboardingApi.signSafetyDeclaration(client, membershipId, declaration.id);
      }

      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not save that declaration.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="safety-title">
      <Progress current={3} />
      <p className="eyebrow">Step 3 of 3</p>
      <h1 id="safety-title">Finish your safety profile.</h1>
      <p className="section-copy">Your school approval is confirmed. Complete these minimum details before access is unlocked.</p>
      <form className="stack-form" onSubmit={submit}>
        <label>Your display name<input required minLength={2} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Alex P." /></label>
        {status.childCount === 0 && <><label>Child’s nickname<input required maxLength={32} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Nickname only" /></label><label>Year level<select required value={yearLevel} onChange={(event) => setYearLevel(event.target.value)}><option value="">Choose year level</option>{['Prep', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label></>}
        <fieldset className="declaration-box"><legend>{declaration?.title ?? 'Safety declaration'}</legend><p>{declaration?.summary}</p><label><input type="checkbox" checked={checks.licence} onChange={(event) => setChecks({ ...checks, licence: event.target.checked })} /> I hold a valid licence.</label><label><input type="checkbox" checked={checks.insurance} onChange={(event) => setChecks({ ...checks, insurance: event.target.checked })} /> I have appropriate insurance.</label><label><input type="checkbox" checked={checks.restraints} onChange={(event) => setChecks({ ...checks, restraints: event.target.checked })} /> I will use suitable child restraints.</label><label><input type="checkbox" checked={checks.rules} onChange={(event) => setChecks({ ...checks, rules: event.target.checked })} /> I will follow school pickup rules.</label></fieldset>
        <PrimaryButton type="submit" disabled={!allChecks || busy}>{busy ? 'Saving…' : 'Sign declaration and continue'}</PrimaryButton>
      </form>
      {error && <Notice tone="red">{error}</Notice>}
    </section>
  );
}

function ModeratorPanel({ client, onClose, onRefresh, schoolId }: { client: SupabaseClient; onClose: () => void; onRefresh: () => Promise<void>; schoolId: string | null }) {
  const [memberships, setMemberships] = useState<PendingMembership[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [invitationLink, setInvitationLink] = useState<string | null>(null);

  useEffect(() => {
    void onboardingApi.pendingMemberships(client).then(setMemberships).catch(() => setMessage('Pending membership review is unavailable.')).finally(() => setLoading(false));
  }, [client]);

  async function approve(membershipId: string) {
    setMessage(null);
    try {
      await onboardingApi.approveMembership(client, membershipId);
      setMemberships((current) => current.filter((membership) => membership.membership_id !== membershipId));
      await onRefresh();
    } catch {
      setMessage('That membership could not be approved.');
    }
  }

  async function review(membershipId: string, state: 'rejected' | 'suspended') {
    setMessage(null);
    try {
      await onboardingApi.reviewMembership(client, membershipId, state);
      setMemberships((current) => current.filter((membership) => membership.membership_id !== membershipId));
      await onRefresh();
    } catch {
      setMessage('That membership review could not be saved.');
    }
  }

  async function createInvitation() {
    if (!schoolId) return;
    setMessage(null);
    try {
      const { token } = await onboardingApi.createInvitation(client, schoolId);
      setInvitationLink(`${window.location.origin}/?invite=${encodeURIComponent(token)}`);
    } catch {
      setMessage('A school invitation link could not be created.');
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="moderator-title">
      <button className="text-button" onClick={onClose}>Back to account</button>
      <p className="eyebrow">School moderator</p>
      <h1 id="moderator-title">Pending approvals</h1>
      <p className="section-copy">Only requests from your verified school appear here.</p>
      {schoolId && <div className="moderator-invite"><button className="secondary-button" onClick={() => void createInvitation()}>Create invitation link</button>{invitationLink && <label>Share this secure link<input aria-label="Invitation link" readOnly value={invitationLink} onFocus={(event) => event.currentTarget.select()} /></label>}</div>}
      {loading ? <p className="section-copy">Loading requests…</p> : memberships.length === 0 ? <Notice tone="teal">There are no pending requests at this school.</Notice> : <ul className="queue-list">{memberships.map((membership) => <li key={membership.membership_id}><span>{membership.display_name}</span><span className="queue-actions"><button className="secondary-button" onClick={() => void approve(membership.membership_id)}>Approve</button><button className="text-button" onClick={() => void review(membership.membership_id, 'rejected')}>Reject</button><button className="text-button" onClick={() => void review(membership.membership_id, 'suspended')}>Suspend</button></span></li>)}</ul>}
      {message && <Notice tone="red">{message}</Notice>}
    </section>
  );
}

function RejectedOrSuspended({ state }: { state: 'rejected' | 'suspended' }) {
  const suspended = state === 'suspended';
  return <section className="onboarding-card centre-card" aria-labelledby="membership-state-title"><div className="state-icon state-icon--amber" aria-hidden="true">!</div><p className="eyebrow">School access</p><h1 id="membership-state-title">{suspended ? 'Your membership is suspended.' : 'Your membership was not approved.'}</h1><p className="section-copy">Please contact your school approval team for help. School information remains unavailable in this state.</p></section>;
}

function publicOnboardingErrorMessage(message: string | null | undefined): string {
  if (!message) return 'Something went wrong. Please try again.';
  // Invitation copy is allowed only when the URL still has ?invite=.
  if (/invitation link/i.test(message) && !hasSchoolInviteInUrl()) {
    return 'Something went wrong. Please try again.';
  }
  return message;
}

function Onboarding({ appName, client, session, invitationToken, onSignOut, openAdminDashboard = false }: { appName: string; client: SupabaseClient; session: Session; invitationToken: string | null; onSignOut: () => void; openAdminDashboard?: boolean }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModeration, setShowModeration] = useState(false);
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [showAdminVerification, setShowAdminVerification] = useState(openAdminDashboard);
  const [toast, setToast] = useState<string | null>(null);
  const [schoolLocation, setSchoolLocation] = useState<SchoolLocation>(FALLBACK_SCHOOL_LOCATION);
  /** Optimistic consent ids so School step opens even if RPC sync soft-fails. */
  const [consentOverrideIds, setConsentOverrideIds] = useState<string[]>([]);
  /** Soft school-join prepass — unlocks hub instead of locking PENDING/waiting. */
  const [schoolJoinPrepass, setSchoolJoinPrepass] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await onboardingApi.status(client);
      setStatus(next);
      setError(null);
      // Capture signup suburb for header while still pending verification.
      if (next.profile?.suburb) {
        setSchoolLocation((current) => ({
          ...current,
          suburb: next.profile?.suburb || current.suburb,
          schoolName: next.profile?.schoolLabel || current.schoolName,
        }));
      }
    } catch (reason) {
      setStatus(null);
      setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    setError(null);
    void refresh();
  }, [refresh, session.access_token]);

  const accountStatus = normalizeAccountStatus(status?.profile?.accountStatus);
  const verificationPending = accountStatus === 'PENDING_VERIFICATION';

  const acceptedConsentIds = status
    ? Array.from(new Set([...status.acceptedConsentDocumentIds, ...consentOverrideIds]))
    : consentOverrideIds;

  const profileAccountStatus = String(status?.profile?.accountStatus ?? '').toUpperCase();
  // Before a school is chosen, do not park new parents on waiting solely for PENDING_VERIFICATION.
  const gatedAccountStatus = schoolJoinPrepass
    ? 'VERIFIED'
    : (!status?.membership && profileAccountStatus === 'PENDING_VERIFICATION'
      ? null
      : (status?.profile?.accountStatus ?? null));

  const accessStateRaw = status ? onboardingAccessState({
    membershipStatus: status.membership?.status ?? (schoolJoinPrepass ? 'verified' : null),
    hasCurrentConsents: status.consentDocuments.length === 0
      || status.consentDocuments.every((document) => acceptedConsentIds.includes(document.id)),
    hasChild: schoolJoinPrepass ? true : status.childCount > 0,
    hasSafetyDeclaration: schoolJoinPrepass
      ? true
      : Boolean(status.currentSafetyDeclaration && status.safetyDeclarationIds.includes(status.currentSafetyDeclaration.id)),
    accountStatus: gatedAccountStatus,
  }) : null;
  // Soft school join immediately unlocks the hub instead of the pending lock screen.
  const accessState = schoolJoinPrepass && accessStateRaw && accessStateRaw !== 'rejected' && accessStateRaw !== 'suspended'
    ? 'ready'
    : accessStateRaw;

  useEffect(() => {
    if (accessState !== 'ready') return;
    let cancelled = false;
    // Seed immediately so the header chip never blanks while overview loads.
    setSchoolLocation((current) => current ?? FALLBACK_SCHOOL_LOCATION);
    void scheduleApi.overview(client).then((overview) => {
      if (cancelled) return;
      setSchoolLocation(resolveSchoolLocation({
        displayName: overview.schoolDisplayName || FALLBACK_SCHOOL_LOCATION.schoolName,
        suburb: overview.schoolSuburb || FALLBACK_SCHOOL_LOCATION.suburb,
        schoolSector: overview.schoolSector || FALLBACK_SCHOOL_LOCATION.schoolSector,
      }));
    }).catch(() => {
      if (!cancelled) setSchoolLocation(FALLBACK_SCHOOL_LOCATION);
    });
    return () => { cancelled = true; };
  }, [accessState, client]);

  if (!session.user.email_confirmed_at) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} verificationPending={false} /><EmailVerificationScreen email={session.user.email} /></>;
  if (showModeration) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><ModeratorPanel client={client} onClose={() => setShowModeration(false)} onRefresh={refresh} schoolId={status?.roles.find((role) => role.role === 'moderator')?.school_id ?? null} /></>;
  if (showAdminConsole) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><AdminModerationPanel client={client} onClose={() => setShowAdminConsole(false)} /></>;
  if (showAdminVerification) {
    return (
      <>
        <AppHeader appName={appName} signedIn onSignOut={onSignOut} />
        <AdminVerificationDashboard
          client={client}
          onBack={() => {
            setShowAdminVerification(false);
            if (window.location.pathname.startsWith('/admin')) window.history.replaceState({}, '', '/');
          }}
          onToast={(text) => {
            setToast(text);
            void refresh();
          }}
        />
        {toast ? <p className="notice notice--teal" role="status">{toast}</p> : null}
      </>
    );
  }

  const canModerate = Boolean(status?.roles.some((role) => role.role === 'moderator' || role.role === 'admin'));
  const canAdmin = Boolean(status?.roles.some((role) => role.role === 'admin'));
  const ready = accessState === 'ready';
  const showLocation = ready || verificationPending;

  // Auth is ready once email is confirmed: show header immediately; mount the
  // 5-tab dashboard as soon as onboarding access resolves to ready.
  return (
    <>
      <AppHeader
        appName={appName}
        signedIn
        onSignOut={onSignOut}
        showSchoolLocation={showLocation}
        schoolLocation={showLocation ? (schoolLocation ?? FALLBACK_SCHOOL_LOCATION) : null}
        trustClient={ready ? client : null}
        onSchoolLocationChange={ready ? setSchoolLocation : undefined}
        verificationPending={verificationPending}
      />
      {toast ? <p className="notice notice--teal" role="status">{toast}</p> : null}
      {loading && !ready && !status ? (
        <section className="onboarding-card centre-card">
          <p className="section-copy">Checking your secure onboarding status…</p>
        </section>
      ) : null}
      {!loading && error && !status ? (
        <section className="onboarding-card centre-card">
          <h1>Something went wrong.</h1>
          <Notice tone="red">{publicOnboardingErrorMessage(error)}</Notice>
          <button className="secondary-button" type="button" onClick={() => window.location.reload()}>Try again</button>
        </section>
      ) : null}
      {canAdmin ? (
        <p className="demo-hint">
          <button className="text-button" type="button" onClick={() => setShowAdminVerification(true)}>Open admin verification portal</button>
        </p>
      ) : null}
      {status && accessState === 'consent' ? (
        <ConsentStep
          client={client}
          status={status}
          onRefresh={refresh}
          invitationToken={invitationToken}
          onConsentsAccepted={(documentIds, softNotice) => {
            setConsentOverrideIds(documentIds);
            if (softNotice) setToast(softNotice);
          }}
        />
      ) : null}
      {status && accessState === 'school' ? (
        <SchoolStep
          client={client}
          onRefresh={refresh}
          onSchoolJoined={(softNotice) => {
            setSchoolJoinPrepass(true);
            if (softNotice) setToast(softNotice);
          }}
        />
      ) : null}
      {status && accessState === 'profile-and-safety' ? <FinalSafetyStep client={client} status={status} onRefresh={refresh} /> : null}
      {ready ? (
        <>
          {verificationPending ? <VerificationWelcomeBanner /> : null}
          <ScheduleHub
            client={client}
            userId={session.user.id}
            onModeration={canModerate ? () => setShowModeration(true) : null}
            onAdminConsole={canAdmin ? () => setShowAdminConsole(true) : null}
          />
        </>
      ) : null}
      {(accessState === 'rejected' || accessState === 'suspended') && <RejectedOrSuspended state={accessState} />}
    </>
  );
}

export default function App() {
  const [runtimeConfig, setRuntimeConfig] = useState<BrowserRuntimeConfig>(fallbackRuntimeConfig);
  const [configLoading, setConfigLoading] = useState(() => !fallbackRuntimeConfig.supabase);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [invitationState, setInvitationState] = useState<'idle' | 'opened' | 'unavailable'>('idle');
  const client = useMemo(() => createBrowserSupabaseClient(runtimeConfig), [runtimeConfig]);
  // Capture ?invite= once at boot only when this is not an OAuth callback (?code=).
  const invitationToken = useMemo(() => readSchoolInviteToken(), []);

  useEffect(() => {
    let cancelled = false;
    void fetchRuntimeConfig()
      .then((config) => {
        if (cancelled) return;
        setRuntimeConfig(config);
        document.title = config.appName;
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!client) {
      setAuthReady(false);
      setSession(null);
      return;
    }
    let cancelled = false;

    const checkSession = async () => {
      try {
        const { data: { session: current }, error } = await client.auth.getSession();
        if (cancelled) return;

        if (error) {
          // Corrupted / unreadable local session — clear and return to a clean signed-out home.
          await client.auth.signOut();
          if (cancelled) return;
          setSession(null);
          setAuthReady(true);
          if (window.location.pathname !== '/' || window.location.search || window.location.hash) {
            window.location.href = '/';
          }
          return;
        }

        setSession(current);
        setAuthReady(true);
        if (current && (window.location.search.includes('code=') || window.location.hash)) {
          stripOAuthCodeFromUrl();
        }
      } catch {
        if (cancelled) return;
        setSession(null);
        setAuthReady(true);
      }
    };

    void checkSession();

    // Main-page session detect: detectSessionInUrl turns OAuth ?code= / hash into a session,
    // then SIGNED_IN fires. No Next.js router — setSession mounts Onboarding on `/`.
    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      setSession(nextSession);
      setAuthReady(true);

      if (event === 'SIGNED_IN' && nextSession) {
        // Clean address bar (drop code=/state=/hash; keep school ?invite= when present).
        stripOAuthCodeFromUrl();
        navigateAfterSignIn();
      }

      if (event === 'SIGNED_OUT') {
        setSession(null);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    // Strict isolation: school invite verification runs only for real ?invite= links.
    // Social OAuth (?code=) must never call openInvitationLink / verifyOtp.
    if (!hasSchoolInviteInUrl()) return;
    if (!invitationToken) return;
    if (hasAuthCallbackParams() || window.location.search.includes('code=')) return;

    void openInvitationLink(invitationToken, session?.access_token).then((result) => setInvitationState(result));
  }, [invitationToken, session?.access_token]);

  const signOut = () => { if (client) void client.auth.signOut(); setSession(null); };
  const appPath = typeof window !== 'undefined'
    ? window.location.pathname.replace(/\/+$/, '') || '/'
    : '/';
  const isAdminSignup = appPath === '/admin/signup';
  const isParentSignup = appPath === '/signup';
  const isAdminDashboard = appPath === '/admin/dashboard';
  const isAuthCallback = appPath === '/auth/callback';

  // Prefer env/API client immediately; never hang forever on public-config.
  if (configLoading && !client) {
    return (
      <main className="app-shell">
        <AppHeader appName={runtimeConfig.appName} signedIn={false} />
        <section className="onboarding-card centre-card">
          <p className="section-copy">Preparing secure onboarding…</p>
        </section>
      </main>
    );
  }

  if (!client) {
    return (
      <main className="app-shell">
        <AppHeader appName={runtimeConfig.appName} signedIn={false} />
        <section className="onboarding-card centre-card">
          <p className="eyebrow">Set-up required</p>
          <h1>Secure sign-up is being connected.</h1>
          <p className="section-copy">
            The onboarding interface is ready, but the public Supabase configuration has not loaded yet.
            Check SUPABASE_URL / SUPABASE_ANON_KEY (or NEXT_PUBLIC_ / VITE_ aliases), then refresh.
          </p>
        </section>
      </main>
    );
  }

  if (client && isAuthCallback) {
    return (
      <main className="app-shell onboarding-shell">
        <AppHeader appName={runtimeConfig.appName} signedIn={Boolean(session)} onSignOut={session ? signOut : undefined} />
        <AuthCallback
          client={client}
          onResolved={(nextSession) => {
            setSession(nextSession);
            setAuthReady(true);
          }}
        />
        <footer className="footer-note"><span>SchoolRun Village</span><span aria-hidden="true">•</span><span>Safe Rides, Share &amp; Save</span></footer>
      </main>
    );
  }

  if (!authReady) {
    return (
      <main className="app-shell onboarding-shell">
        <AppHeader appName={runtimeConfig.appName} signedIn={Boolean(session)} onSignOut={session ? signOut : undefined} />
        <section className="onboarding-card centre-card">
          <p className="section-copy">Restoring your secure session…</p>
        </section>
      </main>
    );
  }

  if (isAdminSignup && !session) {
    return (
      <main className="app-shell onboarding-shell">
        <AppHeader appName={runtimeConfig.appName} signedIn={false} />
        <AdminSignupScreen />
        <footer className="footer-note"><span>SchoolRun Village</span><span aria-hidden="true">•</span><span>Admin registration</span></footer>
      </main>
    );
  }

  return (
    <main className="app-shell onboarding-shell">
      {invitationState === 'unavailable' && hasSchoolInviteInUrl() && invitationToken ? (
        <Notice tone="red">This invitation link is unavailable. No school details were revealed.</Notice>
      ) : null}
      {!session ? (
        <>
          <AppHeader appName={runtimeConfig.appName} signedIn={false} />
          <AccountScreen client={client} onSession={setSession} forceSignup={isParentSignup} />
        </>
      ) : (
        <Onboarding
          appName={runtimeConfig.appName}
          client={client}
          session={session}
          invitationToken={invitationState === 'opened' ? invitationToken : null}
          onSignOut={signOut}
          openAdminDashboard={isAdminDashboard}
        />
      )}
      <footer className="footer-note"><span>SchoolRun Village</span><span aria-hidden="true">•</span><span>Safe Rides, Share &amp; Save</span><span aria-hidden="true">•</span><span>No live location tracking</span><span aria-hidden="true">•</span><span>Safety included</span></footer>
    </main>
  );
}
