import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationNames = [
  '0001_day1_foundation.sql',
  '0002_day2_enum_values.sql',
  '0003_day2_onboarding_and_hardening.sql',
  '0004_day2_sample_pilot_data.sql',
  '0005_day2_security_remediation.sql',
  '0006_day3_households_schedules_calendar.sql',
  '0007_day3_sample_calendar.sql',
  '0008_day4_reciprocal_matching_swaps.sql',
  '0009_day4_matching_remediation.sql',
  '0010_day4_swap_integrity_remediation.sql',
  '0018_day5_trip_count_ledger.sql',
  '0019_day5_contact_consents.sql',
  '0020_day5_two_step_handover.sql',
];
const sql = (await Promise.all(migrationNames.map((name) => readFile(resolve('db/migrations', name), 'utf8')))).join('\n');
const tables = [
  'schools', 'school_configs', 'profiles', 'school_memberships', 'role_assignments',
  'audit_logs', 'analytics_events', 'feature_flags', 'trust_policy_versions',
  'consent_documents', 'consent_acceptances', 'child_profiles', 'safety_declaration_versions',
  'safety_declarations', 'school_invite_codes', 'school_invite_attempts', 'school_invitations',
  'household_links', 'household_link_invitations', 'school_calendar_periods', 'availability_patterns', 'availability_instances',
  'schedule_cancellation_events', 'match_blocks', 'swap_proposals', 'swap_legs', 'swap_ledger_entries',
  'contact_consents', 'contact_consent_backups', 'swap_cancellation_events', 'swap_contact_notifications',
  'swap_leg_confirmations', 'swap_leg_reminders',
];

const missing = tables.filter((table) => !new RegExp(`alter table public\\.${table} enable row level security;`, 'i').test(sql));
if (missing.length > 0) throw new Error(`RLS is not enabled for: ${missing.join(', ')}`);
if (!/alter table yourturn_private\.mobile_numbers enable row level security;/i.test(sql)
  || !/revoke all on schema yourturn_private from public,anon,authenticated;/i.test(sql)) {
  throw new Error('Private contact schema/table boundary is missing');
}
for (const helper of ['is_member', 'is_moderator', 'is_admin']) {
  if (!new RegExp(`function public\\.${helper}`, 'i').test(sql)) throw new Error(`Missing required RLS helper: ${helper}`);
}
if (!/audit_logs_append_only[\s\S]*before update or delete on public\.audit_logs/i.test(sql)) throw new Error('audit_logs append-only trigger is missing');
if (!/drop policy if exists analytics_events_insert_own_school/i.test(sql) || !/revoke insert on public\.analytics_events from authenticated/i.test(sql)) {
  throw new Error('analytics events are not protected from direct client inserts');
}
if (!/published trust policies are immutable/i.test(sql) || !/published trust policies cannot be deleted/i.test(sql)) {
  throw new Error('published trust-policy immutability guard is missing');
}
if (!/revoke update on public\.school_memberships from authenticated/i.test(sql) || !/safety_declaration_versions_select_own_published_scope/i.test(sql) || !/current safety declaration required/i.test(sql)) {
  throw new Error('Day 2 membership mutation or school-scoped safety declaration guard is missing');
}
if (!/function public\.is_same_household/i.test(sql) || !/is_instructional_school_date/i.test(sql) || !/schedule cancellation events are append-only/i.test(sql)) {
  throw new Error('Day 3 household, school-calendar, or immutable cancellation-event guard is missing');
}
if (!/auth\.uid\(\) = first_user or auth\.uid\(\) = second_user or public\.is_admin\(\)/i.test(sql)
  || !/revoke all on function public\.expand_availability_pattern\(uuid\) from public/i.test(sql)
  || !/refresh_my_availability_instances/i.test(sql)) {
  throw new Error('Day 3 household privacy, internal expansion privilege, or rolling horizon guard is missing');
}
if (!/get_reciprocal_match_candidates/i.test(sql) || !/propose_reciprocal_swap/i.test(sql) || !/transition_swap_proposal/i.test(sql) || !/get_accepted_swap_children/i.test(sql) || !/pg_advisory_xact_lock/i.test(sql)) {
  throw new Error('Day 4 reciprocal matching, two-party transition, child reveal, or concurrency guard is missing');
}
console.log(`RLS migration contract: ${tables.length} tables enabled; helpers, append-only audit, IDs-only analytics, policy immutability, household exclusion, reciprocal matching, private child reveal, concurrency locks, and cross-school safety guards present.`);
