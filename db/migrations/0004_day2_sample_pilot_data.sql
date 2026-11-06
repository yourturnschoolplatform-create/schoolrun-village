-- Day 2 development/demo data. These are explicitly sample schools and sample codes.
-- No real school, parent, child, invitation recipient, phone, or location data is seeded.

begin;

-- The Day 1 foundation carries publication state but its original table
-- definition omitted this timestamp. Ensure the seed is valid on a fresh DB
-- and on projects where the earlier hardening migration already ran.
alter table public.trust_policy_versions
  add column if not exists published_at timestamptz;

-- `school_configs` has school_id rather than an id column. The generic audit
-- trigger must support both shapes before the sample config insert below.
create or replace function public.audit_sensitive_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data jsonb;
  affected_id uuid;
  affected_school_id uuid;
begin
  row_data := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  affected_id := coalesce(nullif(row_data ->> 'id', '')::uuid, nullif(row_data ->> 'school_id', '')::uuid);
  affected_school_id := nullif(row_data ->> 'school_id', '')::uuid;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), affected_school_id, 'admin.' || tg_table_name || '.' || lower(tg_op), tg_table_name, affected_id, '{}'::jsonb);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

insert into public.schools (slug, display_name, timezone)
values
  ('sample-harbourview-primary', 'Sample Harbourview Primary School', 'Australia/Melbourne'),
  ('sample-rivergum-primary', 'Sample Rivergum Primary School', 'Australia/Melbourne')
on conflict (slug) do nothing;

insert into public.school_configs (school_id, matching_window_minutes, strict_reciprocity_default, allow_different_date_reciprocity)
select id, 15, true, true from public.schools
where slug in ('sample-harbourview-primary', 'sample-rivergum-primary')
on conflict (school_id) do nothing;

insert into public.feature_flags (key, school_id, is_enabled, description)
values ('school-switcher', null, false, 'Multi-school switcher remains disabled: one school per parent is shown in the pilot UI.')
on conflict do nothing;

insert into public.consent_documents (document_type, version, title, summary, is_active, published_at)
values
  ('terms', 1, 'YourTurn Terms of Use', 'Use YourTurn only for school pickup and drop-off trip exchanges. No payments, money, in-home care, live location tracking or unsafe behaviour are permitted.', true, now()),
  ('privacy', 1, 'YourTurn Privacy Notice', 'Your school access is restricted. We collect only the minimum information for verification and school-run safety; child profiles contain a nickname and year level only.', true, now()),
  ('community_safety', 1, 'Community Safety Commitment', 'Treat families respectfully, follow school pickup rules, use appropriate restraints, and report safety concerns honestly. Safety protections are always included.', true, now())
on conflict (document_type, version) do nothing;

insert into public.safety_declaration_versions (school_id, version, title, summary, is_published, published_at)
values (
  null,
  1,
  'School-run safety declaration',
  'I confirm I hold a valid licence and insurance, use suitable child restraints, and will follow school pickup rules for every YourTurn school-run trip.',
  true,
  now()
)
on conflict do nothing;

insert into public.trust_policy_versions (school_id, version, is_published, published_at, definition)
values (
  null,
  1,
  true,
  now(),
  '{
    "start_score":70,
    "bands":{"trusted":85,"standard":60,"caution":40,"restricted":20,"suspended_below":20},
    "changes":{"completed_trip":1,"urgent_cover":3,"cancel_under_24h":-3,"cancel_under_2h":-8,"late_with_advance_notice":-2,"late_without_advance_notice":-5,"confirmed_no_show":-20,"confirmed_no_show_with_backup":-10,"confirmed_false_report":-15,"reviewed_safety_violation":-25},
    "confirmed_no_show_trips_owed":2,
    "urgent_cover":{"posted_within_hours":4,"weekly_limit":2,"same_household_allowed":false}
  }'::jsonb
)
on conflict do nothing;

-- Demo-only plain codes appear only as hashes in the database. The UI may show
-- these sample codes in local development; they must never be used for real schools.
insert into public.school_invite_codes (school_id, code_hash, label, expires_at, max_uses)
select id, crypt('HARBOUR-2026', gen_salt('bf')), '2026 sample onboarding code', now() + interval '180 days', 100
from public.schools where slug = 'sample-harbourview-primary'
on conflict (school_id, label) do nothing;

insert into public.school_invite_codes (school_id, code_hash, label, expires_at, max_uses)
select id, crypt('RIVERGUM-2026', gen_salt('bf')), '2026 sample onboarding code', now() + interval '180 days', 100
from public.schools where slug = 'sample-rivergum-primary'
on conflict (school_id, label) do nothing;

commit;
