import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminApi,
  type AdminAuditAction,
  type AdminSafetyHold,
  type AdminSuspendedUser,
} from '../lib/admin-api';

/**
 * Global-admin moderation dashboard.
 * Uses JWT /api/admin routes (not direct client.rpc) and phone-free projections
 * from list_admin_* / admin_* RPCs (no admin_email, no free-text reason columns).
 */
export function AdminModerationPanel({
  client,
  onClose,
}: {
  client: SupabaseClient;
  onClose?: () => void;
}) {
  const id = useId();
  const [actions, setActions] = useState<AdminAuditAction[]>([]);
  const [holds, setHolds] = useState<AdminSafetyHold[]>([]);
  const [suspended, setSuspended] = useState<AdminSuspendedUser[]>([]);
  const [targetUserId, setTargetUserId] = useState('');
  const [reasonCode, setReasonCode] = useState('policy_breach');
  const [statusMessage, setStatusMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refreshData = useCallback(async () => {
    setLoading(true);
    try {
      const [auditResult, holdsResult, suspendedResult] = await Promise.all([
        adminApi.listAuditActions(client, 40),
        adminApi.listSafetyHolds(client),
        adminApi.listSuspendedUsers(client),
      ]);
      setActions(auditResult.actions);
      setHolds(holdsResult.holds);
      setSuspended(suspendedResult.users);
      setStatusMessage('');
    } catch {
      setStatusMessage('Admin moderation data could not be loaded. Global administrator access is required.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await work();
      await refreshData();
      setStatusMessage(success);
    } catch {
      setStatusMessage('That admin action could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  function handleSuspend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userId = targetUserId.trim();
    const code = reasonCode.trim();
    if (!userId || !code) return;
    void run(async () => {
      await adminApi.suspendUser(client, userId, code);
      setTargetUserId('');
      setReasonCode('policy_breach');
    }, 'User suspended.');
  }

  return (
    <section className="onboarding-card" aria-labelledby={`${id}-title`}>
      {onClose && (
        <button className="text-button" type="button" onClick={onClose}>
          Back to account
        </button>
      )}
      <p className="eyebrow">Global administrator</p>
      <h1 id={`${id}-title`}>Admin moderation</h1>
      <p className="section-copy">
        Platform suspend and safety-hold tools. No phones, emails, or child nicknames are shown here.
      </p>

      {statusMessage && <p className="notice notice--teal" role="status">{statusMessage}</p>}
      {loading ? (
        <p className="section-copy" role="status">Loading admin dashboard…</p>
      ) : (
        <>
          <section className="pattern-panel" aria-labelledby={`${id}-suspend`}>
            <h2 id={`${id}-suspend`}>Suspend user account</h2>
            <form className="stack-form" onSubmit={handleSuspend}>
              <label>
                User ID
                <input
                  type="text"
                  value={targetUserId}
                  onChange={(event) => setTargetUserId(event.target.value)}
                  placeholder="uuid"
                  required
                  pattern="[0-9a-fA-F-]{36}"
                  autoComplete="off"
                />
              </label>
              <label>
                Reason code
                <input
                  type="text"
                  value={reasonCode}
                  onChange={(event) => setReasonCode(event.target.value)}
                  placeholder="policy_breach"
                  required
                  pattern="[a-z][a-z0-9_]{2,60}"
                  autoComplete="off"
                />
              </label>
              <button className="primary-button" type="submit" disabled={busy}>
                Suspend
              </button>
            </form>
          </section>

          <section className="pattern-panel" aria-labelledby={`${id}-holds`}>
            <h2 id={`${id}-holds`}>Active safety holds ({holds.length})</h2>
            {holds.length === 0 ? (
              <p className="section-copy">No active safety holds.</p>
            ) : (
              <ul className="queue-list">
                {holds.map((hold) => (
                  <li key={hold.id}>
                    <span>
                      <strong>{hold.subject_user_id}</strong>
                      <small>
                        {hold.reason_code} · school {hold.school_id} ·{' '}
                        {new Date(hold.placed_at).toLocaleString('en-AU')}
                      </small>
                    </span>
                    <span className="queue-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void run(
                          () => adminApi.resolveSafetyHold(client, hold.subject_user_id, 'lift', 'admin_review').then(() => undefined),
                          'Safety hold lifted.',
                        )}
                      >
                        Lift hold
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void run(
                          () => adminApi.resolveSafetyHold(client, hold.subject_user_id, 'uphold', 'admin_review').then(() => undefined),
                          'Safety hold upheld.',
                        )}
                      >
                        Uphold
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pattern-panel" aria-labelledby={`${id}-suspended`}>
            <h2 id={`${id}-suspended`}>Suspended users ({suspended.length})</h2>
            {suspended.length === 0 ? (
              <p className="section-copy">No platform-suspended users.</p>
            ) : (
              <ul className="queue-list">
                {suspended.map((user) => (
                  <li key={user.user_id}>
                    <span>
                      <strong>{user.user_id}</strong>
                      <small>Updated {new Date(user.updated_at).toLocaleString('en-AU')}</small>
                    </span>
                    <span className="queue-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        onClick={() => void run(
                          () => adminApi.unsuspendUser(client, user.user_id, 'admin_manual_lift').then(() => undefined),
                          'Suspension lifted.',
                        )}
                      >
                        Unsuspend
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pattern-panel" aria-labelledby={`${id}-audit`}>
            <h2 id={`${id}-audit`}>Recent moderation audit</h2>
            {actions.length === 0 ? (
              <p className="section-copy">No admin audit actions yet.</p>
            ) : (
              <ul className="pattern-list">
                {actions.map((entry) => (
                  <li className="pattern-card" key={entry.id}>
                    <span>
                      <strong>{entry.action}</strong>
                      <time dateTime={entry.occurred_at}>
                        {new Date(entry.occurred_at).toLocaleString('en-AU')}
                      </time>
                    </span>
                    <p className="section-copy">
                      actor {entry.actor_id ?? 'unknown'}
                      {entry.entity_id ? ` · ${entry.entity_type} ${entry.entity_id}` : ''}
                      {entry.payload.reason_code ? ` · ${entry.payload.reason_code}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
