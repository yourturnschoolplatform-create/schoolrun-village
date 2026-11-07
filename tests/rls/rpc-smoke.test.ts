import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
const north = '20000000-0000-0000-0000-000000000001';
const northSchool = '10000000-0000-0000-0000-000000000001';
const northMembership = '00000000-0000-0000-0000-000000000000';
const swap = '70000000-0000-0000-0000-000000000001';
const instance = '50000000-0000-0000-0000-000000000001';
const pattern = '40000000-0000-0000-0000-000000000001';
const resolution = /function [^\n]*does not exist|search_path|schema [^\n]*does not exist|gen_random_bytes|gen_salt|digest\(|crypt\(/i;

const allowlist = JSON.parse(readFileSync('db/function_allowlist.json', 'utf8')) as {
  authenticated: Array<{ name: string }>;
  internal?: Array<{ name: string }>;
};
const functionNames = [...allowlist.authenticated, ...(allowlist.internal ?? [])].map((entry) => entry.name);

const calls: Record<string, string> = {
  accept_current_consent: "select public.accept_current_consent('terms', 1)",
  add_onboarding_child: `select public.add_onboarding_child('${northMembership}'::uuid, 'Smoke'::text, 3::smallint)`,
  approve_school_membership: `select public.approve_school_membership('${northMembership}'::uuid)`,
  block_match_user: `select public.block_match_user('${north}'::uuid)`,
  cancel_availability_instance: `select public.cancel_availability_instance('${instance}'::uuid)`,
  cancel_availability_pattern: `select public.cancel_availability_pattern('${pattern}'::uuid)`,
  claim_household_link_invitation: "select public.claim_household_link_invitation(repeat('0', 48))",
  claim_school_invitation: "select public.claim_school_invitation(repeat('0', 48))",
  confirm_household_link: `select public.confirm_household_link('${northSchool}'::uuid)`,
  create_availability_pattern: `select public.create_availability_pattern('${northSchool}'::uuid, 'can_help'::text, 'pickup'::text, 1::smallint, '08:00'::time, '08:30'::time, 'Carlton'::text, 1::smallint, current_date)`,
  create_household_link_invitation: 'select public.create_household_link_invitation()',
  create_school_invitation: `select * from public.create_school_invitation('${northSchool}'::uuid)`,
  expire_my_swap_proposals: 'select public.expire_my_swap_proposals()',
  get_accepted_swap_children: `select * from public.get_accepted_swap_children('${swap}'::uuid)`,
  get_my_ledger: 'select public.get_my_ledger()',
  get_my_trust: 'select public.get_my_trust()',
  get_peer_trust_band: `select public.get_peer_trust_band('${north}'::uuid)`,
  grant_contact_sharing: `select public.grant_contact_sharing('${swap}'::uuid, 'smoke'::text, '{}'::uuid[])`,
  revoke_contact_sharing: `select public.revoke_contact_sharing('${swap}'::uuid)`,
  get_shared_contact: `select public.get_shared_contact('${swap}'::uuid, '${northMembership}'::uuid)`,
  confirm_pickup_done: `select public.confirm_pickup_done('${instance}'::uuid)`,
  confirm_child_arrived: `select public.confirm_child_arrived('${instance}'::uuid)`,
  refresh_my_handover_reminders: 'select public.refresh_my_handover_reminders()',
  get_reciprocal_match_candidates: 'select * from public.get_reciprocal_match_candidates(false)',
  has_current_onboarding_consents: `select public.has_current_onboarding_consents('${north}'::uuid)`,
  is_admin: 'select public.is_admin()',
  is_approved_school_member: `select public.is_approved_school_member('${northSchool}'::uuid)`,
  is_member: `select public.is_member('${northSchool}'::uuid)`,
  is_moderator: `select public.is_moderator('${northSchool}'::uuid)`,
  is_same_household: `select public.is_same_household('${north}'::uuid, '${north}'::uuid)`,
  is_verified_email_user: 'select public.is_verified_email_user()',
  list_my_swaps: 'select * from public.list_my_swaps()',
  list_onboarding_school_options: 'select * from public.list_onboarding_school_options()',
  list_pending_school_memberships: 'select * from public.list_pending_school_memberships()',
  open_school_invitation: "select public.open_school_invitation(repeat('0', 48))",
  propose_reciprocal_swap: `select public.propose_reciprocal_swap('${instance}'::uuid, '${instance}'::uuid, '${instance}'::uuid, '${instance}'::uuid, false)`,
  record_email_verified_event: 'select public.record_email_verified_event()',
  record_first_match_viewed: 'select public.record_first_match_viewed()',
  redeem_school_invite_code: `select public.redeem_school_invite_code('${northSchool}'::uuid, 'SMOKE-CODE')`,
  refresh_my_availability_instances: 'select public.refresh_my_availability_instances()',
  request_household_link: `select public.request_household_link('${north}'::uuid)`,
  school_local_today: `select public.school_local_today('${northSchool}'::uuid)`,
  set_school_membership_review_state: `select public.set_school_membership_review_state('${northMembership}'::uuid, 'rejected')`,
  sign_onboarding_safety_declaration: `select public.sign_onboarding_safety_declaration('${northMembership}'::uuid, '${northSchool}'::uuid)`,
  transition_swap_proposal: `select public.transition_swap_proposal('${swap}'::uuid, 'withdraw')`,
  update_availability_pattern: `select public.update_availability_pattern('${pattern}'::uuid, 'can_help'::text, 'pickup'::text, 1::smallint, '08:00'::time, '08:30'::time, 'Carlton'::text, 1::smallint, current_date)`,
  update_onboarding_parent_profile: "select public.update_onboarding_parent_profile('Smoke parent')",
  guard_swap_ledger_entry: 'select public.guard_swap_ledger_entry()',
  record_completed_swap_leg: 'select public.record_completed_swap_leg()',
  guard_contact_history: 'select public.guard_contact_history()',
  contact_member_is_active: `select public.contact_member_is_active('${northMembership}'::uuid, '${northSchool}'::uuid)`,
  guard_handover_history: 'select public.guard_handover_history()',
  record_leg_confirmation: `select public.record_leg_confirmation('${instance}'::uuid, 'pickup_done')`,
  maybe_record_handover_reminder: `select public.maybe_record_handover_reminder('${instance}'::uuid)`,
  enqueue_due_handover_reminders: 'select public.enqueue_due_handover_reminders()',
  guard_trust_score_events: 'select public.guard_trust_score_events()',
  apply_trust_score_delta: `select public.apply_trust_score_delta('${north}'::uuid, '${northSchool}'::uuid, 1::smallint, 'completed_trip'::text, 'smoke'::text, '${instance}'::uuid)`,
  trust_band_for_user: `select public.trust_band_for_user('${north}'::uuid)`,
  trust_published_policy: `select public.trust_published_policy('${northSchool}'::uuid)`,
  trust_policy_delta: `select public.trust_policy_delta('${northSchool}'::uuid, 'completed_trip')`,
  trust_hours_until_instance: `select public.trust_hours_until_instance('${northSchool}'::uuid, current_date, '15:00'::time, now())`,
  trust_cancel_reason_for_hours: 'select public.trust_cancel_reason_for_hours(1.5)',
  post_trust_completed_trip: 'select public.post_trust_completed_trip()',
  post_trust_schedule_cancellation: 'select public.post_trust_schedule_cancellation()',
  post_trust_swap_cancellation: 'select public.post_trust_swap_cancellation()',
  post_trust_urgent_cover_for_swap: `select public.post_trust_urgent_cover_for_swap('${swap}'::uuid)`,
  list_my_trust_cases: 'select public.list_my_trust_cases()',
  list_school_trust_queue: 'select public.list_school_trust_queue()',
  report_no_show: `select public.report_no_show('${instance}'::uuid, false)`,
  dispute_trust_report: `select public.dispute_trust_report('${instance}'::uuid)`,
  report_false_report: `select public.report_false_report('${instance}'::uuid)`,
  resolve_trust_report: `select public.resolve_trust_report('${instance}'::uuid, 'confirm')`,
  place_safety_hold: `select public.place_safety_hold('${north}'::uuid)`,
  resolve_safety_hold: `select public.resolve_safety_hold('${instance}'::uuid, 'lift')`,
  file_trust_appeal: `select public.file_trust_appeal('safety_hold', '${instance}'::uuid)`,
  resolve_trust_appeal: `select public.resolve_trust_appeal('${instance}'::uuid, 'dismiss')`,
  user_has_active_safety_hold: `select public.user_has_active_safety_hold('${north}'::uuid, '${northSchool}'::uuid)`,
  guard_trust_trip_penalties: 'select public.guard_trust_trip_penalties()',
  apply_confirmed_no_show_effects: `select public.apply_confirmed_no_show_effects('${instance}'::uuid)`,
  apply_confirmed_false_report_effects: `select public.apply_confirmed_false_report_effects('${instance}'::uuid)`,
  sweep_provisional_trust_reports: 'select public.sweep_provisional_trust_reports()',
  generate_school_notice: `select public.generate_school_notice('${instance}'::uuid)`,
  get_school_notice: `select public.get_school_notice('${instance}'::uuid)`,
  list_my_school_notices: 'select public.list_my_school_notices()',
  list_school_notice_moderation_queue: 'select public.list_school_notice_moderation_queue()',
  withdraw_school_notice: `select public.withdraw_school_notice('${instance}'::uuid)`,
  mask_email_address: "select public.mask_email_address('parent@example.invalid')",
  get_email_relay_delivery_policy: 'select public.get_email_relay_delivery_policy()',
  enqueue_email_relay: `select public.enqueue_email_relay('${swap}'::uuid, 'swap_partner_notice', '${north}'::uuid)`,
  list_my_email_relay_queue: 'select public.list_my_email_relay_queue()',
  list_school_email_relay_queue: 'select public.list_school_email_relay_queue()',
  get_retention_purge_policy: 'select public.get_retention_purge_policy()',
  post_running_late_notice: `select public.post_running_late_notice('${instance}'::uuid)`,
  get_running_late_notice: `select public.get_running_late_notice('${instance}'::uuid)`,
  list_my_running_late_notices: 'select public.list_my_running_late_notices()',
  guard_school_notice_history: 'select public.guard_school_notice_history()',
  school_notice_year_label: 'select public.school_notice_year_label(array[3]::smallint[])',
  school_notice_build_body: "select public.school_notice_build_body(current_date, array[3]::smallint[], 'Collector')",
  school_notice_json: `select public.school_notice_json(null::public.school_notices)`,
  log_school_notice_access: `select public.log_school_notice_access('${instance}'::uuid, '${northSchool}'::uuid, 'viewed')`,
  email_relay_policy_definition_is_valid: "select public.email_relay_policy_definition_is_valid('{}'::jsonb)",
  guard_email_relay_policy: 'select public.guard_email_relay_policy()',
  guard_email_relay_history: 'select public.guard_email_relay_history()',
  email_relay_published_policy: `select public.email_relay_published_policy('${northSchool}'::uuid)`,
  email_relay_kind_allowed: `select public.email_relay_kind_allowed('${northSchool}'::uuid, 'swap_partner_notice')`,
  email_relay_queue_json: `select public.email_relay_queue_json(null::public.email_relay_queue)`,
  claim_email_relay_batch: 'select public.claim_email_relay_batch(1)',
  complete_email_relay_delivery: `select public.complete_email_relay_delivery('${instance}'::uuid, 'sent', null)`,
  guard_departure_check_logs: 'select public.guard_departure_check_logs()',
  guard_retention_purge_runs: 'select public.guard_retention_purge_runs()',
  swap_retention_ended_at: `select public.swap_retention_ended_at(null::public.swap_proposals)`,
  purge_expired_disclosure_retention: 'select public.purge_expired_disclosure_retention()',
  guard_running_late_notices: 'select public.guard_running_late_notices()',
  running_late_pickup_window_start: `select public.running_late_pickup_window_start(null::public.swap_legs)`,
  running_late_notice_json: `select public.running_late_notice_json(null::public.running_late_notices)`,
  post_trust_late_arrival: 'select public.post_trust_late_arrival()',
};

describe('allowlist RPC call coverage', () => {
  it('maps every allowlisted function and no extra call', () => {
    expect(functionNames.filter((name) => !(name in calls))).toEqual([]);
    expect(Object.keys(calls).filter((name) => !functionNames.includes(name))).toEqual([]);
    expect(new Set(functionNames).size).toBe(functionNames.length);
  });
});

const run = url ? describe : describe.skip;

run('allowlist-driven authenticated RPC smoke', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
  });

  afterAll(async () => { await client.end(); });

  it.each(functionNames)('%s', async (name) => {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query('set local row_security = on');
      await client.query(
        `select set_config('request.jwt.claims', $1, true),
          set_config('request.jwt.claim.sub', $2, true),
          set_config('request.jwt.claim.role', 'authenticated', true)`,
        [JSON.stringify({ sub: north, role: 'authenticated', aud: 'authenticated' }), north],
      );
      const identity = await client.query<{
        role: string; row_security: string; rolsuper: boolean; rolbypassrls: boolean; correct_subject: boolean;
      }>(`select current_user::text as role, current_setting('row_security') as row_security,
        r.rolsuper, r.rolbypassrls, auth.uid() = $1::uuid as correct_subject
        from pg_catalog.pg_roles r where r.rolname = current_user`, [north]);
      expect(identity.rows).toEqual([{
        role: 'authenticated', row_security: 'on', rolsuper: false, rolbypassrls: false, correct_subject: true,
      }]);
      let outcome = 'pass';
      try { await client.query(calls[name]); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const match = message.match(resolution);
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
        outcome = match ? `fail ${code} ${match[0]}` : `pass ${code}`;
      }
      expect(outcome.startsWith('fail') ? outcome : 'pass').toBe('pass');
    } finally { await client.query('rollback'); }
  }, 30_000);
});

if (!url) {
  describe('allowlist RPC smoke configuration', () => {
    it('reports the dedicated test database requirement instead of simulating a pass', () => {
      expect(url).toBeUndefined();
    });
  });
}
