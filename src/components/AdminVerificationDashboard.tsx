import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PendingAccountVerification } from '../../shared/account-verification';
import { accountVerificationApi } from '../lib/account-verification-api';

/**
 * /admin/dashboard — list pending parent verifications and approve/reject.
 */
export function AdminVerificationDashboard({
  client,
  onBack,
  onToast,
}: {
  client: SupabaseClient;
  onBack: () => void;
  onToast?: (message: string) => void;
}) {
  const [schoolId, setSchoolId] = useState('');
  const [users, setUsers] = useState<PendingAccountVerification[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await accountVerificationApi.listPending(client, schoolId.trim() || null);
      setUsers(result.users);
      setMessage(null);
    } catch {
      setMessage('Pending verifications could not be loaded. Confirm you are signed in as an admin.');
    } finally {
      setLoading(false);
    }
  }, [client, schoolId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(userId: string, decision: 'approve' | 'reject') {
    setBusyId(userId);
    try {
      await accountVerificationApi.verifyUser(client, userId, decision);
      onToast?.(
        decision === 'approve'
          ? 'Parent approved — welcome access unlocked.'
          : 'Parent signup rejected.',
      );
      await refresh();
    } catch {
      setMessage('That verification action could not be completed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="admin-verification-dashboard" aria-labelledby="admin-verify-title">
      <button className="text-button" type="button" onClick={onBack}>Back</button>
      <div className="feed-section__intro">
        <p className="eyebrow">Admin portal</p>
        <h1 id="admin-verify-title">Pending parent verification</h1>
        <p className="section-copy">
          Filter by school, then Approve or Reject. Approved parents receive a welcome notice and
          can use Instant Pickup &amp; Marketplace after onboarding.
        </p>
      </div>

      <form
        className="stack-form admin-verification-dashboard__filter"
        onSubmit={(event) => {
          event.preventDefault();
          void refresh();
        }}
      >
        <label>
          School filter (optional UUID)
          <input
            value={schoolId}
            onChange={(event) => setSchoolId(event.target.value)}
            placeholder="Leave blank for all schools"
          />
        </label>
        <button className="secondary-button" type="submit" disabled={loading}>Refresh queue</button>
      </form>

      {message ? <p className="notice notice--red" role="alert">{message}</p> : null}

      {loading ? (
        <p className="section-copy">Loading pending parents…</p>
      ) : users.length === 0 ? (
        <p className="notice notice--teal" role="status">No parents are waiting for verification.</p>
      ) : (
        <ul className="queue-list">
          {users.map((user) => (
            <li key={user.userId}>
              <span>
                <strong>{user.displayName}</strong>
                <small className="admin-verification-dashboard__meta">
                  {[user.suburb, user.schoolLabel].filter(Boolean).join(' · ') || 'School details pending'}
                  {user.invitationCodePresent ? ' · invite code provided' : ''}
                </small>
              </span>
              <span className="queue-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busyId === user.userId}
                  onClick={() => void decide(user.userId, 'approve')}
                >
                  Approve
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busyId === user.userId}
                  onClick={() => void decide(user.userId, 'reject')}
                >
                  Reject
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
