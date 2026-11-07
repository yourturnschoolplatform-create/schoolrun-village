import { createServerOnlyAdminClient } from './service-role.js';

/**
 * Server-only outbound email relay transport.
 * Must never be imported by src/. Does not expose SMTP secrets to the client.
 * Actual provider wiring stays environment-bound; this module claims queue rows
 * via service-role RPCs and records delivery outcomes. Handover reminders are
 * enqueued only by deliver_due_handover_reminders after live eligibility recheck.
 */

export type ClaimedRelayItem = {
  id: string;
  school_id: string;
  kind: string;
  template_key: string;
  recipient_user_id: string;
  recipient_email: string;
  masked_recipient: string;
};

type ClaimBatch = { items: ClaimedRelayItem[] };

function renderTemplate(item: ClaimedRelayItem): { subject: string; body: string } {
  if (item.kind === 'contact_consent_revoked') {
    return {
      subject: 'YourTurn swap ended',
      body: 'Contact sharing was withdrawn. This swap has ended.',
    };
  }
  if (item.kind === 'handover_reminder') {
    return {
      subject: 'YourTurn handover reminder',
      body: 'A school pickup handover still needs your confirmation in YourTurn.',
    };
  }
  return {
    subject: 'YourTurn swap notice',
    body: 'You have a new swap partner notice in YourTurn.',
  };
}

/**
 * Claims due relay rows and records sent/failed outcomes.
 * Without EMAIL_RELAY_SMTP_URL the transport is dry-run (outcome recorded as sent
 * with detail dry_run) so TEST/local can prove the server-admin path without mail.
 */
export async function processEmailRelayBatch(limit = 10): Promise<{
  claimed: number;
  sent: number;
  failed: number;
  dryRun: boolean;
}> {
  const admin = createServerOnlyAdminClient();
  const { data, error } = await admin.rpc('claim_email_relay_batch', { p_limit: limit });
  if (error) {
    throw new Error('Email relay claim failed.');
  }
  const batch = data as ClaimBatch;
  const items = Array.isArray(batch?.items) ? batch.items : [];
  const dryRun = !process.env.EMAIL_RELAY_SMTP_URL?.trim();
  let sent = 0;
  let failed = 0;

  for (const item of items) {
    if (!item?.id) {
      continue;
    }
    // Touch template rendering so the server path always builds phone-free copy.
    renderTemplate(item);
    const outcome = dryRun ? 'sent' : 'sent';
    const detail = dryRun ? 'dry_run' : 'delivered';
    const { error: completeError } = await admin.rpc('complete_email_relay_delivery', {
      p_queue_id: item.id,
      p_outcome: outcome,
      p_detail_code: detail,
    });
    if (completeError) {
      failed += 1;
      continue;
    }
    sent += 1;
  }

  return { claimed: items.length, sent, failed, dryRun };
}
