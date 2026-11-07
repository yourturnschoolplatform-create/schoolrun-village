import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const foundationTables = [
  'schools', 'school_configs', 'profiles', 'school_memberships', 'role_assignments',
  'audit_logs', 'analytics_events', 'feature_flags', 'trust_policy_versions',
  'consent_documents', 'consent_acceptances', 'child_profiles', 'safety_declaration_versions',
  'safety_declarations', 'school_invite_codes', 'school_invite_attempts', 'school_invitations',
  'household_links', 'household_link_invitations', 'school_calendar_periods', 'availability_patterns', 'availability_instances',
  'schedule_cancellation_events', 'match_blocks', 'swap_proposals', 'swap_legs', 'swap_ledger_entries',
  'contact_consents', 'contact_consent_backups', 'swap_cancellation_events', 'swap_contact_notifications',
  'swap_leg_confirmations', 'swap_leg_reminders', 'trust_score_events',
  'trust_incident_reports', 'trust_safety_holds', 'trust_appeals', 'trust_trip_penalties',
  'school_notices', 'school_notice_access_logs',
  'email_relay_delivery_policies', 'email_relay_queue', 'email_relay_delivery_events',
  'departure_check_logs', 'retention_purge_runs',
];
const migrations = await Promise.all([
  readFile(resolve('db/migrations/0001_day1_foundation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0002_day2_enum_values.sql'), 'utf8'),
  readFile(resolve('db/migrations/0003_day2_onboarding_and_hardening.sql'), 'utf8'),
  readFile(resolve('db/migrations/0005_day2_security_remediation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0006_day3_households_schedules_calendar.sql'), 'utf8'),
  readFile(resolve('db/migrations/0008_day4_reciprocal_matching_swaps.sql'), 'utf8'),
  readFile(resolve('db/migrations/0009_day4_matching_remediation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0010_day4_swap_integrity_remediation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0018_day5_trip_count_ledger.sql'), 'utf8'),
  readFile(resolve('db/migrations/0019_day5_contact_consents.sql'), 'utf8'),
  readFile(resolve('db/migrations/0020_day5_two_step_handover.sql'), 'utf8'),
  readFile(resolve('db/migrations/0027_day6_trust_score_engine.sql'), 'utf8'),
  readFile(resolve('db/migrations/0032_day6_trust_holds_appeals.sql'), 'utf8'),
  readFile(resolve('db/migrations/0033_day7_school_notices.sql'), 'utf8'),
  readFile(resolve('db/migrations/0035_day7_email_relay_queue.sql'), 'utf8'),
  readFile(resolve('db/migrations/0037_day7_retention_purge.sql'), 'utf8'),
]);
const sql = migrations.join('\n').replace(/\r\n/g, '\n');
const day3Sql = (await readFile(resolve('db/migrations/0006_day3_households_schedules_calendar.sql'), 'utf8')).replace(/\r\n/g, '\n');
const day6TrustSql = (await readFile(resolve('db/migrations/0027_day6_trust_score_engine.sql'), 'utf8')).replace(/\r\n/g, '\n');

describe('Day 1 through Day 4 RLS migration contract', () => {
  it.each(foundationTables)('enables RLS for %s', (table) => {
    expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
  });

  it('provides safe security-definer membership and role helpers', () => {
    for (const helper of ['is_member', 'is_moderator', 'is_admin']) {
      expect(sql).toMatch(new RegExp(`function public\\.${helper}`, 'i'));
    }
    const functionBlocks = sql.match(/create or replace function public\.(?:is_member|is_admin|is_moderator)[\s\S]*?\$\$;/gi) ?? [];
    expect(functionBlocks.length).toBeGreaterThanOrEqual(3);
    for (const block of functionBlocks) {
      expect(block).toMatch(/security definer/i);
      expect(block).toMatch(/set search_path = public/i);
    }
  });

  it('makes audit logs append-only with an allowlisted non-personal payload', () => {
    expect(sql).toMatch(/before update or delete on public\.audit_logs/i);
    expect(sql).toMatch(/audit_logs are append-only/i);
    expect(sql).toMatch(/audit_payload_is_safe/i);
    expect(sql).toMatch(/grant select on public\.audit_logs to authenticated/i);
    expect(sql).not.toMatch(/grant\s+[^;]*insert[^;]*on public\.audit_logs to authenticated/i);
  });

  it('allows only the required IDs-only analytics events and no direct client insert', () => {
    for (const eventId of ['signed_up', 'email_verified', 'school_joined', 'approved', 'child_added', 'declaration_signed', 'invite_sent', 'invite_joined']) {
      expect(sql).toContain(`'${eventId}'`);
    }
    expect(sql).toMatch(/drop column if exists properties/i);
    expect(sql).toMatch(/revoke insert on public\.analytics_events from authenticated/i);
    expect(sql).toMatch(/record_email_verified_event/i);
  });

  it('uses explicit child and safety columns rather than a free-form membership declaration', () => {
    expect(sql).toMatch(/drop column if exists self_declaration/i);
    expect(sql).toMatch(/create table if not exists public\.child_profiles/i);
    expect(sql).toMatch(/nickname text not null/i);
    expect(sql).toMatch(/year_level smallint not null/i);
    expect(sql).toMatch(/create table if not exists public\.safety_declarations/i);
    expect(sql).toMatch(/licence_confirmed boolean not null/i);
    expect(sql).toMatch(/insurance_confirmed boolean not null/i);
    expect(sql).toMatch(/child_restraints_confirmed boolean not null/i);
    expect(sql).toMatch(/pickup_rules_confirmed boolean not null/i);
  });

  it('protects hashed invite codes, rate-limit history and generic invitation opening', () => {
    expect(sql).toMatch(/create table if not exists public\.school_invite_codes/i);
    expect(sql).toMatch(/code_hash text not null/i);
    expect(sql).toMatch(/school_invite_attempts/i);
    expect(sql).toMatch(/interval '15 minutes'/i);
    expect(sql).toMatch(/>= 5/i);
    expect(sql).toMatch(/open_school_invitation/i);
    expect(sql).toMatch(/return 'opened'/i);
    expect(sql).not.toMatch(/create policy school_invite_codes/i);
    expect(sql).not.toMatch(/create policy school_invite_attempts/i);
  });

  it('makes published trust policy and active consent versions immutable', () => {
    expect(sql).toMatch(/published trust policies are immutable/i);
    expect(sql).toMatch(/published trust policies cannot be deleted/i);
    expect(sql).toMatch(/active consent documents are immutable/i);
    expect(sql).toMatch(/active consent documents cannot be deleted/i);
    expect(sql).toMatch(/trust_policy_versions_scope_version_idx/i);
  });

  it('commits new enum values before a following migration uses them', async () => {
    const enumMigration = await readFile(resolve('db/migrations/0002_day2_enum_values.sql'), 'utf8');
    expect(enumMigration).toMatch(/alter type public\.assignment_role add value if not exists 'parent';[\s\S]*commit;/i);
    expect(enumMigration).toMatch(/alter type public\.school_membership_status add value if not exists 'pending';/i);
  });

  it('removes raw membership updates and scopes published safety declarations to the approved school', () => {
    expect(sql).toMatch(/drop policy if exists memberships_moderator_or_admin_update/i);
    expect(sql).toMatch(/revoke update on public\.school_memberships from authenticated/i);
    expect(sql).toMatch(/safety_declaration_versions_select_own_published_scope/i);
    expect(sql).toMatch(/public\.is_approved_school_member\(school_id\)/i);
    expect(sql).toMatch(/published safety declarations are immutable/i);
    expect(sql).toMatch(/current safety declaration required/i);
    expect(sql).toMatch(/order by version\.published_at desc, version\.id desc limit 1/i);
  });

  it('ships two sample Victorian schools and a disabled school switcher', async () => {
    const seed = await readFile(resolve('db/migrations/0004_day2_sample_pilot_data.sql'), 'utf8');
    expect(seed).toContain('Sample Harbourview Primary School');
    expect(seed).toContain('Sample Rivergum Primary School');
    expect(seed).toMatch(/'school-switcher', null, false/i);
    expect(seed).toMatch(/crypt\('HARBOUR-2026'/);
    expect(seed).toMatch(/crypt\('RIVERGUM-2026'/);
  });

  it('protects confirmed household links and preserves a no-same-household matching helper', () => {
    expect(sql).toMatch(/create table if not exists public\.household_links/i);
    expect(sql).toMatch(/other_parent_confirmed_at timestamptz/i);
    expect(sql).toMatch(/create table if not exists public\.household_link_invitations/i);
    expect(sql).toMatch(/token_hash text not null unique/i);
    expect(sql).toMatch(/claim_household_link_invitation/i);
    expect(sql).toMatch(/function public\.is_same_household/i);
    expect(sql).toMatch(/link\.status = 'confirmed'/i);
    expect(sql).toMatch(/auth\.uid\(\) = first_user or auth\.uid\(\) = second_user or public\.is_admin\(\)/i);
    expect(sql).toMatch(/household_links_select_participant_or_admin/i);
  });

  it('stores only coarse schedule facts, expands four weeks, and emits trusted cancellation inputs', () => {
    expect(sql).toMatch(/create table if not exists public\.availability_patterns/i);
    expect(sql).toMatch(/area_label text not null/i);
    expect(sql).toMatch(/capacity smallint not null check \(capacity between 1 and 8\)/i);
    expect(sql).toMatch(/generate_series\([\s\S]*\+ 27/i);
    expect(sql).toMatch(/is_instructional_school_date/i);
    expect(sql).toMatch(/refresh_my_availability_instances/i);
    expect(sql).toMatch(/create table if not exists public\.schedule_cancellation_events/i);
    expect(sql).toMatch(/schedule cancellation events are append-only/i);
    expect(sql).toMatch(/'first_listing_created'/i);
    expect(day3Sql).not.toMatch(/\b(address|street|latitude|longitude|coordinates?|map_pin|live_location)\s+(text|numeric|double precision|jsonb)/i);
  });

  it('keeps internal expansion private and makes one-instance and whole-pattern cancellation distinct', () => {
    expect(sql).toMatch(/revoke all on function public\.expand_availability_pattern\(uuid\) from public/i);
    expect(sql).toMatch(/revoke all on function public\.school_local_today\(uuid\) from public/i);
    expect(sql).toMatch(/revoke all on function public\.is_instructional_school_date\(uuid, date\) from public/i);
    expect(sql).toMatch(/function public\.cancel_availability_instance/i);
    expect(sql).toMatch(/scope\)\n {2}values \(instance\.school_id[\s\S]*'instance'/i);
    expect(sql).toMatch(/function public\.cancel_availability_pattern/i);
    expect(sql).toMatch(/scope\)\n {4}values \(instance\.school_id[\s\S]*'pattern'/i);
  });

  it('protects reciprocal candidates, blocks, two-party acceptance and child reveal', () => {
    expect(sql).toMatch(/create table if not exists public\.match_blocks/i);
    expect(sql).toMatch(/create table if not exists public\.swap_proposals/i);
    expect(sql).toMatch(/create table if not exists public\.swap_legs/i);
    expect(sql).toMatch(/get_reciprocal_match_candidates/i);
    expect(sql).toMatch(/not public\.is_same_household/i);
    expect(sql).toMatch(/transition_swap_proposal/i);
    expect(sql).toMatch(/p_action not in \('accept','decline','withdraw'\)/i);
    expect(sql).toMatch(/status='accepted'/i);
    expect(sql).toMatch(/get_accepted_swap_children/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/active reciprocal swap reserves this instance/i);
    expect(sql).toMatch(/swap is blocked/i);
    expect(sql).toMatch(/first_match_viewed/i);
    expect(sql).toMatch(/first_swap_accepted/i);
  });

  it('adds append-only trust score events with band-only peer exposure', () => {
    expect(day6TrustSql).toMatch(/create table public\.trust_score_events/i);
    expect(day6TrustSql).toMatch(/trust score history is append-only/i);
    expect(day6TrustSql).toMatch(/alter table public\.trust_score_events enable row level security/i);
    expect(day6TrustSql).toMatch(/trust_score_events_select_own/i);
    expect(day6TrustSql).toMatch(/function public\.apply_trust_score_delta/i);
    expect(day6TrustSql).toMatch(/function public\.get_my_trust\(\)/i);
    expect(day6TrustSql).toMatch(/function public\.get_peer_trust_band\(p_peer_user_id uuid\)/i);
    expect(day6TrustSql).toMatch(/set search_path = pg_catalog/i);
    expect(day6TrustSql).toMatch(/grant execute on function public\.get_my_trust\(\) to authenticated/i);
    expect(day6TrustSql).toMatch(/grant execute on function public\.get_peer_trust_band\(uuid\) to authenticated/i);
    expect(day6TrustSql).toMatch(/revoke all on function public\.apply_trust_score_delta/i);
    expect(day6TrustSql).toMatch(/jsonb_build_object\(\s*'trust_band', band\s*\)/i);
    expect(day6TrustSql).not.toMatch(
      /\b(amount|price|currency|money|fee|payment)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('posts policy-driven trust deltas from completion cancellations and urgent cover', async () => {
    const deltas = (await readFile(resolve('db/migrations/0031_day6_trust_policy_deltas.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(deltas).toMatch(/function public\.trust_policy_delta/i);
    expect(deltas).toMatch(/function public\.post_trust_completed_trip/i);
    expect(deltas).toMatch(/function public\.post_trust_schedule_cancellation/i);
    expect(deltas).toMatch(/function public\.post_trust_swap_cancellation/i);
    expect(deltas).toMatch(/function public\.post_trust_urgent_cover_for_swap/i);
    expect(deltas).toMatch(/swap_leg_completed_to_trust/i);
    expect(deltas).toMatch(/schedule_cancellation_to_trust/i);
    expect(deltas).toMatch(/swap_cancellation_to_trust/i);
    expect(deltas).toMatch(/set search_path = pg_catalog/i);
    expect(deltas).toMatch(/revoke all on function public\.post_trust_urgent_cover_for_swap/i);
    expect(deltas).not.toMatch(
      /\b(amount|price|currency|money|fee|payment)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds trust holds appeals and no-show workflows with swap-only disable', async () => {
    const holds = (await readFile(resolve('db/migrations/0032_day6_trust_holds_appeals.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(holds).toMatch(/create table public\.trust_incident_reports/i);
    expect(holds).toMatch(/create table public\.trust_safety_holds/i);
    expect(holds).toMatch(/create table public\.trust_appeals/i);
    expect(holds).toMatch(/create table public\.trust_trip_penalties/i);
    expect(holds).toMatch(/alter table public\.trust_incident_reports enable row level security/i);
    expect(holds).toMatch(/function public\.report_no_show/i);
    expect(holds).toMatch(/function public\.place_safety_hold/i);
    expect(holds).toMatch(/function public\.file_trust_appeal/i);
    expect(holds).toMatch(/user_has_active_safety_hold/i);
    expect(holds).toMatch(/safety hold disables swaps/i);
    expect(holds).toMatch(/set search_path = pg_catalog/i);
    expect(holds).not.toMatch(
      /\b(amount|price|currency|money|fee|payment)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds phone-free school notices with school-scoped moderation', async () => {
    const notices = (await readFile(resolve('db/migrations/0033_day7_school_notices.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(notices).toMatch(/create table public\.school_notices/i);
    expect(notices).toMatch(/create table public\.school_notice_access_logs/i);
    expect(notices).toMatch(/alter table public\.school_notices enable row level security/i);
    expect(notices).toMatch(/alter table public\.school_notice_access_logs enable row level security/i);
    expect(notices).toMatch(/function public\.generate_school_notice/i);
    expect(notices).toMatch(/function public\.list_school_notice_moderation_queue/i);
    expect(notices).toMatch(/function public\.withdraw_school_notice/i);
    expect(notices).toMatch(/year_levels/i);
    expect(notices).toMatch(/collector_display_name/i);
    expect(notices).toMatch(/set search_path = pg_catalog/i);
    expect(notices).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|email|address)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds email relay queue masking and delivery policy without SMTP secrets', async () => {
    const relay = (await readFile(resolve('db/migrations/0035_day7_email_relay_queue.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(relay).toMatch(/create table public\.email_relay_delivery_policies/i);
    expect(relay).toMatch(/create table public\.email_relay_queue/i);
    expect(relay).toMatch(/create table public\.email_relay_delivery_events/i);
    expect(relay).toMatch(/alter table public\.email_relay_queue enable row level security/i);
    expect(relay).toMatch(/function public\.mask_email_address/i);
    expect(relay).toMatch(/function public\.enqueue_email_relay/i);
    expect(relay).toMatch(/function public\.claim_email_relay_batch/i);
    expect(relay).toMatch(/handover_reminder/i);
    expect(relay).toMatch(/server_admin_only/i);
    expect(relay).toMatch(/grant execute on function public\.claim_email_relay_batch\(integer\) to service_role/i);
    expect(relay).toMatch(/set search_path = pg_catalog/i);
    expect(relay).not.toMatch(/\b(smtp_password|api_key|secret_key)\b/i);
    expect(relay).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds 90-day disclosure retention purge without touching ledger or trust', async () => {
    const purge = (await readFile(resolve('db/migrations/0037_day7_retention_purge.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(purge).toMatch(/create table public\.departure_check_logs/i);
    expect(purge).toMatch(/create table public\.retention_purge_runs/i);
    expect(purge).toMatch(/alter table public\.departure_check_logs enable row level security/i);
    expect(purge).toMatch(/function public\.purge_expired_disclosure_retention/i);
    expect(purge).toMatch(/interval '90 days'/i);
    expect(purge).toMatch(/yourturn\.retention_purge/i);
    expect(purge).toMatch(/grant execute on function public\.purge_expired_disclosure_retention\(\) to service_role/i);
    expect(purge).toMatch(/swap_ledger_entries/i);
    expect(purge).toMatch(/trust_score_events/i);
    expect(purge).toMatch(/child_profiles/i);
    expect(purge).toMatch(/set search_path = pg_catalog/i);
    expect(purge).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });
});
