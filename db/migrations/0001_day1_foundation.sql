-- YourTurn Day 1 foundation
-- Target: Supabase Postgres (Sydney-region project). Apply with a Supabase migration runner.
-- This migration creates no payment, price, cash-credit, live-location, document-upload,
-- in-home-care, or child-sensitive-data tables.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.school_membership_status as enum (
    'pending_email',
    'pending_invite',
    'pending_moderator',
    'verified',
    'rejected',
    'suspended'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.assignment_role as enum ('admin', 'moderator');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Core school-scoped records
-- ---------------------------------------------------------------------------
create table if not exists public.schools (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text not null check (char_length(display_name) between 2 and 160),
  timezone text not null check (timezone in ('Australia/Melbourne', 'Australia/Sydney', 'Australia/Hobart')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.school_configs (
  school_id uuid primary key references public.schools(id) on delete restrict,
  matching_window_minutes smallint not null default 15 check (matching_window_minutes between 1 and 60),
  strict_reciprocity_default boolean not null default true,
  allow_different_date_reciprocity boolean not null default true,
  reciprocal_window_days smallint not null default 28 check (reciprocal_window_days between 1 and 56),
  trips_owed_expiry_days smallint not null default 56 check (trips_owed_expiry_days between 1 and 90),
  trips_owed_reminder_days smallint not null default 42 check (trips_owed_reminder_days between 1 and 89),
  departure_check_minutes_before smallint not null default 30 check (departure_check_minutes_before between 5 and 120),
  departure_check_timeout_minutes smallint not null default 15 check (departure_check_timeout_minutes between 1 and 60),
  max_backups smallint not null default 2 check (max_backups between 0 and 2),
  moderator_sla_business_hours smallint not null default 24 check (moderator_sla_business_hours between 1 and 72),
  restricted_items jsonb not null default '[]'::jsonb check (jsonb_typeof(restricted_items) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (trips_owed_reminder_days < trips_owed_expiry_days)
);

-- `profiles` deliberately has no child name, address, phone, location, licence,
-- insurance-document, or document-upload column.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 80),
  trust_score smallint not null default 70 check (trust_score between -100 and 150),
  admin_suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Creates the minimal profile immediately after a Supabase Auth email user is
-- created. No email, phone, child data, or credential material is copied.
create or replace function public.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80);
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    case when char_length(trim(requested_name)) between 2 and 80 then trim(requested_name) else 'Parent' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.create_profile_for_new_auth_user();

create table if not exists public.school_memberships (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status public.school_membership_status not null default 'pending_email',
  verified_email_at timestamptz,
  invite_code_verified_at timestamptz,
  self_declaration jsonb not null default '{}'::jsonb check (jsonb_typeof(self_declaration) = 'object'),
  self_declaration_accepted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, user_id),
  check (
    status <> 'verified'
    or (
      verified_email_at is not null
      and invite_code_verified_at is not null
      and self_declaration_accepted_at is not null
      and approved_by is not null
      and approved_at is not null
    )
  )
);

create index if not exists school_memberships_user_school_idx
  on public.school_memberships (user_id, school_id)
  where status = 'verified';

create table if not exists public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  school_id uuid references public.schools(id) on delete cascade,
  role public.assignment_role not null,
  code_of_conduct_accepted_at timestamptz,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (role = 'admin' and school_id is null)
    or (role = 'moderator' and school_id is not null and code_of_conduct_accepted_at is not null)
  )
);

create unique index if not exists one_active_admin_assignment_per_user_idx
  on public.role_assignments (user_id)
  where role = 'admin' and revoked_at is null;

create unique index if not exists one_active_moderator_assignment_per_school_idx
  on public.role_assignments (user_id, school_id)
  where role = 'moderator' and revoked_at is null;

-- Append-only operational record. Payloads must not carry raw mobile numbers,
-- children’s personal data, documents, or live location data.
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  school_id uuid references public.schools(id) on delete set null,
  action text not null check (action ~ '^[a-z][a-z0-9_.-]{2,120}$'),
  entity_type text not null check (entity_type ~ '^[a-z][a-z0-9_.-]{2,80}$'),
  entity_id uuid,
  request_id uuid,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')
);

create index if not exists audit_logs_school_occurred_idx on public.audit_logs (school_id, occurred_at desc);
create index if not exists audit_logs_actor_occurred_idx on public.audit_logs (actor_id, occurred_at desc);

-- Pseudonymous product analytics only; no phone, email, child data, or location.
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  school_id uuid not null references public.schools(id) on delete restrict,
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_.-]{2,120}$'),
  occurred_at timestamptz not null default now(),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object')
);

create index if not exists analytics_events_school_occurred_idx on public.analytics_events (school_id, occurred_at desc);

-- Global flags use a NULL school_id. The UI school switcher ships disabled.
create table if not exists public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9-]{2,80}$'),
  school_id uuid references public.schools(id) on delete cascade,
  is_enabled boolean not null default false,
  description text not null check (char_length(description) between 3 and 300),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists feature_flags_scope_key_idx
  on public.feature_flags (key, coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A policy version is the source of truth for thresholds and scoring changes.
-- New score rules must be a new version; do not overwrite a published definition.
create table if not exists public.trust_policy_versions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references public.schools(id) on delete cascade,
  version integer not null check (version > 0),
  is_published boolean not null default false,
  effective_from timestamptz not null default now(),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (school_id, version),
  check ((not is_published) or published_at is not null)
);

create unique index if not exists one_published_trust_policy_per_scope_idx
  on public.trust_policy_versions
  (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_published;

-- ---------------------------------------------------------------------------
-- RLS helpers. SECURITY DEFINER avoids policy recursion; each function has a
-- fixed safe search path and exposes only a boolean result.
-- ---------------------------------------------------------------------------
create or replace function public.is_member(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.user_id = auth.uid()
      and membership.status = 'verified'
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.role_assignments assignment
    where assignment.user_id = auth.uid()
      and assignment.role = 'admin'
      and assignment.revoked_at is null
  );
$$;

create or replace function public.is_moderator(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.role_assignments assignment
    where assignment.user_id = auth.uid()
      and assignment.school_id = target_school
      and assignment.role = 'moderator'
      and assignment.code_of_conduct_accepted_at is not null
      and assignment.revoked_at is null
  )
  and public.is_member(target_school);
$$;

revoke all on function public.is_member(uuid) from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_moderator(uuid) from public;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_moderator(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Append-only database guard for audit records.
-- ---------------------------------------------------------------------------
create or replace function public.prevent_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'audit_logs are append-only' using errcode = '55000';
end;
$$;

drop trigger if exists audit_logs_append_only on public.audit_logs;
create trigger audit_logs_append_only
before update or delete on public.audit_logs
for each row execute function public.prevent_audit_log_mutation();

-- ---------------------------------------------------------------------------
-- Every Day 1 app table has RLS enabled.
-- ---------------------------------------------------------------------------
alter table public.schools enable row level security;
alter table public.school_configs enable row level security;
alter table public.profiles enable row level security;
alter table public.school_memberships enable row level security;
alter table public.role_assignments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.analytics_events enable row level security;
alter table public.feature_flags enable row level security;
alter table public.trust_policy_versions enable row level security;

-- Schools: verified members can discover only their own school; admins can manage.
drop policy if exists schools_select_own_verified_school on public.schools;
create policy schools_select_own_verified_school on public.schools
  for select to authenticated
  using (public.is_member(id) or public.is_admin());

drop policy if exists schools_admin_manage on public.schools;
create policy schools_admin_manage on public.schools
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- School configuration has the same school boundary.
drop policy if exists school_configs_select_own_verified_school on public.school_configs;
create policy school_configs_select_own_verified_school on public.school_configs
  for select to authenticated
  using (public.is_member(school_id) or public.is_admin());

drop policy if exists school_configs_admin_manage on public.school_configs;
create policy school_configs_admin_manage on public.school_configs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Parents can read only their own profile. A score stays private by default.
drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Membership records: self, own-school moderator, or administrator only.
drop policy if exists memberships_select_scoped on public.school_memberships;
create policy memberships_select_scoped on public.school_memberships
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_moderator(school_id)
    or public.is_admin()
  );

drop policy if exists memberships_moderator_or_admin_update on public.school_memberships;
create policy memberships_moderator_or_admin_update on public.school_memberships
  for update to authenticated
  using (public.is_moderator(school_id) or public.is_admin())
  with check (public.is_moderator(school_id) or public.is_admin());

drop policy if exists memberships_admin_insert on public.school_memberships;
create policy memberships_admin_insert on public.school_memberships
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists memberships_admin_delete on public.school_memberships;
create policy memberships_admin_delete on public.school_memberships
  for delete to authenticated
  using (public.is_admin());

-- Roles are visible to the assigned user and administrators; only admins manage.
drop policy if exists roles_select_self_or_admin on public.role_assignments;
create policy roles_select_self_or_admin on public.role_assignments
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists roles_admin_manage on public.role_assignments;
create policy roles_admin_manage on public.role_assignments
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Audit logs can be read only by their actor or an admin. There is deliberately
-- no INSERT, UPDATE, or DELETE policy: trusted server-only admin code writes them.
drop policy if exists audit_logs_select_actor_or_admin on public.audit_logs;
create policy audit_logs_select_actor_or_admin on public.audit_logs
  for select to authenticated
  using (actor_id = auth.uid() or public.is_admin());

-- Analytics is append-only for the current verified school member or admin.
drop policy if exists analytics_events_select_actor_or_admin on public.analytics_events;
create policy analytics_events_select_actor_or_admin on public.analytics_events
  for select to authenticated
  using (actor_id = auth.uid() or public.is_admin());

drop policy if exists analytics_events_insert_own_school on public.analytics_events;
create policy analytics_events_insert_own_school on public.analytics_events
  for insert to authenticated
  with check (actor_id = auth.uid() and public.is_member(school_id));

-- Feature flags are readable only when global or scoped to the caller’s school.
drop policy if exists feature_flags_select_global_or_own_school on public.feature_flags;
create policy feature_flags_select_global_or_own_school on public.feature_flags
  for select to authenticated
  using (school_id is null or public.is_member(school_id) or public.is_admin());

drop policy if exists feature_flags_admin_manage on public.feature_flags;
create policy feature_flags_admin_manage on public.feature_flags
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Published global policy and the member’s own-school policy are readable.
drop policy if exists trust_policy_versions_select_published_scope on public.trust_policy_versions;
create policy trust_policy_versions_select_published_scope on public.trust_policy_versions
  for select to authenticated
  using (
    (is_published and (school_id is null or public.is_member(school_id)))
    or public.is_admin()
  );

drop policy if exists trust_policy_versions_admin_manage on public.trust_policy_versions;
create policy trust_policy_versions_admin_manage on public.trust_policy_versions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Explicit table privileges prevent accidental raw writes; RLS further narrows
-- all granted actions. Service-role administrative code bypasses RLS by design.
revoke all on public.schools, public.school_configs, public.profiles,
  public.school_memberships, public.role_assignments, public.audit_logs,
  public.analytics_events, public.feature_flags, public.trust_policy_versions
  from anon, authenticated;

grant select, insert, update, delete on public.schools to authenticated;
grant select, insert, update, delete on public.school_configs to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.school_memberships to authenticated;
grant select, insert, update, delete on public.role_assignments to authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert on public.analytics_events to authenticated;
grant select, insert, update, delete on public.feature_flags to authenticated;
grant select, insert, update, delete on public.trust_policy_versions to authenticated;

commit;
