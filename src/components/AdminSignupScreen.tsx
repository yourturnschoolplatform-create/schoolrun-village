import { useState, type FormEvent } from 'react';
import { registerAdminAccount } from '../lib/account-verification-api';

/**
 * Dedicated /admin/signup route. Secured by ADMIN_SECRET_KEY on the server.
 */
export function AdminSignupScreen() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'teal' | 'red'>('teal');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await registerAdminAccount({
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        adminSecret: adminSecret.trim(),
      });
      setTone('teal');
      setMessage(result.message);
      window.setTimeout(() => {
        window.location.assign('/');
      }, 1200);
    } catch (error) {
      setTone('red');
      setMessage(error instanceof Error ? error.message : 'Admin signup failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="onboarding-card" aria-labelledby="admin-signup-title">
      <p className="eyebrow">Admin registration</p>
      <h1 id="admin-signup-title">Create a SchoolRun Village admin.</h1>
      <p className="section-copy">
        This route is protected by an admin secret. Approved admins can verify parent sign-ups
        from the Admin Dashboard.
      </p>
      <form className="stack-form" onSubmit={(event) => void submit(event)}>
        <label>Full name<input required minLength={2} maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>Work email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Admin secret key<input type="password" required autoComplete="off" value={adminSecret} onChange={(event) => setAdminSecret(event.target.value)} /></label>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create admin account'}</button>
      </form>
      {message ? <p className={`notice notice--${tone}`} role={tone === 'red' ? 'alert' : 'status'}>{message}</p> : null}
      <a className="text-button text-button--lower" href="/">Back to parent sign-in</a>
    </section>
  );
}
