-- Allow authenticated parents to insert/select instant pickup rows when the
-- create/list RPCs are unavailable, while keeping match/cancel updates RPC-gated.
begin;
set local search_path = pg_catalog;

create or replace function public.guard_instant_pickup_requests()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'instant pickup requests cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if current_setting('yourturn.instant_pickup_mutate', true) is distinct from '1'
      and (auth.uid() is null or new.requester_id is distinct from auth.uid()) then
      raise exception 'instant pickup requests insert only by requester or create RPC'
        using errcode = '42501';
    end if;
    if new.notes is not null and not public.community_text_is_allowed(new.notes) then
      raise exception 'instant pickup notes must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
    if not public.is_suburb_area_label(new.area_label) then
      raise exception 'suburb-level area label required' using errcode = '22023';
    end if;
    if new.matched_user_id is not null
      or new.check_in_status is not null
      or new.final_check_at is not null
      or new.chat_room_id is not null then
      raise exception 'instant pickup match fields are set only after accept'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if current_setting('yourturn.instant_pickup_mutate', true) is distinct from '1' then
    raise exception 'instant pickup requests update only through RPCs'
      using errcode = '42501';
  end if;
  if (new.id, new.school_id, new.requester_id, new.intent, new.direction,
      new.target_date, new.area_label, new.notes, new.created_at)
    is distinct from
     (old.id, old.school_id, old.requester_id, old.intent, old.direction,
      old.target_date, old.area_label, old.notes, old.created_at) then
    raise exception 'instant pickup request fields are immutable except match and status'
      using errcode = '55000';
  end if;

  if old.status is distinct from new.status then
    if not (
      (old.status = 'open' and new.status in ('matched', 'cancelled', 'expired'))
      or (old.status = 'matched' and new.status in ('open', 'cancelled'))
    ) then
      raise exception 'instant pickup status transition is not allowed'
        using errcode = '55000';
    end if;
  end if;

  new.updated_at := pg_catalog.now();
  return new;
end;
$fn$;

revoke all on function public.guard_instant_pickup_requests() from public, anon, authenticated;

grant select, insert on table public.instant_pickup_requests to authenticated;

drop policy if exists instant_pickup_requests_select on public.instant_pickup_requests;
create policy instant_pickup_requests_select on public.instant_pickup_requests
  for select to authenticated using (
    public.is_admin()
    or public.is_member(school_id)
    or requester_id = auth.uid()
    or school_id = (
      select profile.signup_school_id
      from public.profiles as profile
      where profile.id = auth.uid()
    )
  );

drop policy if exists instant_pickup_requests_insert on public.instant_pickup_requests;
create policy instant_pickup_requests_insert on public.instant_pickup_requests
  for insert to authenticated
  with check (
    requester_id = auth.uid()
    and (
      public.is_member(school_id)
      or school_id = (
        select membership.school_id
        from public.school_memberships as membership
        where membership.user_id = auth.uid()
        order by membership.created_at asc
        limit 1
      )
      or school_id = (
        select profile.signup_school_id
        from public.profiles as profile
        where profile.id = auth.uid()
      )
    )
  );

commit;
