-- Day 12: live instant-pickup matching, 1:1 chat handoff, and 30-minute final check-in.
-- Matched requests pin a chat room. Unconfirmed or cancelled at the final checkpoint
-- reopens to the board with a cancel_under_2h trust penalty.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Columns on instant_pickup_requests (one ADD COLUMN per statement)
-- ---------------------------------------------------------------------------
alter table public.instant_pickup_requests
  add column if not exists matched_user_id uuid;

alter table public.instant_pickup_requests
  add column if not exists check_in_status text;

alter table public.instant_pickup_requests
  add column if not exists final_check_at timestamptz;

alter table public.instant_pickup_requests
  add column if not exists chat_room_id uuid;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'instant_pickup_requests_matched_user_id_fkey'
  ) then
    alter table public.instant_pickup_requests
      add constraint instant_pickup_requests_matched_user_id_fkey
      foreign key (matched_user_id)
      references public.profiles(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'instant_pickup_requests_check_in_status_check'
  ) then
    alter table public.instant_pickup_requests
      add constraint instant_pickup_requests_check_in_status_check
      check (
        check_in_status is null
        or check_in_status in ('pending', 'confirmed')
      );
  end if;
end;
$do$;

comment on column public.instant_pickup_requests.matched_user_id is
  'Parent who accepted the open board request. Null while status is open.';
comment on column public.instant_pickup_requests.check_in_status is
  'pending once matched, confirmed after final check-in, null when open or released.';
comment on column public.instant_pickup_requests.final_check_at is
  'School-local pickup instant minus 30 minutes. Check-in opens at this time.';
comment on column public.instant_pickup_requests.chat_room_id is
  '1:1 chat room opened when the match is accepted.';

create index if not exists instant_pickup_requests_matched_user_idx
  on public.instant_pickup_requests (matched_user_id, status, created_at desc)
  where matched_user_id is not null;

create index if not exists instant_pickup_requests_final_check_idx
  on public.instant_pickup_requests (final_check_at)
  where status = 'matched' and check_in_status = 'pending';

-- ---------------------------------------------------------------------------
-- Chat rooms: allow instant-pickup pin (XOR with availability pattern)
-- ---------------------------------------------------------------------------
alter table public.chat_rooms
  alter column availability_pattern_id drop not null;

alter table public.chat_rooms
  add column if not exists instant_pickup_request_id uuid;

do $do$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chat_rooms_instant_pickup_request_id_fkey'
  ) then
    alter table public.chat_rooms
      add constraint chat_rooms_instant_pickup_request_id_fkey
      foreign key (instant_pickup_request_id)
      references public.instant_pickup_requests(id) on delete restrict;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chat_rooms_pin_xor_check'
  ) then
    alter table public.chat_rooms
      add constraint chat_rooms_pin_xor_check check (
        (availability_pattern_id is not null and instant_pickup_request_id is null)
        or (availability_pattern_id is null and instant_pickup_request_id is not null)
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'instant_pickup_requests_chat_room_id_fkey'
  ) then
    alter table public.instant_pickup_requests
      add constraint instant_pickup_requests_chat_room_id_fkey
      foreign key (chat_room_id)
      references public.chat_rooms(id) on delete set null;
  end if;
end;
$do$;

create unique index if not exists chat_rooms_instant_pickup_uidx
  on public.chat_rooms (instant_pickup_request_id)
  where instant_pickup_request_id is not null;

-- ---------------------------------------------------------------------------
-- Guard: allow match / check-in field updates through RPCs
-- ---------------------------------------------------------------------------
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
    if current_setting('yourturn.instant_pickup_mutate', true) is distinct from '1' then
      raise exception 'instant pickup requests insert only through create RPC'
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

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.instant_pickup_default_window(
  p_direction public.school_run_direction
)
returns time
language sql
immutable
set search_path = pg_catalog
as $fn$
  select case p_direction
    when 'pickup'::public.school_run_direction then time '15:15'
    else time '08:30'
  end
$fn$;
revoke all on function public.instant_pickup_default_window(public.school_run_direction)
  from public, anon, authenticated;

create or replace function public.instant_pickup_pickup_at(
  p_request public.instant_pickup_requests
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  school_tz text;
  window_time time;
begin
  select school.timezone into school_tz
  from public.schools as school
  where school.id = p_request.school_id;
  if school_tz is null then
    raise exception 'school timezone unavailable' using errcode = 'P0002';
  end if;
  window_time := public.instant_pickup_default_window(p_request.direction);
  return pg_catalog.timezone(school_tz, p_request.target_date + window_time);
end;
$fn$;
revoke all on function public.instant_pickup_pickup_at(public.instant_pickup_requests)
  from public, anon, authenticated;

create or replace function public.instant_pickup_request_json(
  p_request public.instant_pickup_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  display_name text;
  matched_name text;
  pickup_at timestamptz;
begin
  if auth.uid() is null or not public.is_member(p_request.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  select profile.display_name into display_name
  from public.profiles as profile
  where profile.id = p_request.requester_id;
  if p_request.matched_user_id is not null then
    select profile.display_name into matched_name
    from public.profiles as profile
    where profile.id = p_request.matched_user_id;
  end if;
  pickup_at := public.instant_pickup_pickup_at(p_request);
  return pg_catalog.jsonb_build_object(
    'id', p_request.id,
    'schoolId', p_request.school_id,
    'requesterId', p_request.requester_id,
    'requesterDisplayName', coalesce(display_name, 'Parent'),
    'matchedUserId', p_request.matched_user_id,
    'matchedDisplayName', matched_name,
    'intent', p_request.intent::text,
    'direction', p_request.direction::text,
    'targetDate', p_request.target_date,
    'areaLabel', p_request.area_label,
    'notes', p_request.notes,
    'status', p_request.status::text,
    'checkInStatus', p_request.check_in_status,
    'finalCheckAt', p_request.final_check_at,
    'pickupAt', pickup_at,
    'chatRoomId', p_request.chat_room_id,
    'mine', p_request.requester_id = auth.uid(),
    'iAmMatched', p_request.matched_user_id = auth.uid(),
    'createdAt', p_request.created_at
  );
end;
$fn$;
revoke all on function public.instant_pickup_request_json(public.instant_pickup_requests)
  from public, anon, authenticated;

create or replace function public.chat_instant_pickup_pin_json(
  p_request public.instant_pickup_requests
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select pg_catalog.jsonb_build_object(
    'patternId', p_request.id,
    'weekday', pg_catalog.date_part('isodow', p_request.target_date)::integer,
    'weekdayLabel', public.chat_weekday_label(
      pg_catalog.date_part('isodow', p_request.target_date)::smallint
    ),
    'windowStart', public.instant_pickup_default_window(p_request.direction)::text,
    'windowEnd', (
      public.instant_pickup_default_window(p_request.direction)
      + interval '30 minutes'
    )::time::text,
    'areaLabel', p_request.area_label,
    'direction', p_request.direction::text,
    'intent', p_request.intent::text
  )
$fn$;
revoke all on function public.chat_instant_pickup_pin_json(public.instant_pickup_requests)
  from public, anon, authenticated;

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
  else
    select * into request
    from public.instant_pickup_requests
    where id = p_room.instant_pickup_request_id;
    schedule := public.chat_instant_pickup_pin_json(request);
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

create or replace function public.release_instant_pickup_match(
  p_request_id uuid,
  p_penalty_user_id uuid
)
returns public.instant_pickup_requests
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
begin
  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;
  if request.id is null or request.status is distinct from 'matched' then
    return request;
  end if;

  perform set_config('yourturn.instant_pickup_mutate', '1', true);
  update public.instant_pickup_requests as row_request
  set
    status = 'open',
    matched_user_id = null,
    check_in_status = null,
    final_check_at = null,
    chat_room_id = null
  where row_request.id = request.id
  returning * into request;
  perform set_config('yourturn.instant_pickup_mutate', '', true);

  if p_penalty_user_id is not null then
    perform public.apply_trust_score_delta(
      p_penalty_user_id,
      request.school_id,
      public.trust_policy_delta(request.school_id, 'cancel_under_2h'),
      'cancel_under_2h',
      'instant_pickup_request',
      request.id
    );
  end if;

  return request;
end;
$fn$;
revoke all on function public.release_instant_pickup_match(uuid, uuid)
  from public, anon, authenticated;

-- Auto-release matches that stay unconfirmed through the pickup instant.
-- Avoid FOR-IN ... FOR UPDATE SKIP LOCKED (PL/pgSQL parser ambiguity).
create or replace function public.release_stale_instant_pickup_matches()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  stale_id uuid;
  penalty_user uuid;
  released integer := 0;
begin
  loop
    select request.id,
           coalesce(request.matched_user_id, request.requester_id)
      into stale_id, penalty_user
    from public.instant_pickup_requests as request
    where request.status = 'matched'
      and request.check_in_status = 'pending'
      and request.final_check_at is not null
      and pg_catalog.now() >= (request.final_check_at + interval '30 minutes')
    order by request.final_check_at asc
    for update of request skip locked
    limit 1;

    exit when stale_id is null;

    perform public.release_instant_pickup_match(stale_id, penalty_user);
    released := released + 1;
    stale_id := null;
    penalty_user := null;
  end loop;
  return released;
end;
$fn$;
revoke all on function public.release_stale_instant_pickup_matches()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- List: include own matched rows and sweep stale first
-- ---------------------------------------------------------------------------
create or replace function public.list_instant_pickup_requests(p_include_closed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  school_today date;
begin
  membership := public.instant_pickup_caller_membership();
  perform public.release_stale_instant_pickup_matches();
  school_today := public.school_local_today(membership.school_id);
  return coalesce((
    select pg_catalog.jsonb_agg(public.instant_pickup_request_json(request) order by request.created_at desc)
    from public.instant_pickup_requests as request
    where request.school_id = membership.school_id
      and request.target_date >= school_today - 1
      and (
        p_include_closed
        or request.status = 'open'
        or request.requester_id = auth.uid()
        or request.matched_user_id = auth.uid()
      )
  ), '[]'::jsonb);
end;
$fn$;
revoke all on function public.list_instant_pickup_requests(boolean)
  from public, anon, authenticated;
grant execute on function public.list_instant_pickup_requests(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Accept and open 1:1 chat
-- ---------------------------------------------------------------------------
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
      school_id, availability_pattern_id, instant_pickup_request_id, user_low, user_high
    ) values (
      request.school_id, null, request.id, low_id, high_id
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

-- ---------------------------------------------------------------------------
-- Final check-in (30 minutes before pickup)
-- ---------------------------------------------------------------------------
create or replace function public.check_in_instant_pickup(
  p_request_id uuid,
  p_confirm boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.release_stale_instant_pickup_matches();

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;
  if request.id is null
    or not public.is_member(request.school_id)
    or auth.uid() not in (request.requester_id, request.matched_user_id) then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;
  if request.status is distinct from 'matched' then
    return public.instant_pickup_request_json(request);
  end if;
  if request.final_check_at is null then
    raise exception 'final check-in is not scheduled' using errcode = '22023';
  end if;

  if coalesce(p_confirm, false) then
    if pg_catalog.now() < request.final_check_at then
      raise exception 'final check-in opens 30 minutes before pickup'
        using errcode = '22023';
    end if;
    if pg_catalog.now() >= (request.final_check_at + interval '30 minutes') then
      request := public.release_instant_pickup_match(request.id, auth.uid());
      return public.instant_pickup_request_json(request);
    end if;
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set check_in_status = 'confirmed'
    where row_request.id = request.id
    returning * into request;
    perform set_config('yourturn.instant_pickup_mutate', '', true);
    return public.instant_pickup_request_json(request);
  end if;

  -- Decline / cancel the live match.
  if pg_catalog.now() >= request.final_check_at then
    request := public.release_instant_pickup_match(request.id, auth.uid());
  else
    -- Early release before the 30-minute checkpoint: no trust penalty.
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set
      status = 'open',
      matched_user_id = null,
      check_in_status = null,
      final_check_at = null,
      chat_room_id = null
    where row_request.id = request.id
    returning * into request;
    perform set_config('yourturn.instant_pickup_mutate', '', true);
  end if;

  return public.instant_pickup_request_json(request);
end;
$fn$;
revoke all on function public.check_in_instant_pickup(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.check_in_instant_pickup(uuid, boolean) to authenticated;

-- Open chat for an already-matched request (participant only).
create or replace function public.get_instant_pickup_chat(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
  room public.chat_rooms%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into request
  from public.instant_pickup_requests
  where id = p_request_id;
  if request.id is null
    or request.chat_room_id is null
    or auth.uid() not in (request.requester_id, request.matched_user_id)
    or not public.is_member(request.school_id) then
    raise exception 'instant pickup chat unavailable' using errcode = '42501';
  end if;
  select * into room from public.chat_rooms where id = request.chat_room_id;
  if room.id is null then
    raise exception 'instant pickup chat unavailable' using errcode = '42501';
  end if;
  return public.chat_room_json(room);
end;
$fn$;
revoke all on function public.get_instant_pickup_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_instant_pickup_chat(uuid) to authenticated;

commit;
