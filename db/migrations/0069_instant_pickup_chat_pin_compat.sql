-- Keep instant-pickup match chat inserts compatible with listing/thread pin XOR.
begin;
set local search_path = pg_catalog;

-- Drop first so return-type / signature changes do not raise 42P13.
drop function if exists public.accept_instant_pickup_request(uuid);

create or replace function public.accept_instant_pickup_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  request public.instant_pickup_requests%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
  pickup_at timestamptz;
  checkpoint timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  membership := public.instant_pickup_caller_membership();
  perform public.release_stale_instant_pickup_matches();

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;
  if request.id is null
    or request.school_id is distinct from membership.school_id
    or not public.is_member(request.school_id) then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;
  if request.status is distinct from 'open' then
    raise exception 'instant pickup request is not open' using errcode = '22023';
  end if;
  if request.requester_id = auth.uid() then
    raise exception 'cannot accept your own instant pickup request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles as profile
    where profile.id = request.requester_id
      and not profile.admin_suspended
  ) then
    raise exception 'instant pickup requester unavailable' using errcode = '42501';
  end if;

  low_id := pg_catalog.least(auth.uid(), request.requester_id);
  high_id := pg_catalog.greatest(auth.uid(), request.requester_id);
  pickup_at := public.instant_pickup_pickup_at(request);
  checkpoint := pickup_at - interval '30 minutes';
  if pg_catalog.now() >= pickup_at then
    raise exception 'instant pickup window has already passed' using errcode = '22023';
  end if;

  select * into room
  from public.chat_rooms
  where instant_pickup_request_id = request.id
  for update;

  if room.id is null then
    perform set_config('yourturn.chat_room_mutate', '1', true);
    insert into public.chat_rooms (
      school_id,
      availability_pattern_id,
      instant_pickup_request_id,
      item_listing_id,
      community_thread_id,
      user_low,
      user_high
    ) values (
      request.school_id,
      null,
      request.id,
      null,
      null,
      low_id,
      high_id
    ) returning * into room;
    insert into public.chat_participants (room_id, school_id, user_id)
    values
      (room.id, room.school_id, low_id),
      (room.id, room.school_id, high_id);
    perform set_config('yourturn.chat_room_mutate', '', true);
  end if;

  perform set_config('yourturn.instant_pickup_mutate', '1', true);
  update public.instant_pickup_requests as row_request
  set
    status = 'matched',
    matched_user_id = auth.uid(),
    check_in_status = 'pending',
    final_check_at = checkpoint,
    chat_room_id = room.id
  where row_request.id = request.id
  returning * into request;
  perform set_config('yourturn.instant_pickup_mutate', '', true);

  return pg_catalog.jsonb_build_object(
    'request', public.instant_pickup_request_json(request),
    'chatRoom', public.chat_room_json(room)
  );
end;
$fn$;
revoke all on function public.accept_instant_pickup_request(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_instant_pickup_request(uuid) to authenticated;

commit;
