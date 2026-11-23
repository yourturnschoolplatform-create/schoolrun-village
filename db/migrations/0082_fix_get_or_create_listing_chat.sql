-- Fix Market "Chat 1:1" → get_or_create_listing_chat.
--
-- Production symptoms: HTTP 404 on /rest/v1/rpc/get_or_create_listing_chat
-- (PostgREST schema cache miss / missing GRANT) and/or runtime 42883 from
-- pg_catalog.least(uuid,uuid) under search_path=pg_catalog.
-- Soft-joined parents also fail listing_caller_membership() → is_member().
--
-- This migration: drop/recreate RPC, uuid text ordering, soft school access,
-- GRANT EXECUTE, notify pgrst.
begin;
set local search_path = pg_catalog;

drop function if exists public.get_or_create_listing_chat(uuid);

create function public.get_or_create_listing_chat(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  listing public.item_listings%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
  caller uuid := auth.uid();
  has_access boolean := false;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_listing_id is null then
    raise exception 'p_listing_id is required' using errcode = '22023';
  end if;

  -- Soft onboarding / neighbourhood: verified membership OR signup school.
  select exists (
    select 1
    from public.school_memberships as membership
    where membership.user_id = caller
      and membership.status = 'verified'
  ) or exists (
    select 1
    from public.profiles as profile
    where profile.id = caller
      and profile.signup_school_id is not null
      and not profile.admin_suspended
  ) into has_access;

  if not has_access then
    raise exception 'verified membership required' using errcode = '42501';
  end if;

  select * into listing
  from public.item_listings
  where id = p_listing_id
  for share;

  if listing.id is null or listing.status is distinct from 'active' then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;

  if listing.author_id = caller then
    raise exception 'authors cannot open marketplace chat with themselves'
      using errcode = '22023';
  end if;

  -- uuid has no pg_catalog.least/greatest under search_path=pg_catalog.
  low_id := case
    when caller::text < listing.author_id::text then caller
    else listing.author_id
  end;
  high_id := case
    when caller::text < listing.author_id::text then listing.author_id
    else caller
  end;

  select * into room
  from public.chat_rooms
  where item_listing_id = listing.id
    and user_low = low_id
    and user_high = high_id
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
      listing.school_id,
      null,
      null,
      listing.id,
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

  return public.chat_room_json(room);
end;
$fn$;

comment on function public.get_or_create_listing_chat(uuid) is
  'PostgREST: { "p_listing_id": "<uuid>" }. Open or create 1:1 marketplace chat with the listing author. Soft membership OK; neighbourhood listings allowed.';

revoke all on function public.get_or_create_listing_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_listing_chat(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
