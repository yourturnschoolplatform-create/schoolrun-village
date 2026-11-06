-- Day 2 security remediation. Apply after 0004_day2_sample_pilot_data.sql.
-- This file makes the initial Day 2 schema safe to expose only after the full
-- migration sequence has completed.

begin;

-- Membership state is changed only by narrow, audited review RPCs.
drop policy if exists memberships_moderator_or_admin_update on public.school_memberships;
revoke update on public.school_memberships from authenticated;

-- Approved membership is a narrower concept than fully usable school access.
create or replace function public.is_approved_school_member(target_school uuid)
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
  );
$$;

-- A user is a school member only after the current consent and applicable,
-- current published safety declaration are completed. A school-specific
-- version takes precedence over the newest global version.
create or replace function public.is_member(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_approved_school_member(target_school)
    and public.has_current_onboarding_consents(auth.uid())
    and exists (
      select 1
      from public.safety_declarations declaration
      where declaration.parent_id = auth.uid()
        and declaration.school_id = target_school
        and declaration.declaration_version_id = coalesce(
          (
            select version.id from public.safety_declaration_versions version
            where version.school_id = target_school and version.is_published
            order by version.published_at desc, version.id desc limit 1
          ),
          (
            select version.id from public.safety_declaration_versions version
            where version.school_id is null and version.is_published
            order by version.published_at desc, version.id desc limit 1
          )
        )
    );
$$;

-- Versioned consent content remains immutable forever after publication. It may
-- only be deactivated to make a newer version current.
create or replace function public.prevent_active_consent_document_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.published_at is not null then
    raise exception 'published consent documents cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and old.published_at is not null
    and (new.document_type, new.version, new.title, new.summary, new.published_at)
      is distinct from (old.document_type, old.version, old.title, old.summary, old.published_at) then
    raise exception 'published consent documents are immutable; publish a new version instead' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Published safety declaration versions are immutable historical records.
drop index if exists public.one_published_safety_declaration_per_scope_idx;
create or replace function public.prevent_published_safety_declaration_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.is_published then
    raise exception 'published safety declarations cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and old.is_published and new is distinct from old then
    raise exception 'published safety declarations are immutable' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.is_published and new.published_at is null then
    raise exception 'published safety declarations require a publication timestamp' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists safety_declaration_versions_immutable on public.safety_declaration_versions;
create trigger safety_declaration_versions_immutable
before update or delete on public.safety_declaration_versions
for each row execute function public.prevent_published_safety_declaration_mutation();

-- Version content publication/state changes receive non-personal audit records.
create or replace function public.audit_global_sensitive_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare affected_id uuid;
begin
  affected_id := case when tg_op = 'DELETE' then old.id else new.id end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, payload)
  values (auth.uid(), 'admin.' || tg_table_name || '.' || lower(tg_op), tg_table_name, affected_id, '{}'::jsonb);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists audit_consent_documents_change on public.consent_documents;
create trigger audit_consent_documents_change
after insert or update or delete on public.consent_documents
for each row execute function public.audit_global_sensitive_change();
drop trigger if exists audit_safety_declaration_versions_change on public.safety_declaration_versions;
create trigger audit_safety_declaration_versions_change
after insert or update or delete on public.safety_declaration_versions
for each row execute function public.audit_global_sensitive_change();

-- School-specific declaration content is visible only to its approved school;
-- pending users and other schools receive no declaration version rows.
drop policy if exists safety_declaration_versions_select_published on public.safety_declaration_versions;
create policy safety_declaration_versions_select_own_published_scope on public.safety_declaration_versions
  for select to authenticated using (
    public.is_admin()
    or (is_published and (school_id is null or public.is_approved_school_member(school_id)))
  );

-- Code redemption requires consent, checks existing membership before counting a
-- code attempt, and increments code usage only for a new pending request.
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
  if not public.has_current_onboarding_consents(auth.uid()) then
    raise exception 'current Terms, Privacy and Community Safety consent required' using errcode = '42501';
  end if;
  if char_length(trim(p_code)) < 6 or char_length(trim(p_code)) > 128 then
    raise exception 'invalid invite code' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select status into existing_status from public.school_memberships
  where school_id = p_school_id and user_id = auth.uid() for update;
  if existing_status = 'verified' then return 'already_verified'; end if;
  if existing_status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;

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
  if matching_code_id is null then raise exception 'invalid invite code' using errcode = '22023'; end if;

  update public.school_invite_codes set use_count = use_count + 1 where id = matching_code_id;
  insert into public.school_memberships (school_id, user_id, status, verified_email_at, invite_code_verified_at)
  values (p_school_id, auth.uid(), 'pending', now(), now())
  on conflict (school_id, user_id) do update
  set status = 'pending', verified_email_at = now(), invite_code_verified_at = now(), updated_at = now();
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), p_school_id, 'school_joined');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, payload)
  values (auth.uid(), p_school_id, 'membership.invite_code_redeemed', 'school_membership', jsonb_build_object('source', 'invite_code', 'outcome', 'pending'));
  return 'pending';
end;
$$;

-- A token is claimable by only one user. Replays by that same user are
-- idempotent, and replays by any other user never mutate it.
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
  if not public.has_current_onboarding_consents(auth.uid()) then
    raise exception 'current Terms, Privacy and Community Safety consent required' using errcode = '42501';
  end if;
  select * into invitation from public.school_invitations
  where token_hash = encode(digest(p_token, 'sha256'), 'hex') and expires_at > now()
  for update;
  if invitation.id is null or invitation.status in ('expired', 'revoked') then
    raise exception 'invitation unavailable' using errcode = 'P0002';
  end if;
  if invitation.status in ('joined', 'approved') then
    if invitation.joined_by = auth.uid() then
      return case when invitation.status = 'approved' then 'already_approved' else 'pending' end;
    end if;
    raise exception 'invitation unavailable' using errcode = 'P0002';
  end if;

  select status into existing_status from public.school_memberships
  where school_id = invitation.school_id and user_id = auth.uid() for update;
  if existing_status = 'verified' then return 'already_verified'; end if;
  if existing_status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;
  insert into public.school_memberships (school_id, user_id, status, verified_email_at, invite_code_verified_at)
  values (invitation.school_id, auth.uid(), 'pending', now(), now())
  on conflict (school_id, user_id) do update
  set status = 'pending', verified_email_at = now(), invite_code_verified_at = now(), updated_at = now();
  update public.school_invitations
  set status = 'joined', joined_at = now(), joined_by = auth.uid()
  where id = invitation.id;
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), invitation.school_id, 'invite_joined');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), invitation.school_id, 'invitation.joined', 'school_invitation', invitation.id, jsonb_build_object('outcome', 'joined'));
  return 'pending';
end;
$$;

-- A declaration must attest to the current version for that school. Once a
-- newer school-specific or global version is published, access remains gated
-- until the parent accepts the replacement record.
create or replace function public.sign_onboarding_safety_declaration(p_membership_id uuid, p_declaration_version_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare membership public.school_memberships%rowtype;
declare current_version_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if not public.has_current_onboarding_consents(auth.uid()) then raise exception 'current Terms, Privacy and Community Safety consent required' using errcode = '42501'; end if;
  select * into membership from public.school_memberships where id = p_membership_id and user_id = auth.uid() and status = 'verified';
  if membership.id is null then raise exception 'approved school membership required' using errcode = '42501'; end if;
  select version.id into current_version_id
  from public.safety_declaration_versions version
  where version.is_published and (version.school_id = membership.school_id or version.school_id is null)
  order by (version.school_id = membership.school_id) desc, version.published_at desc, version.id desc
  limit 1;
  if current_version_id is null then raise exception 'published safety declaration not found' using errcode = 'P0002'; end if;
  if p_declaration_version_id <> current_version_id then raise exception 'current safety declaration required' using errcode = '22023'; end if;
  insert into public.safety_declarations (
    membership_id, parent_id, school_id, declaration_version_id,
    licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed
  ) values (membership.id, auth.uid(), membership.school_id, current_version_id, true, true, true, true)
  on conflict (membership_id, declaration_version_id) do nothing;
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), membership.school_id, 'declaration_signed');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), membership.school_id, 'safety_declaration.signed', 'safety_declaration_version', current_version_id, jsonb_build_object('version', current_version_id::text));
  return case when public.is_member(membership.school_id) then 'complete' else 'incomplete' end;
end;
$$;

-- Rejection and suspension remain scoped, audited mutation paths. Approval
-- continues to assign the parent role and record the required approved event.
create or replace function public.set_school_membership_review_state(p_membership_id uuid, p_state text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare membership public.school_memberships%rowtype;
begin
  if p_state not in ('rejected', 'suspended') then raise exception 'unsupported membership review state' using errcode = '22023'; end if;
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select * into membership from public.school_memberships where id = p_membership_id for update;
  if membership.id is null then raise exception 'membership not found' using errcode = 'P0002'; end if;
  if not (public.is_moderator(membership.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  update public.school_memberships set status = p_state::public.school_membership_status, updated_at = now() where id = membership.id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), membership.school_id, 'membership.reviewed', 'school_membership', membership.id, jsonb_build_object('next_status', p_state));
  return p_state;
end;
$$;

revoke all on function public.is_approved_school_member(uuid) from public;
revoke all on function public.set_school_membership_review_state(uuid, text) from public;
grant execute on function public.is_approved_school_member(uuid) to authenticated;
grant execute on function public.set_school_membership_review_state(uuid, text) to authenticated;

commit;
