-- Marketplace favourites (관심/찜): same-school parents toggle interest on
-- item_listings. Counts + viewer state are exposed via listing JSON / RPCs.
-- No phones, payments, or child nicknames.
begin;
set local search_path = pg_catalog;

create table if not exists public.listing_favorites (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  listing_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (listing_id, school_id)
    references public.item_listings(id, school_id) on delete cascade,
  constraint listing_favorites_listing_user_key unique (listing_id, user_id)
);

comment on table public.listing_favorites is
  'Same-school marketplace favourites (관심). One row per parent per listing.';

create index if not exists listing_favorites_listing_idx
  on public.listing_favorites (listing_id, created_at desc);
create index if not exists listing_favorites_user_idx
  on public.listing_favorites (user_id, created_at desc);
create index if not exists listing_favorites_school_idx
  on public.listing_favorites (school_id, created_at desc);

alter table public.listing_favorites enable row level security;

drop policy if exists listing_favorites_select on public.listing_favorites;
create policy listing_favorites_select on public.listing_favorites
  for select to authenticated using (
    public.is_admin()
    or user_id = auth.uid()
    or public.is_member(school_id)
  );

drop policy if exists listing_favorites_insert on public.listing_favorites;
create policy listing_favorites_insert on public.listing_favorites
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_member(school_id)
    and exists (
      select 1
      from public.item_listings as listing
      where listing.id = listing_id
        and listing.school_id = listing_favorites.school_id
        and listing.status = 'active'
        and listing.author_id is distinct from auth.uid()
    )
  );

drop policy if exists listing_favorites_delete on public.listing_favorites;
create policy listing_favorites_delete on public.listing_favorites
  for delete to authenticated using (
    user_id = auth.uid()
    or public.is_admin()
  );

revoke all on table public.listing_favorites from public, anon, authenticated;
grant select, insert, delete on table public.listing_favorites to authenticated;

-- ---------------------------------------------------------------------------
-- Enrich listing JSON with favouriteCount + viewerHasFavorited
-- ---------------------------------------------------------------------------
create or replace function public.item_listing_json(p_listing public.item_listings)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  author_name text;
  school_name text;
  school_suburb text;
  school_sector text;
  band text;
  band_label text;
  ask_display text;
  favorite_count integer := 0;
  viewer_favorited boolean := false;
begin
  select profile.display_name into author_name
  from public.profiles as profile
  where profile.id = p_listing.author_id;
  select school.display_name, school.suburb, school.school_sector
    into school_name, school_suburb, school_sector
  from public.schools as school
  where school.id = p_listing.school_id;
  band := coalesce(public.trust_band_for_user(p_listing.author_id), 'Restricted');
  band_label := public.parent_trust_band_label(band);
  if p_listing.ask_aud_cents is not null then
    if p_listing.ask_aud_cents % 100 = 0 then
      ask_display := '$' || (p_listing.ask_aud_cents / 100)::text || ' AUD';
    else
      ask_display := '$' || trim(to_char(p_listing.ask_aud_cents / 100.0, 'FM9999990.00')) || ' AUD';
    end if;
  end if;

  select pg_catalog.count(*)::integer into favorite_count
  from public.listing_favorites as favorite
  where favorite.listing_id = p_listing.id;

  if auth.uid() is not null then
    select exists (
      select 1
      from public.listing_favorites as favorite
      where favorite.listing_id = p_listing.id
        and favorite.user_id = auth.uid()
    ) into viewer_favorited;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', p_listing.id,
    'school_id', p_listing.school_id,
    'author_id', p_listing.author_id,
    'author_display_name', coalesce(author_name, 'Parent'),
    'listing_kind', p_listing.listing_kind,
    'title', p_listing.title,
    'description', p_listing.description,
    'category', p_listing.category,
    'display_offer_label', p_listing.display_offer_label,
    'status', p_listing.status,
    'created_at', p_listing.created_at,
    'schoolDisplayName', coalesce(school_name, 'Your school'),
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), 'Local suburb'),
    'schoolSector', coalesce(school_sector, 'primary'),
    'authorTrustBand', band,
    'authorParentTrustBand', band_label,
    'askAudCents', p_listing.ask_aud_cents,
    'askAudDisplay', ask_display,
    'listingImages', coalesce(p_listing.listing_images, '[]'::jsonb),
    'itemCondition', p_listing.item_condition,
    'sizeAgeLabel', p_listing.size_age_label,
    'householdEnv', to_jsonb(coalesce(p_listing.household_env, '{}'::text[])),
    'favoriteCount', favorite_count,
    'viewerHasFavorited', viewer_favorited
  );
end;
$fn$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Toggle favourite RPC
-- ---------------------------------------------------------------------------
create or replace function public.toggle_listing_favorite(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  favorited boolean := false;
  favorite_count integer := 0;
begin
  membership := public.listing_caller_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.author_id = auth.uid() then
    raise exception 'authors cannot favourite their own listing' using errcode = '22023';
  end if;

  delete from public.listing_favorites as favorite
  where favorite.listing_id = listing.id
    and favorite.user_id = auth.uid();

  if not found then
    insert into public.listing_favorites (school_id, listing_id, user_id)
    values (listing.school_id, listing.id, auth.uid());
    favorited := true;
  else
    favorited := false;
  end if;

  select pg_catalog.count(*)::integer into favorite_count
  from public.listing_favorites as favorite
  where favorite.listing_id = listing.id;

  return pg_catalog.jsonb_build_object(
    'listingId', listing.id,
    'favorited', favorited,
    'favoriteCount', favorite_count
  );
end;
$fn$;
revoke all on function public.toggle_listing_favorite(uuid)
  from public, anon, authenticated;
grant execute on function public.toggle_listing_favorite(uuid) to authenticated;

commit;
