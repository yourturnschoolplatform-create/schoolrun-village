-- Pin 1:1 chat rooms to community discussion threads and expose a thread
-- summary pin for Karrot-style Messages headers. Same-school only.
begin;
set local search_path = pg_catalog;

alter table public.chat_rooms
  add column if not exists community_thread_id uuid;

do $do$
begin
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chat_rooms_pin_xor_check'
  ) then
    alter table public.chat_rooms drop constraint chat_rooms_pin_xor_check;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chat_rooms_community_thread_id_fkey'
  ) then
    alter table public.chat_rooms
      add constraint chat_rooms_community_thread_id_fkey
      foreign key (community_thread_id)
      references public.community_threads(id) on delete restrict;
  end if;

  alter table public.chat_rooms
    add constraint chat_rooms_pin_xor_check check (
      (
        availability_pattern_id is not null
        and instant_pickup_request_id is null
        and item_listing_id is null
        and community_thread_id is null
      )
      or (
        availability_pattern_id is null
        and instant_pickup_request_id is not null
        and item_listing_id is null
        and community_thread_id is null
      )
      or (
        availability_pattern_id is null
        and instant_pickup_request_id is null
        and item_listing_id is not null
        and community_thread_id is null
      )
      or (
        availability_pattern_id is null
        and instant_pickup_request_id is null
        and item_listing_id is null
        and community_thread_id is not null
      )
    );
end;
$do$;

create unique index if not exists chat_rooms_community_thread_pair_uidx
  on public.chat_rooms (community_thread_id, user_low, user_high)
  where community_thread_id is not null;

comment on column public.chat_rooms.community_thread_id is
  'Optional pin to a school discussion thread for author 1:1 chat.';

-- ---------------------------------------------------------------------------
-- Thread pin JSON
-- ---------------------------------------------------------------------------
create or replace function public.chat_thread_pin_json(
  p_thread public.community_threads
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  suburb text;
begin
  select coalesce(nullif(trim(coalesce(school.suburb, '')), ''), 'Local suburb')
    into suburb
  from public.schools as school
  where school.id = p_thread.school_id;

  return pg_catalog.jsonb_build_object(
    'patternId', p_thread.id,
    'weekday', 1,
    'weekdayLabel', left(p_thread.title, 80),
    'windowStart', '',
    'windowEnd', '',
    'areaLabel', suburb,
    'direction', 'pickup',
    'intent', 'need_help',
    'pinKind', 'discussion',
    'threadId', p_thread.id,
    'threadTitle', left(p_thread.title, 120),
    'authorId', p_thread.author_id
  );
end;
$fn$;
revoke all on function public.chat_thread_pin_json(public.community_threads)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- chat_room_json with discussion branch
-- ---------------------------------------------------------------------------
create or replace function public.chat_room_json(p_room public.chat_rooms)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  pattern public.availability_patterns%rowtype;
  request public.instant_pickup_requests%rowtype;
  listing public.item_listings%rowtype;
  thread public.community_threads%rowtype;
  schedule jsonb;
  peer_id uuid;
  peer_name text;
  last_body text;
  last_at timestamptz;
  unread integer;
  my_read timestamptz;
begin
  if auth.uid() is null or auth.uid() not in (p_room.user_low, p_room.user_high) then
    raise exception 'chat participant required' using errcode = '42501';
  end if;
  peer_id := case when auth.uid() = p_room.user_low then p_room.user_high else p_room.user_low end;
  select display_name into peer_name from public.profiles where id = peer_id;

  if p_room.availability_pattern_id is not null then
    select * into pattern from public.availability_patterns where id = p_room.availability_pattern_id;
    schedule := public.chat_pattern_pin_json(pattern);
  elsif p_room.instant_pickup_request_id is not null then
    select * into request
    from public.instant_pickup_requests
    where id = p_room.instant_pickup_request_id;
    schedule := public.chat_instant_pickup_pin_json(request);
  elsif p_room.item_listing_id is not null then
    select * into listing from public.item_listings where id = p_room.item_listing_id;
    schedule := public.chat_listing_pin_json(listing);
  else
    select * into thread from public.community_threads where id = p_room.community_thread_id;
    schedule := public.chat_thread_pin_json(thread);
  end if;

  select participant.last_read_at into my_read
  from public.chat_participants as participant
  where participant.room_id = p_room.id and participant.user_id = auth.uid();
  select message.body, message.created_at
    into last_body, last_at
  from public.chat_messages as message
  where message.room_id = p_room.id
  order by message.created_at desc
  limit 1;
  select pg_catalog.count(*)::integer into unread
  from public.chat_messages as message
  where message.room_id = p_room.id
    and message.sender_id is distinct from auth.uid()
    and (my_read is null or message.created_at > my_read);
  return pg_catalog.jsonb_build_object(
    'id', p_room.id,
    'schoolId', p_room.school_id,
    'peerUserId', peer_id,
    'peerDisplayName', coalesce(peer_name, 'Parent'),
    'schedule', schedule,
    'lastMessageBody', last_body,
    'lastMessageAt', last_at,
    'unreadCount', coalesce(unread, 0),
    'createdAt', p_room.created_at
  );
end;
$fn$;
revoke all on function public.chat_room_json(public.chat_rooms) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Open or create 1:1 chat with the discussion thread author
-- ---------------------------------------------------------------------------
create or replace function public.get_or_create_thread_chat(p_thread_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  thread public.community_threads%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  membership := public.community_caller_membership();
  select * into thread from public.community_threads where id = p_thread_id for share;
  if thread.id is null
    or thread.school_id is distinct from membership.school_id
    or thread.status is distinct from 'active'
    or not public.is_member(thread.school_id) then
    raise exception 'discussion unavailable' using errcode = '42501';
  end if;
  if thread.author_id = auth.uid() then
    raise exception 'authors cannot open discussion chat with themselves' using errcode = '22023';
  end if;

  low_id := pg_catalog.least(auth.uid(), thread.author_id);
  high_id := pg_catalog.greatest(auth.uid(), thread.author_id);

  select * into room
  from public.chat_rooms
  where community_thread_id = thread.id
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
      thread.school_id, null, null, null, thread.id, low_id, high_id
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
revoke all on function public.get_or_create_thread_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_thread_chat(uuid) to authenticated;

commit;
