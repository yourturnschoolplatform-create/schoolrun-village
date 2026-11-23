-- Web Push subscriptions for Karrot-style chat / match alerts (VAPID).
-- Phone-free payloads only. Owner manages own rows; peer notify RPCs return
-- target endpoints only when the caller is the other chat/match participant.
begin;
set local search_path = pg_catalog;

create table if not exists public.push_subscriptions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  endpoint text not null
    check (char_length(trim(endpoint)) between 8 and 2048),
  p256dh text not null
    check (char_length(trim(p256dh)) between 8 and 512),
  auth text not null
    check (char_length(trim(auth)) between 8 and 512),
  user_agent text
    check (user_agent is null or char_length(user_agent) <= 512),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (user_id, endpoint)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id, updated_at desc);

comment on table public.push_subscriptions is
  'Web Push endpoints per parent. No phone/GPS/money fields; used for chat and match alerts.';

alter table public.push_subscriptions enable row level security;

revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

drop policy if exists push_subscriptions_owner_all on public.push_subscriptions;
create policy push_subscriptions_owner_all on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Upsert / delete own subscription
-- ---------------------------------------------------------------------------
create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  row_id uuid;
  clean_endpoint text := nullif(trim(coalesce(p_endpoint, '')), '');
  clean_p256dh text := nullif(trim(coalesce(p_p256dh, '')), '');
  clean_auth text := nullif(trim(coalesce(p_auth, '')), '');
  clean_ua text := nullif(left(trim(coalesce(p_user_agent, '')), 512), '');
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_endpoint is null or clean_p256dh is null or clean_auth is null then
    raise exception 'push subscription fields required' using errcode = '22023';
  end if;

  insert into public.push_subscriptions as sub (
    user_id, endpoint, p256dh, auth, user_agent
  ) values (
    caller, clean_endpoint, clean_p256dh, clean_auth, clean_ua
  )
  on conflict (user_id, endpoint) do update
    set
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = coalesce(excluded.user_agent, public.push_subscriptions.user_agent),
      updated_at = pg_catalog.now()
  returning sub.id into row_id;

  return pg_catalog.jsonb_build_object('id', row_id, 'ok', true);
end;
$fn$;

comment on function public.upsert_push_subscription(text, text, text, text) is
  'PostgREST: { p_endpoint, p_p256dh, p_auth, p_user_agent }. Upsert caller Web Push subscription.';

revoke all on function public.upsert_push_subscription(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_push_subscription(text, text, text, text) to authenticated;

create or replace function public.delete_push_subscription(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  clean_endpoint text := nullif(trim(coalesce(p_endpoint, '')), '');
  removed integer := 0;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_endpoint is null then
    raise exception 'p_endpoint is required' using errcode = '22023';
  end if;

  delete from public.push_subscriptions as sub
  where sub.user_id = caller
    and sub.endpoint = clean_endpoint;
  get diagnostics removed = row_count;

  return pg_catalog.jsonb_build_object('ok', true, 'removed', removed);
end;
$fn$;

comment on function public.delete_push_subscription(text) is
  'PostgREST: { p_endpoint }. Remove caller Web Push subscription.';

revoke all on function public.delete_push_subscription(text)
  from public, anon, authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Peer targets for authenticated notify (caller must be the other party)
-- ---------------------------------------------------------------------------
create or replace function public.list_push_targets_for_chat_peer(p_room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  room public.chat_rooms%rowtype;
  peer_id uuid;
  payload jsonb;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_room_id is null then
    raise exception 'p_room_id is required' using errcode = '22023';
  end if;

  select * into room from public.chat_rooms where id = p_room_id;
  if room.id is null or caller not in (room.user_low, room.user_high) then
    raise exception 'chat room unavailable' using errcode = '42501';
  end if;

  peer_id := case when caller = room.user_low then room.user_high else room.user_low end;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'endpoint', sub.endpoint,
    'p256dh', sub.p256dh,
    'auth', sub.auth
  ) order by sub.updated_at desc), '[]'::jsonb)
  into payload
  from public.push_subscriptions as sub
  where sub.user_id = peer_id;

  return pg_catalog.jsonb_build_object(
    'peerUserId', peer_id,
    'roomId', room.id,
    'subscriptions', payload
  );
end;
$fn$;

revoke all on function public.list_push_targets_for_chat_peer(uuid)
  from public, anon, authenticated;
grant execute on function public.list_push_targets_for_chat_peer(uuid) to authenticated;

create or replace function public.list_push_targets_for_pickup_peer(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  request public.instant_pickup_requests%rowtype;
  peer_id uuid;
  payload jsonb;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'p_request_id is required' using errcode = '22023';
  end if;

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id;

  if request.id is null
    or request.matched_user_id is null
    or caller not in (request.requester_id, request.matched_user_id) then
    raise exception 'instant pickup match unavailable' using errcode = '42501';
  end if;

  peer_id := case
    when caller = request.requester_id then request.matched_user_id
    else request.requester_id
  end;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'endpoint', sub.endpoint,
    'p256dh', sub.p256dh,
    'auth', sub.auth
  ) order by sub.updated_at desc), '[]'::jsonb)
  into payload
  from public.push_subscriptions as sub
  where sub.user_id = peer_id;

  return pg_catalog.jsonb_build_object(
    'peerUserId', peer_id,
    'requestId', request.id,
    'chatRoomId', request.chat_room_id,
    'subscriptions', payload
  );
end;
$fn$;

revoke all on function public.list_push_targets_for_pickup_peer(uuid)
  from public, anon, authenticated;
grant execute on function public.list_push_targets_for_pickup_peer(uuid) to authenticated;

-- Ensure chat + match board changes are realtime-visible for badge / toast / title.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'chat_messages'
    ) then
      execute 'alter publication supabase_realtime add table public.chat_messages';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'instant_pickup_requests'
    ) then
      execute 'alter publication supabase_realtime add table public.instant_pickup_requests';
    end if;
  end if;
exception
  when others then
    null;
end $$;

notify pgrst, 'reload schema';

commit;
