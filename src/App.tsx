import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { onboardingAccessState } from '../shared/onboarding';
import { onboardingApi, openInvitationLink, type OnboardingStatus, type PendingMembership, type SchoolOption } from './lib/onboarding-api';
import { createBrowserSupabaseClient, fetchRuntimeConfig, fallbackRuntimeConfig, type BrowserRuntimeConfig } from './lib/runtime-config';
import { ScheduleHub } from './components/ScheduleHub';

type PillTone = 'teal' | 'slate' | 'amber' | 'red';

function StatusPill({ children, tone = 'teal' }: { children: ReactNode; tone?: PillTone }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32"><path d="M6 10.8 16 5l10 5.8v10.4L16 27 6 21.2Z" fill="currentColor" opacity=".16" /><path d="M8.7 12.4 16 8.2l7.3 4.2v7.2L16 23.8l-7.3-4.2Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" /><path d="m12.6 15.8 2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" /></svg>
    </span>
  );
}

function AppHeader({ appName, onSignOut, signedIn }: { appName: string; onSignOut?: () => void; signedIn: boolean }) {
  return (
    <header className="topbar">
      <a className="wordmark" href="/" aria-label={`${appName} home`}><BrandMark /><span>{appName}</span></a>
      {signedIn && onSignOut ? <button className="text-button" onClick={onSignOut}>Sign out</button> : <StatusPill tone="slate">Pilot</StatusPill>}
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

function AccountScreen({ client, onSession }: { client: SupabaseClient; onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
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
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        if (data.session) onSession(data.session);
        setMessage('Check your inbox to verify your email, then return here and sign in to continue.');
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

  return (
    <section className="onboarding-card" aria-labelledby="account-title">
      <Progress current={1} />
      <p className="eyebrow">Step 1 of 3</p>
      <h1 id="account-title">Start with your email.</h1>
      <p className="section-copy">We’ll use a verified email to protect school access. No payments, live location or document uploads are involved.</p>
      <form className="stack-form" onSubmit={submit}>
        <label>Email address<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}</PrimaryButton>
      </form>
      {message && <Notice tone={message.startsWith('Check') ? 'teal' : 'red'}>{message}</Notice>}
      <button className="text-button text-button--lower" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setMessage(null); }}>
        {mode === 'signup' ? 'Already verified? Sign in' : 'Need an account? Create one'}
      </button>
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

function ConsentStep({ client, status, onRefresh, invitationToken }: { client: SupabaseClient; status: OnboardingStatus; onRefresh: () => Promise<void>; invitationToken: string | null }) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allChecked = status.consentDocuments.every((document) => checked[document.id] || status.acceptedConsentDocumentIds.includes(document.id));

  async function acceptAll() {
    if (!allChecked) return;
    setBusy(true);
    setError(null);
    try {
      await Promise.all(status.consentDocuments
        .filter((document) => !status.acceptedConsentDocumentIds.includes(document.id))
        .map((document) => onboardingApi.acceptConsent(client, document.document_type, document.version)));
      if (invitationToken) await onboardingApi.claimInvitation(client, invitationToken);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'We could not save your consent.');
    } finally {
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
      {error && <Notice tone="red">{error}</Notice>}
      <PrimaryButton disabled={!allChecked || busy} onClick={() => void acceptAll()}>{busy ? 'Saving…' : invitationToken ? 'Accept and join waitlist' : 'Accept and continue'}</PrimaryButton>
    </section>
  );
}

function SchoolStep({ client, onRefresh }: { client: SupabaseClient; onRefresh: () => Promise<void> }) {
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [selectedSchool, setSelectedSchool] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void onboardingApi.schoolOptions(client).then((options) => {
      setSchools(options);
      if (options[0]) setSelectedSchool(options[0].id);
    }).catch(() => setError('School options are not available yet. Please try again soon.'));
  }, [client]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSchool) return;
    setBusy(true);
    setError(null);
    try {
      await onboardingApi.joinSchool(client, selectedSchool, code);
      await onRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That code could not be accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="school-title">
      <Progress current={2} />
      <p className="eyebrow">Step 2 of 3</p>
      <h1 id="school-title">Choose your sample school.</h1>
      <p className="section-copy">Each code has an expiry and a use limit. Five unsuccessful attempts are allowed in 15 minutes.</p>
      <form className="stack-form" onSubmit={submit}>
        <label>School<select required value={selectedSchool} onChange={(event) => setSelectedSchool(event.target.value)}>{schools.length === 0 ? <option>Loading sample schools…</option> : schools.map((school) => <option key={school.id} value={school.id}>{school.display_name}</option>)}</select></label>
        <label>School invite code<input required minLength={6} maxLength={128} value={code} onChange={(event) => setCode(event.target.value)} placeholder="Enter your code" autoCapitalize="characters" /></label>
        <PrimaryButton type="submit" disabled={busy || !selectedSchool}>{busy ? 'Checking…' : 'Join approval queue'}</PrimaryButton>
      </form>
      <p className="demo-hint"><strong>Demo only:</strong> Harbourview uses <code>HARBOUR-2026</code>; Rivergum uses <code>RIVERGUM-2026</code>. These are not real school codes.</p>
      {error && <Notice tone="red">{error}</Notice>}
    </section>
  );
}

function WaitingScreen() {
  return (
    <section className="onboarding-card centre-card" aria-labelledby="waiting-title">
      <div className="state-icon state-icon--amber" aria-hidden="true">⌛</div>
      <p className="eyebrow">Approval pending</p>
      <h1 id="waiting-title">You’re in the approval queue.</h1>
      <p className="section-copy">A school moderator will review your request within 24 business hours. Until then, school information and exchange features remain locked.</p>
      <Notice>Your request is private to your approval team.</Notice>
    </section>
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
    if (!status.membership || !declaration || !allChecks || (status.childCount === 0 && (!nickname || yearLevel === ''))) return;
    setBusy(true);
    setError(null);
    try {
      await onboardingApi.saveProfile(client, displayName);
      if (status.childCount === 0) await onboardingApi.addChild(client, status.membership.id, nickname, Number(yearLevel));
      await onboardingApi.signSafetyDeclaration(client, status.membership.id, declaration.id);
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

function Onboarding({ appName, client, session, invitationToken, onSignOut }: { appName: string; client: SupabaseClient; session: Session; invitationToken: string | null; onSignOut: () => void }) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModeration, setShowModeration] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setStatus(await onboardingApi.status(client)); } catch (reason) { setError(reason instanceof Error ? reason.message : 'We could not load your onboarding status.'); } finally { setLoading(false); }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh, session.access_token]);

  if (!session.user.email_confirmed_at) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><EmailVerificationScreen email={session.user.email} /></>;
  if (loading) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><section className="onboarding-card centre-card"><p className="section-copy">Checking your secure onboarding status…</p></section></>;
  if (error || !status) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><section className="onboarding-card centre-card"><h1>We’re preparing your onboarding.</h1><Notice tone="red">{error ?? 'Please refresh and try again.'}</Notice><button className="secondary-button" onClick={() => void refresh()}>Try again</button></section></>;
  if (showModeration) return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} /><ModeratorPanel client={client} onClose={() => setShowModeration(false)} onRefresh={refresh} schoolId={status?.roles.find((role) => role.role === 'moderator')?.school_id ?? null} /></>;

  const state = onboardingAccessState({
    membershipStatus: status.membership?.status ?? null,
    hasCurrentConsents: status.consentDocuments.length > 0 && status.consentDocuments.every((document) => status.acceptedConsentDocumentIds.includes(document.id)),
    hasChild: status.childCount > 0,
    hasSafetyDeclaration: Boolean(status.currentSafetyDeclaration && status.safetyDeclarationIds.includes(status.currentSafetyDeclaration.id)),
  });

  const canModerate = status.roles.some((role) => role.role === 'moderator' || role.role === 'admin');
  return <><AppHeader appName={appName} signedIn onSignOut={onSignOut} />{state === 'consent' && <ConsentStep client={client} status={status} onRefresh={refresh} invitationToken={invitationToken} />}{state === 'school' && <SchoolStep client={client} onRefresh={refresh} />}{state === 'waiting' && <WaitingScreen />}{state === 'profile-and-safety' && <FinalSafetyStep client={client} status={status} onRefresh={refresh} />}{state === 'ready' && <ScheduleHub client={client} userId={session.user.id} onModeration={canModerate ? () => setShowModeration(true) : null} />}{(state === 'rejected' || state === 'suspended') && <RejectedOrSuspended state={state} />}</>;
}

export default function App() {
  const [runtimeConfig, setRuntimeConfig] = useState<BrowserRuntimeConfig>(fallbackRuntimeConfig);
  const [configLoading, setConfigLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [invitationState, setInvitationState] = useState<'idle' | 'opened' | 'unavailable'>('idle');
  const client = useMemo(() => createBrowserSupabaseClient(runtimeConfig), [runtimeConfig]);
  const invitationToken = useMemo(() => new URLSearchParams(window.location.search).get('invite'), []);

  useEffect(() => { void fetchRuntimeConfig().then((config) => { setRuntimeConfig(config); setConfigLoading(false); document.title = config.appName; }); }, []);
  useEffect(() => {
    if (!client) return;
    void client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, [client]);
  useEffect(() => {
    if (!invitationToken) return;
    void openInvitationLink(invitationToken).then((result) => setInvitationState(result));
  }, [invitationToken]);

  const signOut = () => { if (client) void client.auth.signOut(); setSession(null); };

  if (configLoading) return <main className="app-shell"><AppHeader appName={runtimeConfig.appName} signedIn={false} /><section className="onboarding-card centre-card"><p className="section-copy">Preparing secure onboarding…</p></section></main>;
  if (!client) return <main className="app-shell"><AppHeader appName={runtimeConfig.appName} signedIn={false} /><section className="onboarding-card centre-card"><p className="eyebrow">Set-up required</p><h1>Secure sign-up is being connected.</h1><p className="section-copy">The onboarding interface is ready, but the public Supabase configuration has not loaded yet.</p></section></main>;

  return (
    <main className="app-shell onboarding-shell">
      {invitationState === 'unavailable' && <Notice tone="red">This invitation link is unavailable. No school details were revealed.</Notice>}
      {!session ? <><AppHeader appName={runtimeConfig.appName} signedIn={false} /><AccountScreen client={client} onSession={setSession} /></> : <Onboarding appName={runtimeConfig.appName} client={client} session={session} invitationToken={invitationState === 'opened' ? invitationToken : null} onSignOut={signOut} />}
      <footer className="footer-note"><span>No payments</span><span aria-hidden="true">•</span><span>No live location tracking</span><span aria-hidden="true">•</span><span>Safety included</span></footer>
    </main>
  );
}
