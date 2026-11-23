-- Fix upsert_push_subscription 42P01:
--   invalid reference to FROM-clause entry for table "push_subscriptions"
--
-- Root cause (0078):
--   INSERT ... AS sub ... ON CONFLICT DO UPDATE used the bare table name in the
--   SET expression instead of the insert alias `sub` (Postgres 42P01).
--
-- Also re-asserts table + grants and reloads PostgREST (client 404 on RPC when
-- schema cache is stale / function missing).
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

alter table public.push_subscriptions enable row level security;

revoke all on table public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

drop policy if exists push_subscriptions_owner_all on public.push_subscriptions;
create policy push_subscriptions_owner_all on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop function if exists public.upsert_push_subscription(text, text, text, text);

create function public.upsert_push_subscription(
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
  caller uuid := (select auth.uid());
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

  -- Alias the target as `sub` and reference sub.* in DO UPDATE (bare table
  -- qualification here raises 42P01 when the INSERT is aliased).
  insert into public.push_subscriptions as sub (
    user_id, endpoint, p256dh, auth, user_agent
  ) values (
    caller, clean_endpoint, clean_p256dh, clean_auth, clean_ua
  )
  on conflict (user_id, endpoint) do update
    set
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = coalesce(excluded.user_agent, sub.user_agent),
      updated_at = pg_catalog.now()
  returning sub.id into row_id;

  return pg_catalog.jsonb_build_object('id', row_id, 'ok', true);
end;
$fn$;

comment on function public.upsert_push_subscription(text, text, text, text) is
  'PostgREST: { p_endpoint, p_p256dh, p_auth, p_user_agent }. Upsert caller Web Push subscription.';

revoke all on function public.upsert_push_subscription(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_push_subscription(text, text, text, text)
  to authenticated;

-- Keep delete + list helpers executable (re-grant if 0078 partially applied).
do $$
begin
  if to_regprocedure('public.delete_push_subscription(text)') is not null then
    execute 'revoke all on function public.delete_push_subscription(text) from public, anon, authenticated';
    execute 'grant execute on function public.delete_push_subscription(text) to authenticated';
  end if;
  if to_regprocedure('public.list_push_targets_for_chat_peer(uuid)') is not null then
    execute 'revoke all on function public.list_push_targets_for_chat_peer(uuid) from public, anon, authenticated';
    execute 'grant execute on function public.list_push_targets_for_chat_peer(uuid) to authenticated';
  end if;
  if to_regprocedure('public.list_push_targets_for_pickup_peer(uuid)') is not null then
    execute 'revoke all on function public.list_push_targets_for_pickup_peer(uuid) from public, anon, authenticated';
    execute 'grant execute on function public.list_push_targets_for_pickup_peer(uuid) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
