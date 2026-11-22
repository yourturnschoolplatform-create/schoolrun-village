-- Fix accept_instant_pickup_request for soft-joined / multi-school parents.
-- Root causes in 0070:
--   1) instant_pickup_caller_membership() binds to the oldest membership, then
--      requires request.school_id = that school — wrong when the open post is on
--      a later school (e.g. ensure_and_join_school).
--   2) Full is_member() also requires a per-school safety declaration, which
--      soft onboarding does not create — so verified membership still fails.
-- Gate on verified (approved) membership of the request's school (or signup
-- school), with a clear self-match message. Align request_json + get chat +
-- select policy so soft members can see and complete a match.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Access helper: verified school membership OR signup_school_id (neighbourhood
-- soft path). Not granted to clients — internal / security definer only.
-- ---------------------------------------------------------------------------
create or replace function public.instant_pickup_has_school_access(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select
    p_school_id is not null
    and auth.uid() is not null
    and (
      public.is_approved_school_member(p_school_id)
      or exists (
        select 1
        from public.profiles as profile
        where profile.id = auth.uid()
          and profile.signup_school_id = p_school_id
          and not profile.admin_suspended
      )
    );
$fn$;

revoke all on function public.instant_pickup_has_school_access(uuid)
  from public, anon, authenticated;
-- RLS select policy calls this; authenticated must be able to execute it.
grant execute on function public.instant_pickup_has_school_access(uuid) to authenticated;

comment on function public.instant_pickup_has_school_access(uuid) is
  'Verified school/neighbourhood access for instant pickup (approved membership or signup school).';

-- Soft-joined parents need to see same-school open posts without a safety declaration.
drop policy if exists instant_pickup_requests_select on public.instant_pickup_requests;
create policy instant_pickup_requests_select on public.instant_pickup_requests
  for select to authenticated using (
    public.is_admin()
    or public.instant_pickup_has_school_access(school_id)
    or requester_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- Projection: same access gate so accept return path does not fail after match.
-- ---------------------------------------------------------------------------
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
  band text;
  band_label text;
  school_suburb text;
begin
  if auth.uid() is null
    or (
      not public.instant_pickup_has_school_access(p_request.school_id)
      and auth.uid() is distinct from p_request.requester_id
      and auth.uid() is distinct from p_request.matched_user_id
    ) then
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
  select school.suburb into school_suburb
  from public.schools as school
  where school.id = p_request.school_id;
  pickup_at := public.instant_pickup_pickup_at(p_request);
  band := coalesce(public.trust_band_for_user(p_request.requester_id), 'Restricted');
  band_label := public.parent_trust_band_label(band);
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
    'createdAt', p_request.created_at,
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), p_request.area_label),
    'requesterTrustBand', band,
    'requesterParentTrustBand', band_label
  );
end;
$fn$;

revoke all on function public.instant_pickup_request_json(public.instant_pickup_requests)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Accept: gate on the request's school, not the caller's oldest membership.
-- ---------------------------------------------------------------------------
drop function if exists public.accept_instant_pickup_request(uuid);

create function public.accept_instant_pickup_request(p_request_id uuid)
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
  pickup_at timestamptz;
  checkpoint timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  perform public.release_stale_instant_pickup_matches();

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;

  if request.id is null then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;

  -- Self-match first with a clear English message (before membership wording).
  if request.requester_id = auth.uid() then
    raise exception 'You cannot request a match on your own pickup post.'
      using errcode = '22023';
  end if;

  if not public.instant_pickup_has_school_access(request.school_id) then
    raise exception 'Join and verify your school profile before requesting a match.'
      using errcode = '42501';
  end if;

  if request.status is distinct from 'open' then
    raise exception 'instant pickup request is not open' using errcode = '22023';
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

comment on function public.accept_instant_pickup_request(uuid) is
  'PostgREST RPC args: { "p_request_id": "<uuid>" }. Verified school members can match another user''s OPEN post. Returns { request, chatRoom }.';

revoke all on function public.accept_instant_pickup_request(uuid)
  from public, anon, authenticated;
grant execute on function public.accept_instant_pickup_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Match chat: same soft-membership gate so accept → openChat works.
-- ---------------------------------------------------------------------------
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
    or not public.instant_pickup_has_school_access(request.school_id) then
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
