-- Day 11: school-scoped 1:1 direct chat pinned to an availability pattern.
-- Phone-free text via community_text_is_allowed. No photos, amounts or live location.
-- Realtime: chat_messages added to supabase_realtime when the publication exists.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  availability_pattern_id uuid not null
    references public.availability_patterns(id) on delete restrict,
  user_low uuid not null references public.profiles(id) on delete cascade,
  user_high uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_low < user_high),
  unique (availability_pattern_id, user_low, user_high)
);

create index chat_rooms_school_idx on public.chat_rooms (school_id, created_at desc);
create index chat_rooms_user_low_idx on public.chat_rooms (user_low, created_at desc);
create index chat_rooms_user_high_idx on public.chat_rooms (user_high, created_at desc);
alter table public.chat_rooms
  add constraint chat_rooms_id_school_key unique (id, school_id);

comment on table public.chat_rooms is
  '1:1 chat rooms scoped to a school and pinned availability pattern. Ordered user pair.';

create table public.chat_participants (
  room_id uuid not null,
  school_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, school_id)
    references public.chat_rooms(id, school_id) on delete cascade,
  foreign key (school_id) references public.schools(id) on delete restrict
);

create index chat_participants_user_idx
  on public.chat_participants (user_id, joined_at desc);

comment on table public.chat_participants is
  'Exactly two participants per room. last_read_at drives read receipts.';

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  school_id uuid not null,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  body text not null
    check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  foreign key (room_id, school_id)
    references public.chat_rooms(id, school_id) on delete cascade,
  foreign key (room_id, sender_id)
    references public.chat_participants(room_id, user_id) on delete restrict
);

create index chat_messages_room_idx
  on public.chat_messages (room_id, created_at desc);
create index chat_messages_school_idx
  on public.chat_messages (school_id, created_at desc);

comment on table public.chat_messages is
  '1:1 chat messages. Text only; phones/emails/photos blocked by guard.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function public.guard_chat_messages()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'chat messages cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'chat messages are immutable' using errcode = '55000';
  end if;
  if not public.community_text_is_allowed(new.body) then
    raise exception 'chat text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if current_setting('yourturn.chat_message_insert', true) is distinct from '1' then
    raise exception 'chat messages insert only through send_chat_message'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_chat_messages() from public, anon, authenticated;

create trigger chat_messages_guard_rows
  before insert or update or delete on public.chat_messages
  for each row execute function public.guard_chat_messages();
create trigger chat_messages_guard_truncate
  before truncate on public.chat_messages
  for each statement execute function public.guard_chat_messages();
alter table public.chat_messages enable always trigger chat_messages_guard_rows;
alter table public.chat_messages enable always trigger chat_messages_guard_truncate;

create function public.guard_chat_rooms()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op in ('UPDATE', 'DELETE', 'TRUNCATE') then
    if current_setting('yourturn.chat_room_mutate', true) is distinct from '1' then
      raise exception 'chat rooms are RPC-managed' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT'
    and current_setting('yourturn.chat_room_mutate', true) is distinct from '1' then
    raise exception 'chat rooms insert only through get_or_create RPCs'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.guard_chat_rooms() from public, anon, authenticated;

create trigger chat_rooms_guard_rows
  before insert or update or delete on public.chat_rooms
  for each row execute function public.guard_chat_rooms();
create trigger chat_rooms_guard_truncate
  before truncate on public.chat_rooms
  for each statement execute function public.guard_chat_rooms();
alter table public.chat_rooms enable always trigger chat_rooms_guard_rows;
alter table public.chat_rooms enable always trigger chat_rooms_guard_truncate;

create function public.guard_chat_participants()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'chat participants cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'INSERT'
    and current_setting('yourturn.chat_room_mutate', true) is distinct from '1' then
    raise exception 'chat participants insert only through get_or_create RPCs'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    -- Only last_read_at may change, and only via mark_chat_room_read.
    if current_setting('yourturn.chat_mark_read', true) is distinct from '1' then
      raise exception 'chat participants update only through mark_chat_room_read'
        using errcode = '42501';
    end if;
    if (new.room_id, new.school_id, new.user_id, new.joined_at)
      is distinct from (old.room_id, old.school_id, old.user_id, old.joined_at) then
      raise exception 'chat participant identity is immutable' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_chat_participants() from public, anon, authenticated;

create trigger chat_participants_guard_rows
  before insert or update or delete on public.chat_participants
  for each row execute function public.guard_chat_participants();
create trigger chat_participants_guard_truncate
  before truncate on public.chat_participants
  for each statement execute function public.guard_chat_participants();
alter table public.chat_participants enable always trigger chat_participants_guard_rows;
alter table public.chat_participants enable always trigger chat_participants_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.chat_rooms enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;

revoke all on table public.chat_rooms from public, anon, authenticated;
revoke all on table public.chat_participants from public, anon, authenticated;
revoke all on table public.chat_messages from public, anon, authenticated;

grant select on table public.chat_rooms to authenticated;
grant select on table public.chat_participants to authenticated;
grant select on table public.chat_messages to authenticated;

create policy chat_rooms_select on public.chat_rooms
  for select to authenticated using (
    public.is_admin()
    or (
      public.is_member(school_id)
      and auth.uid() in (user_low, user_high)
    )
  );

create policy chat_participants_select on public.chat_participants
  for select to authenticated using (
    public.is_admin()
    or (
      public.is_member(school_id)
      and (
        user_id = auth.uid()
        or exists (
          select 1 from public.chat_participants as self
          where self.room_id = chat_participants.room_id
            and self.user_id = auth.uid()
        )
      )
    )
  );

create policy chat_messages_select on public.chat_messages
  for select to authenticated using (
    public.is_admin()
    or (
      public.is_member(school_id)
      and exists (
        select 1 from public.chat_participants as participant
        where participant.room_id = chat_messages.room_id
          and participant.user_id = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime (best-effort when publication exists)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'chat_messages'
    ) then
    execute 'alter publication supabase_realtime add table public.chat_messages';
  end if;
exception
  when others then
    null;
end $$;

-- ---------------------------------------------------------------------------
-- JSON helpers
-- ---------------------------------------------------------------------------
create function public.chat_weekday_label(p_weekday smallint)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_weekday
    when 1 then 'Monday'
    when 2 then 'Tuesday'
    when 3 then 'Wednesday'
    when 4 then 'Thursday'
    when 5 then 'Friday'
    when 6 then 'Saturday'
    when 7 then 'Sunday'
    else 'Day'
  end;
$$;
revoke all on function public.chat_weekday_label(smallint) from public, anon, authenticated;

create function public.chat_pattern_pin_json(p_pattern public.availability_patterns)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'patternId', p_pattern.id,
    'weekday', p_pattern.weekday,
    'weekdayLabel', public.chat_weekday_label(p_pattern.weekday),
    'windowStart', p_pattern.window_start::text,
    'windowEnd', p_pattern.window_end::text,
    'areaLabel', p_pattern.area_label,
    'direction', p_pattern.direction::text,
    'intent', p_pattern.intent::text
  );
$$;
revoke all on function public.chat_pattern_pin_json(public.availability_patterns) from public, anon, authenticated;

create function public.chat_room_json(p_room public.chat_rooms)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  pattern public.availability_patterns%rowtype;
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
  select * into pattern from public.availability_patterns where id = p_room.availability_pattern_id;
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
    'schedule', public.chat_pattern_pin_json(pattern),
    'lastMessageBody', last_body,
    'lastMessageAt', last_at,
    'unreadCount', coalesce(unread, 0),
    'createdAt', p_room.created_at
  );
end;
$$;
revoke all on function public.chat_room_json(public.chat_rooms) from public, anon, authenticated;

create function public.chat_message_json(
  p_message public.chat_messages,
  p_peer_last_read timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_message.id,
    'roomId', p_message.room_id,
    'senderId', p_message.sender_id,
    'body', p_message.body,
    'createdAt', p_message.created_at,
    'mine', p_message.sender_id = auth.uid(),
    'readByPeer', p_message.sender_id = auth.uid()
      and p_peer_last_read is not null
      and p_peer_last_read >= p_message.created_at
  );
$$;
revoke all on function public.chat_message_json(public.chat_messages, timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
create function public.get_or_create_schedule_chat(
  p_peer_user_id uuid,
  p_availability_pattern_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  pattern public.availability_patterns%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_peer_user_id is null or p_peer_user_id = auth.uid() then
    raise exception 'peer parent required' using errcode = '22023';
  end if;

  select * into pattern
  from public.availability_patterns
  where id = p_availability_pattern_id and is_active
  for share;
  if pattern.id is null then
    raise exception 'schedule pattern unavailable' using errcode = 'P0002';
  end if;
  if not public.is_member(pattern.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.school_memberships as membership
    join public.profiles as profile on profile.id = membership.user_id
    where membership.user_id = p_peer_user_id
      and membership.school_id = pattern.school_id
      and membership.status = 'verified'
      and not profile.admin_suspended
  ) then
    raise exception 'peer parent unavailable' using errcode = '42501';
  end if;

  low_id := pg_catalog.least(auth.uid(), p_peer_user_id);
  high_id := pg_catalog.greatest(auth.uid(), p_peer_user_id);

  select * into room
  from public.chat_rooms
  where availability_pattern_id = pattern.id
    and user_low = low_id
    and user_high = high_id
  for update;

  if room.id is null then
    perform set_config('yourturn.chat_room_mutate', '1', true);
    insert into public.chat_rooms (
      school_id, availability_pattern_id, user_low, user_high
    ) values (
      pattern.school_id, pattern.id, low_id, high_id
    ) returning * into room;
    insert into public.chat_participants (room_id, school_id, user_id)
    values
      (room.id, room.school_id, low_id),
      (room.id, room.school_id, high_id);
    perform set_config('yourturn.chat_room_mutate', '', true);
  end if;

  return public.chat_room_json(room);
end;
$$;
revoke all on function public.get_or_create_schedule_chat(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_schedule_chat(uuid, uuid) to authenticated;

create function public.get_or_create_swap_chat(p_swap_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  proposal public.swap_proposals%rowtype;
  peer_id uuid;
  pattern_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into proposal from public.swap_proposals where id = p_swap_id for share;
  if proposal.id is null or proposal.status is distinct from 'accepted' then
    raise exception 'accepted swap required' using errcode = 'P0002';
  end if;
  if auth.uid() not in (proposal.proposer_id, proposal.recipient_id) then
    raise exception 'swap participant required' using errcode = '42501';
  end if;
  if not public.is_member(proposal.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  peer_id := case
    when auth.uid() = proposal.proposer_id then proposal.recipient_id
    else proposal.proposer_id
  end;
  select coalesce(help.pattern_id, need.pattern_id) into pattern_id
  from public.swap_legs as leg
  left join public.availability_instances as help on help.id = leg.helper_instance_id
  left join public.availability_instances as need on need.id = leg.requester_instance_id
  where leg.swap_id = proposal.id
  order by leg.service_date
  limit 1;
  if pattern_id is null then
    raise exception 'swap schedule pattern unavailable' using errcode = 'P0002';
  end if;
  return public.get_or_create_schedule_chat(peer_id, pattern_id);
end;
$$;
revoke all on function public.get_or_create_swap_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_swap_chat(uuid) to authenticated;

create function public.list_my_chat_rooms()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(public.chat_room_json(room) order by coalesce(
      (select max(message.created_at) from public.chat_messages as message where message.room_id = room.id),
      room.created_at
    ) desc)
    from public.chat_rooms as room
    where auth.uid() in (room.user_low, room.user_high)
      and public.is_member(room.school_id)
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_my_chat_rooms() from public, anon, authenticated;
grant execute on function public.list_my_chat_rooms() to authenticated;

create function public.list_chat_messages(
  p_room_id uuid,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  room public.chat_rooms%rowtype;
  peer_read timestamptz;
  lim integer := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into room from public.chat_rooms where id = p_room_id;
  if room.id is null or auth.uid() not in (room.user_low, room.user_high)
    or not public.is_member(room.school_id) then
    raise exception 'chat room unavailable' using errcode = '42501';
  end if;
  select participant.last_read_at into peer_read
  from public.chat_participants as participant
  where participant.room_id = room.id
    and participant.user_id is distinct from auth.uid();
  return coalesce((
    select pg_catalog.jsonb_agg(item.payload order by item.created_at asc)
    from (
      select
        message.created_at,
        public.chat_message_json(message, peer_read) as payload
      from public.chat_messages as message
      where message.room_id = room.id
        and (p_before is null or message.created_at < p_before)
      order by message.created_at desc
      limit lim
    ) as item
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_chat_messages(uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_chat_messages(uuid, timestamptz, integer) to authenticated;

create function public.send_chat_message(p_room_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  room public.chat_rooms%rowtype;
  message public.chat_messages%rowtype;
  peer_read timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into room from public.chat_rooms where id = p_room_id for share;
  if room.id is null or auth.uid() not in (room.user_low, room.user_high)
    or not public.is_member(room.school_id) then
    raise exception 'chat room unavailable' using errcode = '42501';
  end if;
  if not public.community_text_is_allowed(p_body) then
    raise exception 'chat text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  perform set_config('yourturn.chat_message_insert', '1', true);
  insert into public.chat_messages (room_id, school_id, sender_id, body)
  values (room.id, room.school_id, auth.uid(), trim(p_body))
  returning * into message;
  perform set_config('yourturn.chat_message_insert', '', true);

  perform set_config('yourturn.chat_mark_read', '1', true);
  update public.chat_participants as participant
  set last_read_at = greatest(coalesce(participant.last_read_at, '-infinity'::timestamptz), message.created_at)
  where participant.room_id = room.id and participant.user_id = auth.uid();
  perform set_config('yourturn.chat_mark_read', '', true);

  select participant.last_read_at into peer_read
  from public.chat_participants as participant
  where participant.room_id = room.id
    and participant.user_id is distinct from auth.uid();

  return public.chat_message_json(message, peer_read);
end;
$$;
revoke all on function public.send_chat_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.send_chat_message(uuid, text) to authenticated;

create function public.mark_chat_room_read(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  room public.chat_rooms%rowtype;
  stamped timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into room from public.chat_rooms where id = p_room_id for share;
  if room.id is null or auth.uid() not in (room.user_low, room.user_high)
    or not public.is_member(room.school_id) then
    raise exception 'chat room unavailable' using errcode = '42501';
  end if;
  perform set_config('yourturn.chat_mark_read', '1', true);
  update public.chat_participants as participant
  set last_read_at = stamped
  where participant.room_id = room.id and participant.user_id = auth.uid();
  perform set_config('yourturn.chat_mark_read', '', true);
  return pg_catalog.jsonb_build_object('roomId', room.id, 'lastReadAt', stamped);
end;
$$;
revoke all on function public.mark_chat_room_read(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_chat_room_read(uuid) to authenticated;

commit;
