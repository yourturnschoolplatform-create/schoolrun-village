-- Dedicated-test-database fixture only. Apply after all db/migrations files.
-- The live RLS test creates matching auth.users before this fixture executes.

begin;

insert into public.schools (id, slug, display_name, timezone)
values
  ('10000000-0000-0000-0000-000000000001', 'yourturn-test-north', 'YourTurn Test North Primary', 'Australia/Melbourne'),
  ('10000000-0000-0000-0000-000000000002', 'yourturn-test-south', 'YourTurn Test South Primary', 'Australia/Melbourne')
on conflict (id) do nothing;

insert into public.school_configs (school_id)
values ('10000000-0000-0000-0000-000000000001'), ('10000000-0000-0000-0000-000000000002')
on conflict (school_id) do nothing;

insert into public.profiles (id, display_name)
values
  ('20000000-0000-0000-0000-000000000001', 'Test Parent North'),
  ('20000000-0000-0000-0000-000000000002', 'Test Parent South'),
  ('20000000-0000-0000-0000-000000000003', 'Test Moderator North'),
  ('20000000-0000-0000-0000-000000000004', 'Test Admin'),
  ('20000000-0000-0000-0000-000000000005', 'Test Moderator South')
on conflict (id) do nothing;

insert into public.school_memberships (school_id, user_id, status, verified_email_at, invite_code_verified_at, approved_by, approved_at)
values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'verified', now(), now(), '20000000-0000-0000-0000-000000000003', now()),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'verified', now(), now(), '20000000-0000-0000-0000-000000000003', now()),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'verified', now(), now(), '20000000-0000-0000-0000-000000000003', now()),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'verified', now(), now(), '20000000-0000-0000-0000-000000000003', now())
on conflict (school_id, user_id) do nothing;

insert into public.role_assignments (user_id, school_id, role, code_of_conduct_accepted_at)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'parent', null),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'parent', null),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'moderator', now()),
  ('20000000-0000-0000-0000-000000000004', null, 'admin', null),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000002', 'moderator', now())
on conflict do nothing;

insert into public.consent_documents (document_type, version, title, summary, is_active, published_at)
values
  ('terms', 1, 'Test terms', 'Test-only current Terms.', true, now()),
  ('privacy', 1, 'Test privacy', 'Test-only current Privacy.', true, now()),
  ('community_safety', 1, 'Test community safety', 'Test-only current Community Safety.', true, now())
on conflict (document_type, version) do nothing;

insert into public.consent_acceptances (user_id, document_id)
select user_id, document.id
from (values
  ('20000000-0000-0000-0000-000000000001'::uuid),
  ('20000000-0000-0000-0000-000000000002'::uuid),
  ('20000000-0000-0000-0000-000000000003'::uuid),
  ('20000000-0000-0000-0000-000000000005'::uuid)
) as users(user_id)
cross join public.consent_documents document
where document.is_active
on conflict do nothing;

insert into public.safety_declaration_versions (school_id, version, title, summary, is_published, published_at)
values (null, 99, 'Test safety declaration', 'Test-only declaration.', true, now())
on conflict do nothing;

insert into public.safety_declaration_versions (school_id, version, title, summary, is_published, published_at)
values ('10000000-0000-0000-0000-000000000001', 99, 'North-only test declaration', 'School A test-only declaration.', true, now())
on conflict do nothing;

insert into public.safety_declarations (membership_id, parent_id, school_id, declaration_version_id, licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
select membership.id, membership.user_id, membership.school_id, version.id, true, true, true, true
from public.school_memberships membership
cross join lateral (
  select id from public.safety_declaration_versions where school_id is null and is_published order by version desc limit 1
) version
where membership.user_id in (
  '20000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000005'
)
on conflict do nothing;

insert into public.child_profiles (membership_id, parent_id, nickname, year_level)
select id, user_id, 'North child', 3 from public.school_memberships
where school_id = '10000000-0000-0000-0000-000000000001' and user_id = '20000000-0000-0000-0000-000000000001'
on conflict do nothing;

insert into public.feature_flags (key, school_id, is_enabled, description)
values ('school-switcher', null, false, 'Multi-school switcher remains disabled for the test pilot UI.')
on conflict do nothing;

insert into public.trust_policy_versions (school_id, version, is_published, published_at, definition)
values (
  null, 99, true, now(),
  '{"start_score":70,"bands":{"trusted":85,"standard":60,"caution":40,"restricted":20,"suspended_below":20},"changes":{"completed_trip":1,"urgent_cover":3,"cancel_under_24h":-3,"cancel_under_2h":-8,"late_with_advance_notice":-2,"late_without_advance_notice":-5,"confirmed_no_show":-20,"confirmed_no_show_with_backup":-10,"confirmed_false_report":-15,"reviewed_safety_violation":-25},"confirmed_no_show_trips_owed":2,"urgent_cover":{"posted_within_hours":4,"weekly_limit":2,"same_household_allowed":false}}'::jsonb
)
on conflict do nothing;

insert into public.school_calendar_periods (id, school_id, period_type, label, starts_on, ends_on)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'term', 'North test term', '2026-04-01', '2026-06-30'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'term', 'South test term', '2026-04-01', '2026-06-30')
on conflict (id) do nothing;

insert into public.availability_patterns (id, school_id, owner_id, intent, direction, weekday, window_start, window_end, area_label, capacity, starts_on)
values ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'can_help', 'pickup', 1, '08:00', '08:30', 'Carlton', 2, '2026-04-06')
on conflict (id) do nothing;

insert into public.availability_instances (id, pattern_id, school_id, owner_id, service_date, intent, direction, window_start, window_end, area_label, capacity, status, cancelled_at)
values ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '2026-04-06', 'can_help', 'pickup', '08:00', '08:30', 'Carlton', 2, 'cancelled', now())
on conflict (id) do nothing;

insert into public.schedule_cancellation_events (school_id, owner_id, pattern_id, instance_id, service_date, scope)
values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-04-06', 'instance')
on conflict (instance_id) do nothing;

insert into public.household_links (id, school_id, first_parent_id, second_parent_id, requested_by, requester_confirmed_at, other_parent_confirmed_at, status)
values ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', now(), now(), 'confirmed')
on conflict (id) do nothing;

commit;
