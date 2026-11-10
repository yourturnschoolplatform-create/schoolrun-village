-- Pilot: location-based school pick joins as verified without invite-code queue.
begin;
set local search_path = pg_catalog;

-- Let authenticated parents discover active schools before they have membership.
drop policy if exists schools_select_active_for_onboarding on public.schools;
create policy schools_select_active_for_onboarding on public.schools
  for select to authenticated
  using (is_active is true);

create or replace function public.join_school_self_verified(p_school_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  membership_id uuid;
  school_exists boolean := false;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_school_id is null then
    raise exception 'school required' using errcode = '22023';
  end if;

  select exists(
    select 1 from public.schools as school
    where school.id = p_school_id and school.is_active
  ) into school_exists;
  if not school_exists then
    raise exception 'school unavailable' using errcode = 'P0002';
  end if;

  select membership.id into membership_id
  from public.school_memberships as membership
  where membership.school_id = p_school_id
    and membership.user_id = caller
  for update;

  if membership_id is null then
    insert into public.school_memberships (
      school_id,
      user_id,
      status,
      verified_email_at,
      invite_code_verified_at,
      approved_by,
      approved_at
    ) values (
      p_school_id,
      caller,
      'verified',
      pg_catalog.now(),
      pg_catalog.now(),
      caller,
      pg_catalog.now()
    )
    returning id into membership_id;
  else
    update public.school_memberships as membership
    set
      status = 'verified',
      verified_email_at = coalesce(membership.verified_email_at, pg_catalog.now()),
      invite_code_verified_at = coalesce(membership.invite_code_verified_at, pg_catalog.now()),
      approved_by = coalesce(membership.approved_by, caller),
      approved_at = coalesce(membership.approved_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
    where membership.id = membership_id;
  end if;

  return membership_id;
end;
$fn$;

revoke all on function public.join_school_self_verified(uuid) from public, anon, authenticated;
grant execute on function public.join_school_self_verified(uuid) to authenticated;

commit;
