-- Task 7.1 remediation: disambiguate PL/pgSQL notice variables from table aliases.
begin;
set local search_path = pg_catalog;

create or replace function public.generate_school_notice(p_swap_leg_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  collector public.profiles%rowtype;
  existing_notice public.school_notices%rowtype;
  created_notice public.school_notices%rowtype;
  levels smallint[];
  body text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into leg from public.swap_legs where id = p_swap_leg_id for update;
  if leg.id is null then
    raise exception 'swap leg not found' using errcode = 'P0002';
  end if;
  select * into proposal from public.swap_proposals where id = leg.swap_id for update;
  if proposal.status is distinct from 'accepted'
    or proposal.school_id is distinct from leg.school_id then
    raise exception 'accepted same-school swap required' using errcode = '42501';
  end if;
  if auth.uid() not in (leg.helper_id, leg.requester_id)
    or not public.is_member(leg.school_id) then
    raise exception 'accepted swap participant required' using errcode = '42501';
  end if;
  if not public.is_member(leg.school_id) then
    raise exception 'verified active membership required' using errcode = '42501';
  end if;

  select row_notice.* into existing_notice
  from public.school_notices as row_notice
  where row_notice.swap_leg_id = leg.id and row_notice.status = 'active'
  for update;
  if existing_notice.id is not null then
    perform public.log_school_notice_access(
      existing_notice.id, existing_notice.school_id, 'viewed');
    return public.school_notice_json(existing_notice);
  end if;

  select pg_catalog.array_agg(distinct child.year_level order by child.year_level)
    into levels
  from public.child_profiles child
  join public.school_memberships membership
    on membership.id = child.membership_id
  where child.parent_id = leg.requester_id
    and membership.user_id = leg.requester_id
    and membership.school_id = leg.school_id
    and membership.status = 'verified';
  if levels is null or pg_catalog.cardinality(levels) = 0 then
    raise exception 'requester year level required' using errcode = '22023';
  end if;

  select * into collector from public.profiles where id = leg.helper_id;
  if collector.id is null or char_length(collector.display_name) not between 2 and 80 then
    raise exception 'collector display name required' using errcode = '22023';
  end if;

  body := public.school_notice_build_body(leg.service_date, levels, collector.display_name);
  if body ~* '(phone|mobile|email|@|nickname|trust|score|\$|price|AUD|amount|currency|address)' then
    raise exception 'school notice must stay phone-free' using errcode = '22023';
  end if;

  insert into public.school_notices (
    school_id, swap_id, swap_leg_id, generated_by, service_date,
    year_levels, collector_display_name, notice_body, status
  ) values (
    leg.school_id, leg.swap_id, leg.id, auth.uid(), leg.service_date,
    levels, collector.display_name, body, 'active'
  ) returning * into created_notice;

  perform public.log_school_notice_access(
    created_notice.id, created_notice.school_id, 'generated');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), created_notice.school_id, 'school_notice.generated', 'school_notice',
    created_notice.id, pg_catalog.jsonb_build_object('outcome', 'generated')
  );
  return public.school_notice_json(created_notice);
end;
$$;
revoke all on function public.generate_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.generate_school_notice(uuid) to authenticated;

create or replace function public.get_school_notice(p_notice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target public.school_notices%rowtype;
  allowed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into target from public.school_notices where id = p_notice_id;
  if target.id is null then
    raise exception 'school notice not found' using errcode = 'P0002';
  end if;

  if public.is_admin() or public.is_moderator(target.school_id) then
    allowed := true;
  elsif target.generated_by = auth.uid() then
    allowed := true;
  elsif exists (
    select 1 from public.swap_legs leg
    where leg.id = target.swap_leg_id
      and leg.school_id = target.school_id
      and auth.uid() in (leg.helper_id, leg.requester_id)
      and public.is_member(leg.school_id)
  ) then
    allowed := true;
  end if;
  if not allowed then
    raise exception 'school notice access denied' using errcode = '42501';
  end if;

  perform public.log_school_notice_access(target.id, target.school_id, 'viewed');
  return public.school_notice_json(target);
end;
$$;
revoke all on function public.get_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.get_school_notice(uuid) to authenticated;

create or replace function public.withdraw_school_notice(p_notice_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target public.school_notices%rowtype;
  allowed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into target from public.school_notices where id = p_notice_id for update;
  if target.id is null then
    raise exception 'school notice not found' using errcode = 'P0002';
  end if;
  if target.status = 'withdrawn' then
    return 'already_withdrawn';
  end if;

  if public.is_admin() or public.is_moderator(target.school_id) then
    allowed := true;
  elsif target.generated_by = auth.uid() then
    allowed := true;
  end if;
  if not allowed then
    raise exception 'school notice withdraw denied' using errcode = '42501';
  end if;

  update public.school_notices
  set status = 'withdrawn',
      withdrawn_at = pg_catalog.now(),
      withdrawn_by = auth.uid()
  where id = target.id;

  perform public.log_school_notice_access(target.id, target.school_id, 'withdrawn');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), target.school_id, 'school_notice.withdrawn', 'school_notice', target.id,
    pg_catalog.jsonb_build_object('outcome', 'withdrawn')
  );
  return 'withdrawn';
end;
$$;
revoke all on function public.withdraw_school_notice(uuid) from public, anon, authenticated;
grant execute on function public.withdraw_school_notice(uuid) to authenticated;

commit;
