-- Hot Deals: photos, video, detailed description, admin upsert, viewer saves.
-- Idempotent. Run in Supabase SQL Editor, then confirm PostgREST reload.

begin;
set local search_path = pg_catalog;

create table if not exists public.hot_deals (
  id text primary key,
  brand_name text not null,
  brand_mark text not null,
  title text not null,
  summary text not null,
  description text not null default '',
  category text not null,
  original_ask_aud_cents integer not null check (original_ask_aud_cents >= 0),
  group_ask_aud_cents integer not null check (group_ask_aud_cents >= 0),
  joined_count integer not null default 0 check (joined_count >= 0),
  target_count integer not null check (target_count > 0),
  bonus_discount_aud_cents integer not null default 0 check (bonus_discount_aud_cents >= 0),
  cta_label text not null default 'Join Group Buy'
    check (cta_label in ('Join Group Buy', 'Buy Deal')),
  deal_images jsonb not null default '[]'::jsonb,
  video_url text,
  status text not null default 'active'
    check (status in ('active', 'hidden', 'archived')),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint hot_deals_title_len check (pg_catalog.char_length(trim(title)) between 3 and 160),
  constraint hot_deals_summary_len check (pg_catalog.char_length(trim(summary)) between 3 and 500),
  constraint hot_deals_description_len check (pg_catalog.char_length(description) <= 8000),
  constraint hot_deals_video_url_check check (
    video_url is null
    or (
      pg_catalog.char_length(trim(video_url)) between 12 and 2048
      and trim(video_url) ~* '^https://'
    )
  ),
  constraint hot_deals_images_is_array check (pg_catalog.jsonb_typeof(deal_images) = 'array')
);

alter table public.hot_deals
  add column if not exists description text not null default '';
alter table public.hot_deals
  add column if not exists deal_images jsonb not null default '[]'::jsonb;
alter table public.hot_deals
  add column if not exists video_url text;
alter table public.hot_deals
  add column if not exists status text not null default 'active';
alter table public.hot_deals
  add column if not exists updated_at timestamptz not null default pg_catalog.now();

create index if not exists hot_deals_status_updated_idx
  on public.hot_deals (status, updated_at desc);

create table if not exists public.hot_deal_saves (
  deal_id text not null references public.hot_deals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (deal_id, user_id)
);

create index if not exists hot_deal_saves_user_idx
  on public.hot_deal_saves (user_id, created_at desc);

alter table public.hot_deals enable row level security;
alter table public.hot_deal_saves enable row level security;

drop policy if exists hot_deals_select_active on public.hot_deals;
create policy hot_deals_select_active on public.hot_deals
  for select to authenticated
  using (status = 'active' or public.is_admin());

drop policy if exists hot_deals_admin_write on public.hot_deals;
create policy hot_deals_admin_write on public.hot_deals
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists hot_deal_saves_select_own on public.hot_deal_saves;
create policy hot_deal_saves_select_own on public.hot_deal_saves
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists hot_deal_saves_insert_own on public.hot_deal_saves;
create policy hot_deal_saves_insert_own on public.hot_deal_saves
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists hot_deal_saves_delete_own on public.hot_deal_saves;
create policy hot_deal_saves_delete_own on public.hot_deal_saves
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on table public.hot_deals from public, anon, authenticated;
revoke all on table public.hot_deal_saves from public, anon, authenticated;
grant select on table public.hot_deals to authenticated;
grant select, insert, delete on table public.hot_deal_saves to authenticated;
grant select, insert, update, delete on table public.hot_deals to authenticated;

create or replace function public.hot_deal_json(p_deal public.hot_deals)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_deal.id,
    'brandName', p_deal.brand_name,
    'brandMark', p_deal.brand_mark,
    'title', p_deal.title,
    'summary', p_deal.summary,
    'description', p_deal.description,
    'category', p_deal.category,
    'originalAskAudCents', p_deal.original_ask_aud_cents,
    'groupAskAudCents', p_deal.group_ask_aud_cents,
    'joinedCount', p_deal.joined_count,
    'targetCount', p_deal.target_count,
    'bonusDiscountAudCents', p_deal.bonus_discount_aud_cents,
    'ctaLabel', p_deal.cta_label,
    'dealImages', coalesce(p_deal.deal_images, '[]'::jsonb),
    'videoUrl', p_deal.video_url,
    'status', p_deal.status,
    'viewerHasSaved', exists (
      select 1
      from public.hot_deal_saves save_row
      where save_row.deal_id = p_deal.id
        and save_row.user_id = auth.uid()
    ),
    'created_at', p_deal.created_at,
    'updated_at', p_deal.updated_at
  );
$$;

revoke all on function public.hot_deal_json(public.hot_deals) from public, anon, authenticated;

create or replace function public.list_hot_deals()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select coalesce(
    pg_catalog.jsonb_agg(public.hot_deal_json(deal_row) order by deal_row.updated_at desc, deal_row.created_at desc),
    '[]'::jsonb
  )
    into result
  from public.hot_deals deal_row
  where deal_row.status = 'active';
  return result;
end;
$$;

revoke all on function public.list_hot_deals() from public, anon, authenticated;
grant execute on function public.list_hot_deals() to authenticated;

create or replace function public.admin_list_hot_deals()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  select coalesce(
    pg_catalog.jsonb_agg(public.hot_deal_json(deal_row) order by deal_row.updated_at desc),
    '[]'::jsonb
  )
    into result
  from public.hot_deals deal_row;
  return result;
end;
$$;

revoke all on function public.admin_list_hot_deals() from public, anon, authenticated;
grant execute on function public.admin_list_hot_deals() to authenticated;

create or replace function public.admin_upsert_hot_deal(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  deal_id text;
  saved public.hot_deals%rowtype;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = '42501';
  end if;

  deal_id := nullif(trim(coalesce(p_payload->>'id', '')), '');
  if deal_id is null then
    deal_id := 'deal-' || replace(gen_random_uuid()::text, '-', '');
  end if;

  insert into public.hot_deals as deals (
    id, brand_name, brand_mark, title, summary, description, category,
    original_ask_aud_cents, group_ask_aud_cents, joined_count, target_count,
    bonus_discount_aud_cents, cta_label, deal_images, video_url, status, updated_at
  ) values (
    deal_id,
    left(trim(coalesce(p_payload->>'brandName', '')), 80),
    left(trim(coalesce(p_payload->>'brandMark', 'SR')), 4),
    left(trim(coalesce(p_payload->>'title', '')), 160),
    left(trim(coalesce(p_payload->>'summary', '')), 500),
    left(coalesce(p_payload->>'description', ''), 8000),
    left(trim(coalesce(p_payload->>'category', 'School & Nursery')), 80),
    greatest(0, coalesce((p_payload->>'originalAskAudCents')::integer, 0)),
    greatest(0, coalesce((p_payload->>'groupAskAudCents')::integer, 0)),
    greatest(0, coalesce((p_payload->>'joinedCount')::integer, 0)),
    greatest(1, coalesce((p_payload->>'targetCount')::integer, 1)),
    greatest(0, coalesce((p_payload->>'bonusDiscountAudCents')::integer, 0)),
    case
      when coalesce(p_payload->>'ctaLabel', '') = 'Buy Deal' then 'Buy Deal'
      else 'Join Group Buy'
    end,
    coalesce(p_payload->'dealImages', '[]'::jsonb),
    nullif(trim(coalesce(p_payload->>'videoUrl', '')), ''),
    case
      when coalesce(p_payload->>'status', 'active') in ('active', 'hidden', 'archived')
        then coalesce(p_payload->>'status', 'active')
      else 'active'
    end,
    pg_catalog.now()
  )
  on conflict (id) do update set
    brand_name = excluded.brand_name,
    brand_mark = excluded.brand_mark,
    title = excluded.title,
    summary = excluded.summary,
    description = excluded.description,
    category = excluded.category,
    original_ask_aud_cents = excluded.original_ask_aud_cents,
    group_ask_aud_cents = excluded.group_ask_aud_cents,
    joined_count = excluded.joined_count,
    target_count = excluded.target_count,
    bonus_discount_aud_cents = excluded.bonus_discount_aud_cents,
    cta_label = excluded.cta_label,
    deal_images = excluded.deal_images,
    video_url = excluded.video_url,
    status = excluded.status,
    updated_at = pg_catalog.now()
  returning * into saved;

  return public.hot_deal_json(saved);
end;
$$;

revoke all on function public.admin_upsert_hot_deal(jsonb) from public, anon, authenticated;
grant execute on function public.admin_upsert_hot_deal(jsonb) to authenticated;

create or replace function public.toggle_hot_deal_save(p_deal_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  saved boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.hot_deals deal_row
    where deal_row.id = p_deal_id and deal_row.status = 'active'
  ) then
    raise exception 'hot deal not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.hot_deal_saves save_row
    where save_row.deal_id = p_deal_id and save_row.user_id = auth.uid()
  ) then
    delete from public.hot_deal_saves
    where deal_id = p_deal_id and user_id = auth.uid();
    saved := false;
  else
    insert into public.hot_deal_saves (deal_id, user_id) values (p_deal_id, auth.uid());
    saved := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'dealId', p_deal_id,
    'saved', saved
  );
end;
$$;

revoke all on function public.toggle_hot_deal_save(text) from public, anon, authenticated;
grant execute on function public.toggle_hot_deal_save(text) to authenticated;

-- Seed catalogue rows when missing (media empty; admins can enrich).
insert into public.hot_deals (
  id, brand_name, brand_mark, title, summary, description, category,
  original_ask_aud_cents, group_ask_aud_cents, joined_count, target_count,
  bonus_discount_aud_cents, cta_label
) values
  (
    'deal-lunchbox-pack', 'Harbour Kids Co.', 'HK', 'Insulated lunchbox 3-pack',
    'Leak-proof school lunchboxes with name-label window. School-gate pickup week.',
    'Three insulated lunchboxes with leak-proof seals and a clear name-label window. Ideal for primary lunch routines. School-gate pickup window confirmed after the group unlocks.',
    'School & Nursery', 8900, 5900, 42, 50, 1500, 'Join Group Buy'
  ),
  (
    'deal-swim-rashie', 'Coastal Swim AU', 'CS', 'UPF50+ rashie bundle',
    'Sizes 4–12. Exclusive parent group rate for verified school households.',
    'UPF50+ rashie bundle covering sizes 4–12. Soft stretch fabric for active kids, with an exclusive verified-parent group rate for this school term.',
    'Kids Fashion & Shoes', 5400, 3600, 28, 40, 1000, 'Join Group Buy'
  ),
  (
    'deal-tutoring-trial', 'BrightPath Tutoring', 'BP', 'After-school literacy trial (4 sessions)',
    'Local tutors for primary readers. Group booking unlocks the exclusive rate.',
    'Four after-school literacy sessions with local tutors focused on primary readers. Group booking unlocks the exclusive SchoolRun Village rate for verified households.',
    'Local Class / Tutoring', 22000, 16000, 11, 20, 2500, 'Buy Deal'
  ),
  (
    'deal-sports-socks', 'Pitch & Play', 'PP', 'School sports sock 5-pack',
    'Durable white sports socks. Extra discount when the school cohort fills.',
    'A durable white school sports sock 5-pack for weekly PE and sports days. Extra discount unlocks when the school cohort fills.',
    'Kids Fashion & Shoes', 3200, 1900, 47, 60, 800, 'Join Group Buy'
  )
on conflict (id) do nothing;

notify pgrst, 'reload schema';
commit;
