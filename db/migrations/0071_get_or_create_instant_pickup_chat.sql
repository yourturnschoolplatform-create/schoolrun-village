-- get_instant_pickup_chat: get-or-create for matched participants when chat_room_id is missing.
-- Frontend contract: rpc('get_instant_pickup_chat', { p_request_id: <uuid> }) → chat_room_json
begin;
set local search_path = pg_catalog;

drop function if exists public.get_instant_pickup_chat(uuid);

create function public.get_instant_pickup_chat(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;

  if request.id is null
    or request.status is distinct from 'matched'
    or request.matched_user_id is null
    or auth.uid() not in (request.requester_id, request.matched_user_id)
    or not public.is_member(request.school_id) then
    raise exception 'instant pickup chat unavailable' using errcode = '42501';
  end if;

  if request.chat_room_id is not null then
    select * into room
    from public.chat_rooms
    where id = request.chat_room_id;
  end if;

  if room.id is null then
    select * into room
    from public.chat_rooms
    where instant_pickup_request_id = request.id
    for update;
  end if;

  if room.id is null then
    low_id := pg_catalog.least(request.requester_id, request.matched_user_id);
    high_id := pg_catalog.greatest(request.requester_id, request.matched_user_id);

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

  if request.chat_room_id is distinct from room.id then
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set chat_room_id = room.id
    where row_request.id = request.id;
    perform set_config('yourturn.instant_pickup_mutate', '', true);
  end if;

  return public.chat_room_json(room);
end;
$fn$;

comment on function public.get_instant_pickup_chat(uuid) is
  'PostgREST RPC args: { "p_request_id": "<uuid>" }. Get or create match chat for participants.';

revoke all on function public.get_instant_pickup_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_instant_pickup_chat(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
