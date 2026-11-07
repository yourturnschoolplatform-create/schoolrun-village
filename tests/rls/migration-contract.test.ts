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
  'running_late_notices',
  'community_threads', 'community_posts', 'community_comments', 'community_likes',
  'community_reports', 'community_moderation_actions',
  'handover_reminder_deliveries',
  'listing_restricted_items', 'item_listings', 'listing_enquiries',
  'listing_reports', 'listing_moderation_actions',
  'notifications',
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
  readFile(resolve('db/migrations/0039_day7_running_late_notices.sql'), 'utf8'),
  readFile(resolve('db/migrations/0040_day8_community_discussion.sql'), 'utf8'),
  readFile(resolve('db/migrations/0041_day8_community_moderation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0042_day8_community_moderation_guards.sql'), 'utf8'),
  readFile(resolve('db/migrations/0043_day8_community_moderation_audit_payload.sql'), 'utf8'),
  readFile(resolve('db/migrations/0044_day8_handover_reminder_delivery.sql'), 'utf8'),
  readFile(resolve('db/migrations/0045_day9_item_listings.sql'), 'utf8'),
  readFile(resolve('db/migrations/0046_day9_listing_audit_payload.sql'), 'utf8'),
  readFile(resolve('db/migrations/0047_day9_listing_status_moderation.sql'), 'utf8'),
  readFile(resolve('db/migrations/0048_day9_restricted_items_admin.sql'), 'utf8'),
  readFile(resolve('db/migrations/0049_day10_user_notifications.sql'), 'utf8'),
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

  it('adds running-late notices and late trust penalties without location or money fields', async () => {
    const late = (await readFile(resolve('db/migrations/0039_day7_running_late_notices.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(late).toMatch(/create table public\.running_late_notices/i);
    expect(late).toMatch(/alter table public\.running_late_notices enable row level security/i);
    expect(late).toMatch(/function public\.post_running_late_notice/i);
    expect(late).toMatch(/function public\.get_running_late_notice/i);
    expect(late).toMatch(/function public\.list_my_running_late_notices/i);
    expect(late).toMatch(/function public\.post_trust_late_arrival/i);
    expect(late).toMatch(/late_with_advance_notice/i);
    expect(late).toMatch(/late_without_advance_notice/i);
    expect(late).toMatch(/posted_at < window_starts_at/i);
    expect(late).toMatch(/set search_path = pg_catalog/i);
    expect(late).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds school-scoped community discussion without photos money or child full-name fields', async () => {
    const community = (await readFile(resolve('db/migrations/0040_day8_community_discussion.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(community).toMatch(/create table public\.community_threads/i);
    expect(community).toMatch(/create table public\.community_posts/i);
    expect(community).toMatch(/create table public\.community_comments/i);
    expect(community).toMatch(/create table public\.community_likes/i);
    expect(community).toMatch(/alter table public\.community_threads enable row level security/i);
    expect(community).toMatch(/function public\.create_community_thread/i);
    expect(community).toMatch(/function public\.create_community_comment/i);
    expect(community).toMatch(/function public\.toggle_community_like/i);
    expect(community).toMatch(/function public\.list_community_threads/i);
    expect(community).toMatch(/community_text_is_allowed/i);
    expect(community).toMatch(/set search_path = pg_catalog/i);
    expect(community).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds community moderation reports auto-hide and moderator review without money fields', async () => {
    const moderation = (await readFile(resolve('db/migrations/0041_day8_community_moderation.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(moderation).toMatch(/create table public\.community_reports/i);
    expect(moderation).toMatch(/create table public\.community_moderation_actions/i);
    expect(moderation).toMatch(/alter table public\.community_reports enable row level security/i);
    expect(moderation).toMatch(/alter table public\.community_moderation_actions enable row level security/i);
    expect(moderation).toMatch(/function public\.report_community_content/i);
    expect(moderation).toMatch(/function public\.hide_community_content/i);
    expect(moderation).toMatch(/function public\.restore_community_content/i);
    expect(moderation).toMatch(/function public\.remove_community_content/i);
    expect(moderation).toMatch(/function public\.list_community_moderation_queue/i);
    expect(moderation).toMatch(/auto_hide|auto-hidden after three unique reports/i);
    expect(moderation).toMatch(/set search_path = pg_catalog/i);
    expect(moderation).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds handover reminder delivery with live eligibility recheck without money fields', async () => {
    const delivery = (await readFile(resolve('db/migrations/0044_day8_handover_reminder_delivery.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(delivery).toMatch(/create table public\.handover_reminder_deliveries/i);
    expect(delivery).toMatch(/alter table public\.handover_reminder_deliveries enable row level security/i);
    expect(delivery).toMatch(/function public\.deliver_due_handover_reminders/i);
    expect(delivery).toMatch(/function public\.handover_reminder_live_eligibility/i);
    expect(delivery).toMatch(/function public\.list_my_handover_reminder_deliveries/i);
    expect(delivery).toMatch(/handover_reminder/i);
    expect(delivery).toMatch(/set search_path = pg_catalog/i);
    expect(delivery).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds school-scoped free item listings restricted catalogue search and enquiries without money fields', async () => {
    const listings = (await readFile(resolve('db/migrations/0045_day9_item_listings.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(listings).toMatch(/create table public\.listing_restricted_items/i);
    expect(listings).toMatch(/create table public\.item_listings/i);
    expect(listings).toMatch(/create table public\.listing_enquiries/i);
    expect(listings).toMatch(/alter table public\.listing_restricted_items enable row level security/i);
    expect(listings).toMatch(/alter table public\.item_listings enable row level security/i);
    expect(listings).toMatch(/alter table public\.listing_enquiries enable row level security/i);
    expect(listings).toMatch(/function public\.create_item_listing/i);
    expect(listings).toMatch(/function public\.search_item_listings/i);
    expect(listings).toMatch(/function public\.get_item_listing/i);
    expect(listings).toMatch(/function public\.create_listing_enquiry/i);
    expect(listings).toMatch(/function public\.list_listing_enquiries/i);
    expect(listings).toMatch(/function public\.list_restricted_listing_items/i);
    expect(listings).toMatch(/display_offer_label/i);
    expect(listings).toMatch(/car seat/i);
    expect(listings).toMatch(/bassinet/i);
    expect(listings).toMatch(/baby walker/i);
    expect(listings).toMatch(/set search_path = pg_catalog/i);
    expect(listings).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds listing collected fulfilled withdrawal reporting and moderation without money fields', async () => {
    const moderation = (await readFile(resolve('db/migrations/0047_day9_listing_status_moderation.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(moderation).toMatch(/create table public\.listing_reports/i);
    expect(moderation).toMatch(/create table public\.listing_moderation_actions/i);
    expect(moderation).toMatch(/alter table public\.listing_reports enable row level security/i);
    expect(moderation).toMatch(/alter table public\.listing_moderation_actions enable row level security/i);
    expect(moderation).toMatch(/function public\.mark_item_listing_collected/i);
    expect(moderation).toMatch(/function public\.mark_item_listing_fulfilled/i);
    expect(moderation).toMatch(/function public\.withdraw_item_listing/i);
    expect(moderation).toMatch(/function public\.report_item_listing/i);
    expect(moderation).toMatch(/function public\.hide_item_listing/i);
    expect(moderation).toMatch(/function public\.restore_item_listing/i);
    expect(moderation).toMatch(/function public\.remove_item_listing/i);
    expect(moderation).toMatch(/function public\.list_listing_moderation_queue/i);
    expect(moderation).toMatch(/collected|fulfilled/i);
    expect(moderation).toMatch(/set search_path = pg_catalog/i);
    expect(moderation).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds administrator restricted catalogue create update and full list without money fields', async () => {
    const admin = (await readFile(resolve('db/migrations/0048_day9_restricted_items_admin.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(admin).toMatch(/function public\.create_restricted_listing_item/i);
    expect(admin).toMatch(/function public\.update_restricted_listing_item/i);
    expect(admin).toMatch(/function public\.list_all_restricted_listing_items/i);
    expect(admin).toMatch(/listing_require_admin/i);
    expect(admin).toMatch(/yourturn\.listing_restricted_admin/i);
    expect(admin).toMatch(/set search_path = pg_catalog/i);
    expect(admin).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('adds owner notifications ledger with system enqueue and read RPCs without money fields', async () => {
    const notifications = (await readFile(resolve('db/migrations/0049_day10_user_notifications.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(notifications).toMatch(/create table public\.notifications/i);
    expect(notifications).toMatch(/alter table public\.notifications enable row level security/i);
    expect(notifications).toMatch(/notifications_select_own/i);
    expect(notifications).toMatch(/notifications_update_own/i);
    expect(notifications).toMatch(/function public\.list_my_notifications/i);
    expect(notifications).toMatch(/function public\.mark_notification_read/i);
    expect(notifications).toMatch(/function public\.mark_all_notifications_read/i);
    expect(notifications).toMatch(/function public\.enqueue_user_notification/i);
    expect(notifications).toMatch(/yourturn\.notification_enqueue/i);
    expect(notifications).toMatch(/set search_path = pg_catalog/i);
    expect(notifications).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });

  it('wires handover swap and trust events into owner notifications without money fields', async () => {
    const wiring = (await readFile(resolve('db/migrations/0050_day10_system_event_notifications.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(wiring).toMatch(/function public\.notify_user_event_once/i);
    expect(wiring).toMatch(/function public\.notify_handover_confirmation/i);
    expect(wiring).toMatch(/function public\.notify_handover_completion/i);
    expect(wiring).toMatch(/handover_completed/i);
    expect(wiring).toMatch(/handover_update/i);
    expect(wiring).toMatch(/swap_proposed/i);
    expect(wiring).toMatch(/swap_declined/i);
    expect(wiring).toMatch(/swap_withdrawn/i);
    expect(wiring).toMatch(/safety_hold/i);
    expect(wiring).toMatch(/trust_update/i);
    expect(wiring).toMatch(/create or replace function public\.propose_reciprocal_swap/i);
    expect(wiring).toMatch(/create or replace function public\.transition_swap_proposal/i);
    expect(wiring).toMatch(/create or replace function public\.place_safety_hold/i);
    expect(wiring).toMatch(/create or replace function public\.resolve_safety_hold/i);
    expect(wiring).toMatch(/create or replace function public\.apply_trust_score_delta/i);
    expect(wiring).toMatch(/set search_path = pg_catalog/i);
    expect(wiring).not.toMatch(/set search_path = pg_catalog, public/i);
    expect(wiring).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
    expect(wiring).toMatch(/'Your school trust record was updated\.'/);
    expect(wiring).toMatch(/entity_type/i);
    expect(wiring).not.toMatch(/jsonb_build_object\(\s*'leg_id'/i);
  });

  it('adds global-admin moderation RPCs and audit without email hardcoding or money fields', async () => {
    const admin = (await readFile(resolve('db/migrations/0051_day10_admin_moderation.sql'), 'utf8'))
      .replace(/\r\n/g, '\n');
    expect(admin).toMatch(/function public\.admin_require/i);
    expect(admin).toMatch(/function public\.admin_suspend_user/i);
    expect(admin).toMatch(/function public\.admin_unsuspend_user/i);
    expect(admin).toMatch(/function public\.admin_resolve_safety_hold/i);
    expect(admin).toMatch(/function public\.list_admin_safety_holds/i);
    expect(admin).toMatch(/function public\.list_admin_suspended_users/i);
    expect(admin).toMatch(/function public\.list_admin_audit_actions/i);
    expect(admin).toMatch(/public\.is_admin\(\)/i);
    expect(admin).toMatch(/insert into public\.audit_logs/i);
    expect(admin).toMatch(/admin_suspended/i);
    expect(admin).toMatch(/set search_path = pg_catalog/i);
    expect(admin).not.toMatch(/set search_path = pg_catalog, public/i);
    expect(admin).not.toMatch(/create (schema|table|function) yourturn\./i);
    expect(admin).not.toMatch(/yourturn\.schoolplatform@gmail\.com/i);
    expect(admin).not.toMatch(/\badmin_email\b/i);
    expect(admin).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude|email)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });
});
