-- Day 15: dual-signup account verification + parent/admin app roles on profiles.
-- Maps product statuses PENDING_VERIFICATION / VERIFIED / REJECTED and roles PARENT / ADMIN
-- without parallel yourturn.* user tables. Existing profiles are backfilled as verified.

do $$ begin
  create type public.account_verification_status as enum (
    'pending_verification',
    'verified',
    'rejected'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.account_app_role as enum ('parent', 'admin');
exception when duplicate_object then null;
end $$;

alter table public.profiles
  add column if not exists account_status public.account_verification_status not null default 'pending_verification';

alter table public.profiles
  add column if not exists account_role public.account_app_role not null default 'parent';

alter table public.profiles
  add column if not exists signup_school_id uuid references public.schools(id) on delete set null;

alter table public.profiles
  add column if not exists signup_invitation_code text;

alter table public.profiles
  add column if not exists account_verified_at timestamptz;

alter table public.profiles
  add column if not exists signup_suburb text;

alter table public.profiles
  add column if not exists signup_school_label text;

-- Do not lock existing pilot accounts behind the new queue.
update public.profiles
set
  account_status = 'verified',
  account_verified_at = coalesce(account_verified_at, created_at),
  updated_at = now()
where account_verified_at is null;

comment on column public.profiles.account_status is 'PENDING_VERIFICATION / VERIFIED / REJECTED product gate';
comment on column public.profiles.account_role is 'PARENT default or ADMIN platform role marker';
comment on column public.profiles.signup_school_id is 'Optional school chosen at parent signup';
comment on column public.profiles.signup_invitation_code is 'Optional school invitation code captured at signup (not a mobile/email column)';
comment on column public.profiles.account_verified_at is 'When a school/platform admin approved the account';

create or replace function public.create_profile_for_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  requested_name text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 80);
  intent_role text := lower(coalesce(new.raw_user_meta_data ->> 'account_role', 'parent'));
begin
  insert into public.profiles (
    id,
    display_name,
    account_status,
    account_role
  )
  values (
    new.id,
    case when char_length(trim(requested_name)) between 2 and 80 then trim(requested_name) else 'Parent' end,
    'pending_verification',
    case when intent_role = 'admin' then 'admin'::public.account_app_role else 'parent'::public.account_app_role end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.complete_parent_signup(
  p_display_name text,
  p_suburb text,
  p_school_label text,
  p_school_id uuid default null,
  p_invitation_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller uuid := auth.uid();
  cleaned_name text := left(trim(coalesce(p_display_name, '')), 80);
  cleaned_suburb text := left(trim(coalesce(p_suburb, '')), 64);
  cleaned_school text := left(trim(coalesce(p_school_label, '')), 120);
  cleaned_code text := left(trim(coalesce(p_invitation_code, '')), 64);
  row public.profiles%rowtype;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if char_length(cleaned_name) < 2 then
    raise exception 'display name required' using errcode = '22023';
  end if;
  if char_length(cleaned_suburb) < 2 then
    raise exception 'suburb required' using errcode = '22023';
  end if;
  if char_length(cleaned_school) < 2 then
    raise exception 'school label required' using errcode = '22023';
  end if;

  update public.profiles
  set
    display_name = cleaned_name,
    signup_suburb = cleaned_suburb,
    signup_school_label = cleaned_school,
    signup_school_id = p_school_id,
    signup_invitation_code = nullif(cleaned_code, ''),
    account_role = 'parent',
    account_status = case
      when account_status = 'verified' then account_status
      else 'pending_verification'
    end,
    updated_at = now()
  where id = caller
  returning * into row;

  if row.id is null then
    raise exception 'profile missing' using errcode = 'P0002';
  end if;

  if p_school_id is not null and nullif(cleaned_code, '') is not null then
    begin
      perform public.redeem_school_invite_code(p_school_id, cleaned_code);
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'accountStatus', upper(row.account_status::text),
    'accountRole', upper(row.account_role::text),
    'schoolId', row.signup_school_id,
    'verifiedAt', row.account_verified_at
  );
end;
$$;

revoke all on function public.complete_parent_signup(text, text, text, uuid, text) from public;
grant execute on function public.complete_parent_signup(text, text, text, uuid, text) to authenticated;

create or replace function public.get_my_account_verification()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller uuid := auth.uid();
  row public.profiles%rowtype;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into row from public.profiles where id = caller;
  if row.id is null then
    raise exception 'profile missing' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'accountStatus', upper(row.account_status::text),
    'accountRole', upper(row.account_role::text),
    'schoolId', row.signup_school_id,
    'invitationCodePresent', row.signup_invitation_code is not null,
    'verifiedAt', row.account_verified_at,
    'suburb', row.signup_suburb,
    'schoolLabel', row.signup_school_label,
    'displayName', row.display_name
  );
end;
$$;

revoke all on function public.get_my_account_verification() from public;
grant execute on function public.get_my_account_verification() to authenticated;

create or replace function public.list_pending_account_verifications(p_school_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', p.id,
      'displayName', p.display_name,
      'accountStatus', upper(p.account_status::text),
      'accountRole', upper(p.account_role::text),
      'schoolId', p.signup_school_id,
      'suburb', p.signup_suburb,
      'schoolLabel', p.signup_school_label,
      'invitationCodePresent', p.signup_invitation_code is not null,
      'createdAt', p.created_at
    ) order by p.created_at asc)
    from public.profiles p
    where p.account_status = 'pending_verification'
      and p.account_role = 'parent'
      and (p_school_id is null or p.signup_school_id = p_school_id)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_pending_account_verifications(uuid) from public;
grant execute on function public.list_pending_account_verifications(uuid) to authenticated;

create or replace function public.verify_account_user(
  p_user_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  caller uuid := auth.uid();
  decision text := lower(trim(coalesce(p_decision, '')));
  target public.profiles%rowtype;
  membership public.school_memberships%rowtype;
begin
  if caller is null or not public.is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if decision not in ('approve', 'reject') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;

  select * into target from public.profiles where id = p_user_id for update;
  if target.id is null then
    raise exception 'user missing' using errcode = 'P0002';
  end if;

  if decision = 'approve' then
    update public.profiles
    set
      account_status = 'verified',
      account_verified_at = now(),
      updated_at = now()
    where id = p_user_id
    returning * into target;

    if target.signup_school_id is not null then
      select * into membership
      from public.school_memberships
      where user_id = p_user_id
        and school_id = target.signup_school_id
      order by created_at asc
      limit 1;

      if membership.id is not null and membership.status::text like 'pending%' then
        begin
          perform public.approve_school_membership(membership.id);
        exception when others then
          null;
        end;
      end if;
    end if;

    if target.signup_school_id is not null then
      begin
        perform public.notify_user_event_once(
          p_user_id,
          target.signup_school_id,
          'account_verified',
          'Welcome to SchoolRun Village',
          'Your profile was verified. Instant Pickup and Marketplace are now available once onboarding is complete.',
          'profile',
          target.id,
          'account_verified',
          'approved',
          'admin_verify'
        );
      exception when others then
        null;
      end;
    end if;
  else
    update public.profiles
    set
      account_status = 'rejected',
      account_verified_at = null,
      updated_at = now()
    where id = p_user_id
    returning * into target;
  end if;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    caller,
    target.signup_school_id,
    case when decision = 'approve' then 'admin.account_verify_approve' else 'admin.account_verify_reject' end,
    'profile',
    target.id,
    jsonb_build_object('decision', decision, 'accountStatus', upper(target.account_status::text))
  );

  return jsonb_build_object(
    'ok', true,
    'userId', target.id,
    'accountStatus', upper(target.account_status::text),
    'verifiedAt', target.account_verified_at
  );
end;
$$;

revoke all on function public.verify_account_user(uuid, text) from public;
grant execute on function public.verify_account_user(uuid, text) to authenticated;

create or replace function public.mark_admin_account_verified(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.profiles
  set
    account_role = 'admin',
    account_status = 'verified',
    account_verified_at = coalesce(account_verified_at, now()),
    updated_at = now()
  where id = p_user_id;
end;
$$;

revoke all on function public.mark_admin_account_verified(uuid) from public;
-- service_role / bootstrap only
grant execute on function public.mark_admin_account_verified(uuid) to service_role;

notify pgrst, 'reload schema';
