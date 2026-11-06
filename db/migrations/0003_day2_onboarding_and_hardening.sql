-- YourTurn Day 2: onboarding and security hardening.
-- Apply after 0001_day1_foundation.sql to a Supabase Postgres project.

begin;

-- ---------------------------------------------------------------------------
-- Day 1 hardening: eliminate free-form sensitive-data paths.
-- Enum values used below were committed in 0002_day2_enum_values.sql.
-- ---------------------------------------------------------------------------

alter table public.role_assignments drop constraint if exists role_assignments_check;
alter table public.role_assignments add constraint role_assignments_scope_check check (
  (role = 'admin' and school_id is null)
  or (role in ('parent', 'moderator') and school_id is not null)
);
alter table public.role_assignments add constraint moderator_requires_code_of_conduct check (
  role <> 'moderator' or code_of_conduct_accepted_at is not null
);

create unique index if not exists one_active_parent_assignment_per_school_idx
  on public.role_assignments (user_id, school_id)
  where role = 'parent' and revoked_at is null;

-- Safety declaration moves out of an unconstrained JSON membership column.
alter table public.school_memberships drop column if exists self_declaration;
alter table public.school_memberships drop constraint if exists school_memberships_check;
alter table public.school_memberships add constraint school_memberships_verified_credential_check check (
  status <> 'verified'
  or (
    verified_email_at is not null
    and invite_code_verified_at is not null
    and approved_by is not null
    and approved_at is not null
  )
);

-- Analytics remains IDs-only. No untrusted browser payload or property bag exists.
alter table public.analytics_events drop constraint if exists analytics_events_event_name_check;
alter table public.analytics_events drop column if exists properties;
alter table public.analytics_events alter column school_id drop not null;
alter table public.analytics_events add constraint analytics_events_allowed_name_check check (
  event_name in (
    'signed_up', 'email_verified', 'school_joined', 'approved',
    'child_added', 'declaration_signed', 'invite_sent', 'invite_joined'
  )
);
create unique index if not exists analytics_one_account_event_once_idx
  on public.analytics_events (actor_id, event_name)
  where event_name in ('signed_up', 'email_verified');

drop policy if exists analytics_events_insert_own_school on public.analytics_events;
revoke insert on public.analytics_events from authenticated;

-- Audit payload allows only short, non-personal operation codes. It never stores
-- emails, phone numbers, child data, invite tokens/codes, addresses or coordinates.
create or replace function public.audit_payload_is_safe(payload jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(payload) = 'object'
    and not exists (
      select 1
      from jsonb_each(payload) as entry(key, value)
      where entry.key not in ('source', 'outcome', 'reason_code', 'previous_status', 'next_status', 'version')
        or jsonb_typeof(entry.value) <> 'string'
        or char_length(entry.value #>> '{}') > 120
    );
$$;

alter table public.audit_logs drop constraint if exists audit_logs_payload_check;
alter table public.audit_logs add constraint audit_logs_safe_payload_check
  check (public.audit_payload_is_safe(payload));

-- Trust policy JSON is restricted to the documented immutable policy model.
create or replace function public.trust_policy_definition_is_valid(definition jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(definition) = 'object'
    and definition ?& array['start_score', 'bands', 'changes', 'confirmed_no_show_trips_owed', 'urgent_cover']
    and (definition - array['start_score', 'bands', 'changes', 'confirmed_no_show_trips_owed', 'urgent_cover']) = '{}'::jsonb
    and jsonb_typeof(definition -> 'start_score') = 'number'
    and jsonb_typeof(definition -> 'confirmed_no_show_trips_owed') = 'number'
    and jsonb_typeof(definition -> 'bands') = 'object'
    and jsonb_typeof(definition -> 'changes') = 'object'
    and jsonb_typeof(definition -> 'urgent_cover') = 'object';
$$;

alter table public.trust_policy_versions drop constraint if exists trust_policy_versions_definition_check;
alter table public.trust_policy_versions add constraint trust_policy_versions_valid_definition_check
  check (public.trust_policy_definition_is_valid(definition));
alter table public.trust_policy_versions drop constraint if exists trust_policy_versions_school_id_version_key;
create unique index if not exists trust_policy_versions_scope_version_idx
  on public.trust_policy_versions (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
drop index if exists public.one_published_trust_policy_per_scope_idx;

create or replace function public.prevent_published_trust_policy_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.is_published then
    raise exception 'published trust policies cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and old.is_published and new is distinct from old then
    raise exception 'published trust policies are immutable' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.is_published and new.published_at is null then
    raise exception 'published trust policies require a publication timestamp' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trust_policy_versions_immutable on public.trust_policy_versions;
create trigger trust_policy_versions_immutable
before update or delete on public.trust_policy_versions
for each row execute function public.prevent_published_trust_policy_mutation();

drop policy if exists trust_policy_versions_admin_manage on public.trust_policy_versions;
create policy trust_policy_versions_admin_insert_draft on public.trust_policy_versions
  for insert to authenticated with check (public.is_admin() and not is_published);
create policy trust_policy_versions_admin_publish_draft on public.trust_policy_versions
  for update to authenticated using (public.is_admin() and not is_published)
  with check (public.is_admin());
create policy trust_policy_versions_admin_delete_draft on public.trust_policy_versions
  for delete to authenticated using (public.is_admin() and not is_published);

-- Audit sensitive membership/role/configuration changes without recording values.
create or replace function public.audit_sensitive_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_id uuid;
  affected_school_id uuid;
begin
  if tg_op = 'DELETE' then
    affected_id := old.id;
    affected_school_id := old.school_id;
  else
    affected_id := new.id;
    affected_school_id := new.school_id;
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(),
    affected_school_id,
    'admin.' || tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    affected_id,
    '{}'::jsonb
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['school_memberships', 'role_assignments', 'school_configs', 'feature_flags', 'trust_policy_versions']
  loop
    execute format('drop trigger if exists %I on public.%I', 'audit_' || table_name || '_change', table_name);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_sensitive_change()', 'audit_' || table_name || '_change', table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Day 2 data model: versioned consent, child profile, safety, invites.
-- ---------------------------------------------------------------------------
create table if not exists public.consent_documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('terms', 'privacy', 'community_safety')),
  version integer not null check (version > 0),
  title text not null check (char_length(title) between 3 and 120),
  summary text not null check (char_length(summary) between 3 and 2000),
  is_active boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (document_type, version),
  check ((not is_active) or published_at is not null)
);

create unique index if not exists one_active_consent_document_per_type_idx
  on public.consent_documents (document_type) where is_active;

create or replace function public.prevent_active_consent_document_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.is_active then
    raise exception 'active consent documents cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and old.is_active
    and (new.document_type, new.version, new.title, new.summary, new.published_at)
      is distinct from (old.document_type, old.version, old.title, old.summary, old.published_at) then
    raise exception 'active consent documents are immutable; deactivate then publish a new version' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists consent_documents_immutable on public.consent_documents;
create trigger consent_documents_immutable
before update or delete on public.consent_documents
for each row execute function public.prevent_active_consent_document_mutation();

create table if not exists public.consent_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  document_id uuid not null references public.consent_documents(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  unique (user_id, document_id)
);

-- Child data is deliberately and structurally limited to nickname + year level.
create table if not exists public.child_profiles (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.school_memberships(id) on delete cascade,
  parent_id uuid not null references public.profiles(id) on delete cascade,
  nickname text not null check (char_length(trim(nickname)) between 1 and 32),
  year_level smallint not null check (year_level between 0 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (membership_id, nickname)
);

create table if not exists public.safety_declaration_versions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references public.schools(id) on delete cascade,
  version integer not null check (version > 0),
  title text not null check (char_length(title) between 3 and 120),
  summary text not null check (char_length(summary) between 3 and 2000),
  is_published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check ((not is_published) or published_at is not null)
);

create unique index if not exists safety_declaration_versions_scope_version_idx
  on public.safety_declaration_versions (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
create unique index if not exists one_published_safety_declaration_per_scope_idx
  on public.safety_declaration_versions (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_published;

create table if not exists public.safety_declarations (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.school_memberships(id) on delete cascade,
  parent_id uuid not null references public.profiles(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete restrict,
  declaration_version_id uuid not null references public.safety_declaration_versions(id) on delete restrict,
  licence_confirmed boolean not null,
  insurance_confirmed boolean not null,
  child_restraints_confirmed boolean not null,
  pickup_rules_confirmed boolean not null,
  accepted_at timestamptz not null default now(),
  unique (membership_id, declaration_version_id),
  check (licence_confirmed and insurance_confirmed and child_restraints_confirmed and pickup_rules_confirmed)
);

create table if not exists public.school_invite_codes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  code_hash text not null,
  label text not null check (char_length(label) between 3 and 80),
  expires_at timestamptz not null,
  max_uses integer not null check (max_uses between 1 and 10000),
  use_count integer not null default 0 check (use_count between 0 and max_uses),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (school_id, label),
  check (expires_at > created_at)
);

create table if not exists public.school_invite_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists school_invite_attempts_user_recent_idx on public.school_invite_attempts (user_id, attempted_at desc);

do $$
begin
  create type public.school_invitation_status as enum ('sent', 'opened', 'joined', 'approved', 'expired', 'revoked');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.school_invitations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete restrict,
  token_hash text not null unique,
  status public.school_invitation_status not null default 'sent',
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  joined_at timestamptz,
  joined_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null,
  check (expires_at > sent_at)
);

-- ---------------------------------------------------------------------------
-- RLS helpers and safe onboarding database commands.
-- ---------------------------------------------------------------------------
create or replace function public.is_verified_email_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null
  );
$$;

create or replace function public.has_current_onboarding_consents(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.consent_documents document
    where document.is_active
      and not exists (
        select 1 from public.consent_acceptances acceptance
        where acceptance.user_id = target_user
          and acceptance.document_id = document.id
      )
  );
$$;

-- `is_member` now means fully verified AND completed consent + safety onboarding.
-- Pending and moderator-approved-but-incomplete users cannot use school-scoped data.
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
    join public.profiles profile on profile.id = membership.user_id
    where membership.school_id = target_school
      and membership.user_id = auth.uid()
      and membership.status = 'verified'
      and not profile.admin_suspended
      and public.has_current_onboarding_consents(membership.user_id)
      and exists (
        select 1 from public.safety_declarations declaration
        where declaration.membership_id = membership.id
          and declaration.parent_id = membership.user_id
          and declaration.school_id = membership.school_id
          and declaration.licence_confirmed
          and declaration.insurance_confirmed
          and declaration.child_restraints_confirmed
          and declaration.pickup_rules_confirmed
      )
  );
$$;

create or replace function public.record_email_verified_event()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  insert into public.analytics_events (actor_id, school_id, event_name)
  values (auth.uid(), null, 'email_verified')
  on conflict do nothing;
end;
$$;

-- New accounts get only an ID-only signed_up event via the auth trigger.
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
  values (new.id, case when char_length(trim(requested_name)) between 2 and 80 then trim(requested_name) else 'Parent' end)
  on conflict (id) do nothing;
  insert into public.analytics_events (actor_id, school_id, event_name)
  values (new.id, null, 'signed_up')
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.accept_current_consent(p_document_type text, p_version integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  document_id uuid;
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  select id into document_id
  from public.consent_documents
  where document_type = p_document_type and version = p_version and is_active;
  if document_id is null then
    raise exception 'current consent document not found' using errcode = 'P0002';
  end if;
  insert into public.consent_acceptances (user_id, document_id)
  values (auth.uid(), document_id)
  on conflict (user_id, document_id) do nothing;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, payload)
  values (auth.uid(), 'consent.accepted', 'consent_document', document_id, jsonb_build_object('source', p_document_type, 'version', p_version::text));
end;
$$;

-- Manual school selection returns only listed school names, not configuration or roster data.
create or replace function public.list_onboarding_school_options()
returns table (id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  return query select school.id, school.display_name from public.schools school where school.is_active order by school.display_name;
end;
$$;

-- At most five code attempts per authenticated user in each 15-minute window.
create or replace function public.redeem_school_invite_code(p_school_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  matching_code_id uuid;
  existing_status public.school_membership_status;
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  if char_length(trim(p_code)) < 6 or char_length(trim(p_code)) > 128 then
    raise exception 'invalid invite code' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if (select count(*) from public.school_invite_attempts where user_id = auth.uid() and attempted_at > now() - interval '15 minutes') >= 5 then
    raise exception 'invite attempts rate limited' using errcode = 'P0001';
  end if;
  insert into public.school_invite_attempts (user_id) values (auth.uid());

  select code.id into matching_code_id
  from public.school_invite_codes code
  where code.school_id = p_school_id
    and code.is_active
    and code.expires_at > now()
    and code.use_count < code.max_uses
    and crypt(trim(p_code), code.code_hash) = code.code_hash
  for update;
  if matching_code_id is null then
    raise exception 'invalid invite code' using errcode = '22023';
  end if;

  update public.school_invite_codes set use_count = use_count + 1 where id = matching_code_id;
  select status into existing_status from public.school_memberships where school_id = p_school_id and user_id = auth.uid() for update;
  if existing_status = 'verified' then return 'already_verified'; end if;
  if existing_status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;

  insert into public.school_memberships (school_id, user_id, status)
  values (p_school_id, auth.uid(), 'pending')
  on conflict (school_id, user_id) do update
  set status = 'pending', verified_email_at = now(), invite_code_verified_at = now(), updated_at = now();

  update public.school_memberships
  set verified_email_at = coalesce(verified_email_at, now()),
      invite_code_verified_at = coalesce(invite_code_verified_at, now()),
      updated_at = now()
  where school_id = p_school_id and user_id = auth.uid();

  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), p_school_id, 'school_joined');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, payload)
  values (auth.uid(), p_school_id, 'membership.invite_code_redeemed', 'school_membership', jsonb_build_object('source', 'invite_code', 'outcome', 'pending'));
  return 'pending';
end;
$$;

-- Invitation links contain a one-time opaque token. Opening returns no school details.
create or replace function public.create_school_invitation(p_school_id uuid)
returns table (invitation_id uuid, invitation_token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  token text := encode(gen_random_bytes(24), 'hex');
  created_id uuid;
begin
  if auth.uid() is null or not (public.is_moderator(p_school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  insert into public.school_invitations (school_id, invited_by, token_hash, expires_at)
  values (p_school_id, auth.uid(), encode(digest(token, 'sha256'), 'hex'), now() + interval '14 days')
  returning id into created_id;
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), p_school_id, 'invite_sent');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), p_school_id, 'invitation.sent', 'school_invitation', created_id, jsonb_build_object('outcome', 'sent'));
  return query select created_id, token;
end;
$$;

create or replace function public.open_school_invitation(p_token text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_status public.school_invitation_status;
begin
  select status into current_status from public.school_invitations
  where token_hash = encode(digest(p_token, 'sha256'), 'hex') and expires_at > now()
  for update;
  if current_status is null then return 'unavailable'; end if;
  update public.school_invitations
  set status = case when status = 'sent' then 'opened' else status end,
      opened_at = coalesce(opened_at, now())
  where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  return 'opened';
end;
$$;

create or replace function public.claim_school_invitation(p_token text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  invitation public.school_invitations%rowtype;
  existing_status public.school_membership_status;
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  select * into invitation from public.school_invitations
  where token_hash = encode(digest(p_token, 'sha256'), 'hex') and expires_at > now()
  for update;
  if invitation.id is null then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;
  if invitation.status in ('expired', 'revoked') then raise exception 'invitation unavailable' using errcode = 'P0002'; end if;

  select status into existing_status from public.school_memberships where school_id = invitation.school_id and user_id = auth.uid() for update;
  if existing_status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;
  if existing_status is distinct from 'verified' then
    insert into public.school_memberships (school_id, user_id, status)
    values (invitation.school_id, auth.uid(), 'pending')
    on conflict (school_id, user_id) do update
    set status = 'pending', verified_email_at = now(), invite_code_verified_at = now(), updated_at = now();
  end if;

  update public.school_memberships
  set verified_email_at = coalesce(verified_email_at, now()),
      invite_code_verified_at = coalesce(invite_code_verified_at, now()),
      updated_at = now()
  where school_id = invitation.school_id and user_id = auth.uid();

  update public.school_invitations
  set status = 'joined', joined_at = coalesce(joined_at, now()), joined_by = auth.uid()
  where id = invitation.id;
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), invitation.school_id, 'invite_joined');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), invitation.school_id, 'invitation.joined', 'school_invitation', invitation.id, jsonb_build_object('outcome', 'joined'));
  return 'pending';
end;
$$;

create or replace function public.approve_school_membership(p_membership_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  membership public.school_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into membership from public.school_memberships where id = p_membership_id for update;
  if membership.id is null then raise exception 'membership not found' using errcode = 'P0002'; end if;
  if not (public.is_moderator(membership.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if membership.status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;
  if membership.status = 'verified' then return 'already_verified'; end if;

  update public.school_memberships
  set status = 'verified', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = membership.id;
  insert into public.role_assignments (user_id, school_id, role)
  values (membership.user_id, membership.school_id, 'parent')
  on conflict do nothing;
  update public.school_invitations
  set status = 'approved', approved_at = now(), approved_by = auth.uid()
  where school_id = membership.school_id and joined_by = membership.user_id and status = 'joined';
  insert into public.analytics_events (actor_id, school_id, event_name) values (membership.user_id, membership.school_id, 'approved');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), membership.school_id, 'membership.approved', 'school_membership', membership.id, jsonb_build_object('outcome', 'verified'));
  return 'verified';
end;
$$;

create or replace function public.list_pending_school_memberships()
returns table (membership_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  return query
  select membership.id, profile.display_name
  from public.school_memberships membership
  join public.profiles profile on profile.id = membership.user_id
  where membership.status in ('pending_email', 'pending_invite', 'pending_moderator', 'pending')
    and (public.is_moderator(membership.school_id) or public.is_admin())
  order by membership.created_at asc;
end;
$$;

create or replace function public.update_onboarding_parent_profile(p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.school_memberships where user_id = auth.uid() and status = 'verified'
  ) then raise exception 'approved school membership required' using errcode = '42501'; end if;
  if char_length(trim(p_display_name)) not between 2 and 80 then raise exception 'display name must be 2 to 80 characters' using errcode = '22023'; end if;
  update public.profiles set display_name = trim(p_display_name), updated_at = now() where id = auth.uid();
end;
$$;

create or replace function public.add_onboarding_child(p_membership_id uuid, p_nickname text, p_year_level smallint)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare child_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.school_memberships where id = p_membership_id and user_id = auth.uid() and status = 'verified'
  ) then raise exception 'approved school membership required' using errcode = '42501'; end if;
  insert into public.child_profiles (membership_id, parent_id, nickname, year_level)
  values (p_membership_id, auth.uid(), trim(p_nickname), p_year_level)
  returning id into child_id;
  insert into public.analytics_events (actor_id, school_id, event_name)
  select auth.uid(), school_id, 'child_added' from public.school_memberships where id = p_membership_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, payload)
  values (auth.uid(), 'child.added', 'child_profile', child_id, '{}'::jsonb);
  return child_id;
end;
$$;

create or replace function public.sign_onboarding_safety_declaration(p_membership_id uuid, p_declaration_version_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare membership public.school_memberships%rowtype;
declare version_school_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not public.has_current_onboarding_consents(auth.uid()) then raise exception 'current Terms, Privacy and Community Safety consent required' using errcode = '42501'; end if;
  select * into membership from public.school_memberships where id = p_membership_id and user_id = auth.uid() and status = 'verified';
  if membership.id is null then raise exception 'approved school membership required' using errcode = '42501'; end if;
  select school_id into version_school_id from public.safety_declaration_versions
  where id = p_declaration_version_id and is_published;
  if version_school_id is distinct from membership.school_id and version_school_id is not null then
    raise exception 'safety declaration is not valid for this school' using errcode = '22023';
  end if;
  if not found then raise exception 'published safety declaration not found' using errcode = 'P0002'; end if;

  insert into public.safety_declarations (
    membership_id, parent_id, school_id, declaration_version_id,
    licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed
  ) values (membership.id, auth.uid(), membership.school_id, p_declaration_version_id, true, true, true, true)
  on conflict (membership_id, declaration_version_id) do nothing;
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), membership.school_id, 'declaration_signed');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), membership.school_id, 'safety_declaration.signed', 'safety_declaration_version', p_declaration_version_id, jsonb_build_object('version', p_declaration_version_id::text));
  return case when public.is_member(membership.school_id) then 'complete' else 'incomplete' end;
end;
$$;

-- Atomic server-only admin bootstrap closes the Day 1 role-without-audit gap.
create or replace function public.bootstrap_first_admin(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare assignment_id uuid;
declare outcome text;
begin
  insert into public.profiles (id, display_name) values (p_user_id, 'Administrator') on conflict (id) do nothing;
  select id into assignment_id from public.role_assignments
  where user_id = p_user_id and role = 'admin' and revoked_at is null for update;
  if assignment_id is null then
    insert into public.role_assignments (user_id, school_id, role) values (p_user_id, null, 'admin') returning id into assignment_id;
    outcome := 'created';
  else
    outcome := 'already_active';
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, payload)
  values (p_user_id, 'admin.bootstrap', 'role_assignment', assignment_id, jsonb_build_object('source', 'YOURTURN_ADMIN_EMAIL', 'outcome', outcome));
  return outcome;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on all new tables and grant only safe capabilities.
-- ---------------------------------------------------------------------------
alter table public.consent_documents enable row level security;
alter table public.consent_acceptances enable row level security;
alter table public.child_profiles enable row level security;
alter table public.safety_declaration_versions enable row level security;
alter table public.safety_declarations enable row level security;
alter table public.school_invite_codes enable row level security;
alter table public.school_invite_attempts enable row level security;
alter table public.school_invitations enable row level security;

revoke all on public.consent_documents, public.consent_acceptances, public.child_profiles,
  public.safety_declaration_versions, public.safety_declarations, public.school_invite_codes,
  public.school_invite_attempts, public.school_invitations from anon, authenticated;
grant select, insert, update, delete on public.consent_documents to authenticated;
grant select on public.consent_acceptances to authenticated;
grant select on public.child_profiles to authenticated;
grant select on public.safety_declaration_versions to authenticated;
grant select on public.safety_declarations to authenticated;
grant select on public.school_invitations to authenticated;

create policy consent_documents_select_active on public.consent_documents
  for select to authenticated using (is_active or public.is_admin());
create policy consent_documents_admin_manage on public.consent_documents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy consent_acceptances_select_self on public.consent_acceptances
  for select to authenticated using (user_id = auth.uid());

create policy child_profiles_select_parent_only on public.child_profiles
  for select to authenticated using (parent_id = auth.uid());

create policy safety_declaration_versions_select_published on public.safety_declaration_versions
  for select to authenticated using (is_published or public.is_admin());
create policy safety_declaration_versions_admin_manage on public.safety_declaration_versions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy safety_declarations_select_parent_only on public.safety_declarations
  for select to authenticated using (parent_id = auth.uid());

-- Invite-code hashes and rate-limit history have no authenticated SELECT policy.
create policy invitations_select_inviter_or_scoped_moderator on public.school_invitations
  for select to authenticated using (
    invited_by = auth.uid()
    or public.is_moderator(school_id)
    or public.is_admin()
    or (joined_by = auth.uid() and public.is_member(school_id))
  );

revoke all on function public.is_verified_email_user() from public;
revoke all on function public.has_current_onboarding_consents(uuid) from public;
revoke all on function public.record_email_verified_event() from public;
revoke all on function public.accept_current_consent(text, integer) from public;
revoke all on function public.list_onboarding_school_options() from public;
revoke all on function public.redeem_school_invite_code(uuid, text) from public;
revoke all on function public.create_school_invitation(uuid) from public;
revoke all on function public.open_school_invitation(text) from public;
revoke all on function public.claim_school_invitation(text) from public;
revoke all on function public.approve_school_membership(uuid) from public;
revoke all on function public.list_pending_school_memberships() from public;
revoke all on function public.update_onboarding_parent_profile(text) from public;
revoke all on function public.add_onboarding_child(uuid, text, smallint) from public;
revoke all on function public.sign_onboarding_safety_declaration(uuid, uuid) from public;
revoke all on function public.bootstrap_first_admin(uuid) from public;

grant execute on function public.is_verified_email_user() to authenticated;
grant execute on function public.has_current_onboarding_consents(uuid) to authenticated;
grant execute on function public.record_email_verified_event() to authenticated;
grant execute on function public.accept_current_consent(text, integer) to authenticated;
grant execute on function public.list_onboarding_school_options() to authenticated;
grant execute on function public.redeem_school_invite_code(uuid, text) to authenticated;
grant execute on function public.create_school_invitation(uuid) to authenticated;
grant execute on function public.claim_school_invitation(text) to authenticated;
grant execute on function public.approve_school_membership(uuid) to authenticated;
grant execute on function public.list_pending_school_memberships() to authenticated;
grant execute on function public.update_onboarding_parent_profile(text) to authenticated;
grant execute on function public.add_onboarding_child(uuid, text, smallint) to authenticated;
grant execute on function public.sign_onboarding_safety_declaration(uuid, uuid) to authenticated;
grant execute on function public.open_school_invitation(text) to anon, authenticated;
grant execute on function public.bootstrap_first_admin(uuid) to service_role;

commit;
