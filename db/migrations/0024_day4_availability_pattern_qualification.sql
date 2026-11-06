-- pattern_id was both a function argument and an instances column, so expansion
-- raised 42702. Pattern updates also deleted instances a swap leg still references.
begin;
set local search_path = pg_catalog;

create or replace function public.expand_availability_pattern(pattern_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
#variable_conflict use_column
declare
  pattern public.availability_patterns%rowtype;
  school_today date;
  target_date date;
  created_count integer := 0;
begin
  select source_pattern.* into pattern
  from public.availability_patterns source_pattern
  where source_pattern.id = expand_availability_pattern.pattern_id;
  if pattern.id is null or not pattern.is_active then return 0; end if;
  school_today := public.school_local_today(pattern.school_id);
  for target_date in
    select pg_catalog.generate_series(
      pg_catalog.greatest(pattern.starts_on, school_today),
      pg_catalog.greatest(pattern.starts_on, school_today) + 27,
      interval '1 day'
    )::date
  loop
    if extract(isodow from target_date) = pattern.weekday
      and public.is_instructional_school_date(pattern.school_id, target_date) then
      insert into public.availability_instances as instance (
        pattern_id, school_id, owner_id, service_date, intent, direction,
        window_start, window_end, area_label, capacity
      ) values (
        pattern.id, pattern.school_id, pattern.owner_id, target_date, pattern.intent, pattern.direction,
        pattern.window_start, pattern.window_end, pattern.area_label, pattern.capacity
      ) on conflict (pattern_id, service_date) do nothing;
      if found then created_count := created_count + 1; end if;
    end if;
  end loop;
  return created_count;
end;
$$;

create or replace function public.update_availability_pattern(
  p_pattern_id uuid,
  p_intent text,
  p_direction text,
  p_weekday smallint,
  p_window_start time,
  p_window_end time,
  p_area_label text,
  p_capacity smallint,
  p_starts_on date
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  pattern public.availability_patterns%rowtype;
  school_today date;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_intent not in ('can_help', 'need_help') or p_direction not in ('pickup', 'dropoff')
    or p_weekday not between 1 and 7 or p_capacity not between 1 and 8
    or p_window_start is null or p_window_end is null or p_window_end <= p_window_start
    or not public.is_suburb_area_label(pg_catalog.trim(p_area_label)) then
    raise exception 'schedule pattern is invalid' using errcode = '22023';
  end if;
  select source_pattern.* into pattern
  from public.availability_patterns source_pattern
  where source_pattern.id = p_pattern_id and source_pattern.owner_id = auth.uid()
  for update;
  if pattern.id is null or not pattern.is_active or not public.is_member(pattern.school_id) then
    raise exception 'active owned pattern required' using errcode = '42501';
  end if;
  school_today := public.school_local_today(pattern.school_id);
  if p_starts_on < school_today then raise exception 'start date cannot be in the past' using errcode = '22023'; end if;
  update public.availability_patterns as owned set
    intent = p_intent::public.schedule_intent,
    direction = p_direction::public.school_run_direction,
    weekday = p_weekday,
    window_start = p_window_start,
    window_end = p_window_end,
    area_label = pg_catalog.trim(p_area_label),
    capacity = p_capacity,
    starts_on = p_starts_on,
    updated_at = pg_catalog.now()
  where owned.id = pattern.id;
  delete from public.availability_instances instance
  where instance.pattern_id = pattern.id
    and instance.service_date >= school_today
    and instance.status = 'open'
    and not exists (
      select 1 from public.swap_legs leg
      where leg.helper_instance_id = instance.id or leg.requester_instance_id = instance.id
    )
    and not exists (
      select 1 from public.schedule_cancellation_events event
      where event.instance_id = instance.id
    );
  perform public.expand_availability_pattern(pattern.id);
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), pattern.school_id, 'schedule.pattern_updated', 'availability_pattern', pattern.id, pg_catalog.jsonb_build_object('outcome', 'reexpanded'));
  return pattern.id;
end;
$$;

revoke all on function public.expand_availability_pattern(uuid) from public, anon, authenticated;
revoke all on function public.update_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) from public, anon, authenticated;
grant execute on function public.update_availability_pattern(uuid, text, text, smallint, time, time, text, smallint, date) to authenticated;

commit;
