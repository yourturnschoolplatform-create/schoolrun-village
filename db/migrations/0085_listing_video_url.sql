-- Listing media: optional 1 video URL alongside up to 6 photo data URLs.
-- Videos are stored in the public `listing-media` Storage bucket; photos remain
-- compressed JPEG data URLs in listing_images (unchanged).
begin;
set local search_path = pg_catalog;

alter table public.item_listings
  add column if not exists video_url text;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as nsp on nsp.oid = relation.relnamespace
    where nsp.nspname = 'public'
      and relation.relname = 'item_listings'
      and constraint_row.conname = 'item_listings_video_url_check'
  ) then
    alter table public.item_listings drop constraint item_listings_video_url_check;
  end if;

  alter table public.item_listings
    add constraint item_listings_video_url_check
    check (
      video_url is null
      or (
        pg_catalog.char_length(trim(video_url)) between 12 and 2048
        and trim(video_url) ~* '^https://'
      )
    );
end $$;

comment on column public.item_listings.video_url is
  'Optional public HTTPS URL for one listing video (Supabase Storage listing-media). Max one video per listing.';

-- ---------------------------------------------------------------------------
-- Storage bucket (best-effort when storage schema exists)
-- ---------------------------------------------------------------------------
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'listing-media',
    'listing-media',
    true,
    52428800,
    array['video/mp4', 'video/quicktime', 'video/webm']::text[]
  )
  on conflict (id) do update
    set
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
exception
  when undefined_table then null;
  when undefined_object then null;
  when others then null;
end $$;

do $$
begin
  execute 'drop policy if exists listing_media_select_public on storage.objects';
  execute $policy$
    create policy listing_media_select_public on storage.objects
      for select to public
      using (bucket_id = 'listing-media')
  $policy$;

  execute 'drop policy if exists listing_media_insert_own on storage.objects';
  execute $policy$
    create policy listing_media_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'listing-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
  $policy$;

  execute 'drop policy if exists listing_media_update_own on storage.objects';
  execute $policy$
    create policy listing_media_update_own on storage.objects
      for update to authenticated
      using (
        bucket_id = 'listing-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'listing-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
  $policy$;

  execute 'drop policy if exists listing_media_delete_own on storage.objects';
  execute $policy$
    create policy listing_media_delete_own on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'listing-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
  $policy$;
exception
  when undefined_table then null;
  when undefined_object then null;
  when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- Validate optional video URL (HTTPS only)
-- ---------------------------------------------------------------------------
create or replace function public.listing_video_url_is_valid(p_video_url text)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog
as $fn$
  select
    p_video_url is null
    or nullif(trim(p_video_url), '') is null
    or (
      pg_catalog.char_length(trim(p_video_url)) between 12 and 2048
      and trim(p_video_url) ~* '^https://'
    );
$fn$;

revoke all on function public.listing_video_url_is_valid(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- item_listing_json includes videoUrl
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
  viewer_school uuid;
  area_value text;
  video_value text := nullif(trim(coalesce(p_listing.video_url, '')), '');
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

    select membership.school_id into viewer_school
    from public.school_memberships as membership
    where membership.user_id = auth.uid()
      and membership.status = 'verified'
    order by membership.created_at, membership.id
    limit 1;
  end if;

  area_value := coalesce(
    nullif(trim(coalesce(p_listing.area_label, '')), ''),
    nullif(trim(coalesce(school_suburb, '')), ''),
    'Local suburb'
  );

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
    'schoolSuburb', coalesce(nullif(trim(coalesce(school_suburb, '')), ''), area_value),
    'schoolSector', coalesce(school_sector, 'primary'),
    'areaLabel', area_value,
    'sameSchool', (viewer_school is not null and viewer_school = p_listing.school_id),
    'authorTrustBand', band,
    'authorParentTrustBand', band_label,
    'askAudCents', p_listing.ask_aud_cents,
    'askAudDisplay', ask_display,
    'listingImages', coalesce(p_listing.listing_images, '[]'::jsonb),
    'videoUrl', video_value,
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
-- create_item_listing accepts optional p_video_url
-- ---------------------------------------------------------------------------
drop function if exists public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text
);
drop function if exists public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text, text
);

create function public.create_item_listing(
  p_listing_kind text,
  p_title text,
  p_description text,
  p_category text,
  p_display_offer_label text,
  p_ask_aud_cents numeric default null,
  p_listing_images jsonb default '[]'::jsonb,
  p_item_condition text default null,
  p_size_age_label text default null,
  p_household_env jsonb default '[]'::jsonb,
  p_area_label text default null,
  p_video_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  created public.item_listings%rowtype;
  kind text := trim(coalesce(p_listing_kind, ''));
  offer text := trim(coalesce(p_display_offer_label, ''));
  category_value text := trim(coalesce(p_category, ''));
  ask_cents integer;
  images jsonb := public.normalize_listing_images(coalesce(p_listing_images, '[]'::jsonb));
  condition_value text := nullif(trim(coalesce(p_item_condition, '')), '');
  size_value text := nullif(trim(coalesce(p_size_age_label, '')), '');
  env_values text[] := '{}'::text[];
  env_item text;
  area_value text := nullif(trim(coalesce(p_area_label, '')), '');
  school_suburb text;
  video_value text := nullif(trim(coalesce(p_video_url, '')), '');
begin
  membership := public.listing_caller_membership();

  if p_ask_aud_cents is null then
    ask_cents := null;
  else
    ask_cents := pg_catalog.round(p_ask_aud_cents)::integer;
  end if;

  if p_household_env is not null and pg_catalog.jsonb_typeof(p_household_env) = 'array' then
    for env_item in
      select pg_catalog.btrim(elem)
      from pg_catalog.jsonb_array_elements_text(p_household_env) as elem
    loop
      if env_item in ('Smoke-free', 'Pet-free')
        and not (env_item = any (env_values)) then
        env_values := env_values || env_item;
      end if;
    end loop;
  end if;

  if kind not in ('giveaway', 'lending', 'sale', 'swap') then
    raise exception 'listing kind must be giveaway, lending, sale or swap' using errcode = '22023';
  end if;
  if category_value not in (
    'Baby & Toddler Gear',
    'Toys & Outdoor',
    'Kids Fashion & Shoes',
    'Books & Learning',
    'School & Nursery',
    'School Uniforms',
    'Books & Toys',
    'Baby & Kids Gear',
    'Kids Clothing'
  ) and pg_catalog.char_length(category_value) not between 2 and 40 then
    raise exception 'choose a parent marketplace category' using errcode = '22023';
  end if;

  if kind = 'sale' then
    offer := 'SALE';
    if ask_cents is null or ask_cents < 100 or ask_cents > 99999900 then
      raise exception 'sale listings need an AUD ask between $1 and $999999 (send cents, e.g. 5000 for $50)'
        using errcode = '22023';
    end if;
  else
    ask_cents := null;
    if kind = 'swap' then
      offer := 'SWAP';
    elsif kind in ('giveaway', 'lending') and offer not in (
      'Free', 'Free to collect', 'Free giveaway', 'Lending only', 'Borrow free', 'FREE'
    ) then
      offer := 'FREE';
    end if;
  end if;

  if (kind = 'giveaway' and offer not in ('Free', 'Free to collect', 'Free giveaway', 'FREE'))
    or (kind = 'lending' and offer not in ('Lending only', 'Borrow free', 'FREE'))
    or (kind = 'sale' and offer is distinct from 'SALE')
    or (kind = 'swap' and offer is distinct from 'SWAP') then
    raise exception 'display offer label must match listing kind' using errcode = '22023';
  end if;
  if not public.listing_images_are_valid(images) then
    raise exception 'listing images must be up to six compressed image data URLs with one cover'
      using errcode = '22023';
  end if;
  if not public.listing_video_url_is_valid(video_value) then
    raise exception 'listing video must be one HTTPS URL (mp4, mov or webm)'
      using errcode = '22023';
  end if;
  if condition_value is not null and condition_value not in ('New', 'Like New', 'Good') then
    raise exception 'item condition must be New, Like New or Good' using errcode = '22023';
  end if;
  if size_value is not null and pg_catalog.char_length(size_value) > 40 then
    raise exception 'size or age label is too long' using errcode = '22023';
  end if;
  if not public.listing_text_is_allowed(p_title)
    or not public.listing_text_is_allowed(p_description)
    or not public.listing_text_is_allowed(category_value) then
    raise exception 'listing text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if size_value is not null and not public.listing_text_is_allowed(size_value) then
    raise exception 'listing text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if public.listing_contains_restricted_item(p_title)
    or public.listing_contains_restricted_item(p_description)
    or public.listing_contains_restricted_item(category_value) then
    raise exception 'listing matches a restricted item and cannot be published'
      using errcode = '22023';
  end if;

  select school.suburb into school_suburb
  from public.schools as school
  where school.id = membership.school_id;

  if area_value is null then
    area_value := nullif(trim(coalesce(school_suburb, '')), '');
  end if;
  if area_value is not null then
    if not public.is_suburb_area_label(area_value)
      or pg_catalog.char_length(area_value) not between 2 and 64 then
      raise exception 'meetup suburb must be a suburb-only label' using errcode = '22023';
    end if;
  end if;

  insert into public.item_listings (
    school_id, author_id, author_membership, listing_kind,
    title, description, category, display_offer_label, ask_aud_cents,
    listing_images, video_url, item_condition, size_age_label, household_env, area_label
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer, ask_cents,
    images, video_value, condition_value, size_value, coalesce(env_values, '{}'::text[]), area_value
  ) returning * into created;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.created', 'item_listing',
    created.id,
    pg_catalog.jsonb_build_object(
      'outcome', 'created',
      'reason_code', 'item_listing'
    )
  );

  return public.item_listing_json(created);
end;
$fn$;

comment on function public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text, text
) is
  'PostgREST create listing with optional p_video_url (HTTPS Storage URL) plus up to six photo data URLs.';

revoke all on function public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
