-- Marketplace neighbourhood scope (Karrot-style): suburb + 5 km discovery.
-- Listings keep school_id metadata for "My School" / Same school badge.
-- area_label is suburb-only (never street address or live GPS storage).
begin;
set local search_path = pg_catalog;

alter table public.item_listings
  add column if not exists area_label text;

do $do$
begin
  if exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'item_listings_area_label_check'
  ) then
    alter table public.item_listings drop constraint item_listings_area_label_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_area_label_check
    check (
      area_label is null
      or (
        char_length(trim(area_label)) between 2 and 64
        and public.is_suburb_area_label(area_label)
      )
    );
end;
$do$;

comment on column public.item_listings.area_label is
  'Suburb-only meetup label for neighbourhood marketplace discovery. Never street, unit or GPS.';

-- Do not UPDATE existing item_listings rows here: guard_item_listings() blocks
-- all updates unless yourturn.listing_status / listing_moderation gates are set,
-- and those gates only allow status transitions. Existing rows resolve suburb via
-- COALESCE(area_label, schools.suburb) in item_listing_json + search_item_listings.

create index if not exists item_listings_area_label_idx
  on public.item_listings (lower(area_label), status, created_at desc);

-- ---------------------------------------------------------------------------
-- Listing JSON: areaLabel + sameSchool for feed cards
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
-- Create listing with optional suburb meetup label
-- ---------------------------------------------------------------------------
drop function if exists public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb);
drop function if exists public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb, text);

create function public.create_item_listing(
  p_listing_kind text,
  p_title text,
  p_description text,
  p_category text,
  p_display_offer_label text,
  p_ask_aud_cents integer default null,
  p_listing_images jsonb default '[]'::jsonb,
  p_item_condition text default null,
  p_size_age_label text default null,
  p_household_env jsonb default '[]'::jsonb,
  p_area_label text default null
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
  ask_cents integer := p_ask_aud_cents;
  images jsonb := public.normalize_listing_images(coalesce(p_listing_images, '[]'::jsonb));
  condition_value text := nullif(trim(coalesce(p_item_condition, '')), '');
  size_value text := nullif(trim(coalesce(p_size_age_label, '')), '');
  env_values text[] := '{}'::text[];
  env_item text;
  area_value text := nullif(trim(coalesce(p_area_label, '')), '');
  school_suburb text;
begin
  membership := public.listing_caller_membership();

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
      raise exception 'sale listings need an AUD ask between $1 and $999999'
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
    listing_images, item_condition, size_age_label, household_env, area_label
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer, ask_cents,
    images, condition_value, size_value, coalesce(env_values, '{}'::text[]), area_value
  ) returning * into created;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.created', 'item_listing',
    created.id,
    pg_catalog.jsonb_build_object(
      'outcome', 'created',
      'reason_code', 'item_listing',
      'area_label', created.area_label
    )
  );

  return public.item_listing_json(created);
end;
$fn$;
revoke all on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Neighbourhood search: nearby suburbs (default) / my suburb / my school
-- ---------------------------------------------------------------------------
drop function if exists public.search_item_listings(text, text, text);
drop function if exists public.search_item_listings(text, text, text, text, text[]);

create function public.search_item_listings(
  p_query text default null,
  p_listing_kind text default null,
  p_category text default null,
  p_scope text default 'nearby',
  p_area_labels text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  needle text;
  kind_filter text;
  category_filter text;
  scope_value text := lower(trim(coalesce(p_scope, 'nearby')));
  labels text[] := '{}'::text[];
  label_item text;
  result jsonb;
begin
  membership := public.listing_caller_membership();
  if p_listing_kind is not null
    and p_listing_kind not in ('giveaway', 'lending', 'sale', 'swap', 'free_share') then
    raise exception 'listing kind filter is invalid' using errcode = '22023';
  end if;
  if scope_value not in ('nearby', 'suburb', 'school') then
    scope_value := 'nearby';
  end if;
  needle := nullif(trim(coalesce(p_query, '')), '');
  if needle is not null and not public.listing_text_is_allowed(needle) then
    raise exception 'search text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  kind_filter := p_listing_kind;
  category_filter := nullif(trim(coalesce(p_category, '')), '');

  if p_area_labels is not null then
    foreach label_item in array p_area_labels loop
      label_item := trim(coalesce(label_item, ''));
      if label_item <> ''
        and public.is_suburb_area_label(label_item)
        and not (lower(label_item) = any (select lower(unnest(labels)))) then
        labels := labels || label_item;
      end if;
    end loop;
  end if;

  select coalesce(pg_catalog.jsonb_agg(public.item_listing_json(listing) order by listing.created_at desc), '[]'::jsonb)
  into result
  from public.item_listings listing
  left join public.schools school on school.id = listing.school_id
  where listing.status = 'active'
    and (
      -- My School: exact school membership
      (scope_value = 'school' and listing.school_id = membership.school_id)
      -- My Suburb: exact suburb label match (listing area_label, else school.suburb)
      or (
        scope_value = 'suburb'
        and (
          (
            pg_catalog.cardinality(labels) > 0
            and lower(coalesce(
              nullif(trim(coalesce(listing.area_label, '')), ''),
              nullif(trim(coalesce(school.suburb, '')), ''),
              ''
            )) = lower(labels[1])
          )
          or (
            pg_catalog.cardinality(labels) = 0
            and listing.school_id = membership.school_id
          )
        )
      )
      -- Nearby (default): suburb label in 5 km set OR own school (never empty feed)
      or (
        scope_value = 'nearby'
        and (
          listing.school_id = membership.school_id
          or (
            pg_catalog.cardinality(labels) > 0
            and lower(coalesce(
              nullif(trim(coalesce(listing.area_label, '')), ''),
              nullif(trim(coalesce(school.suburb, '')), ''),
              ''
            )) in (
              select lower(unnest(labels))
            )
          )
        )
      )
    )
    and (
      kind_filter is null
      or (kind_filter = 'free_share' and listing.listing_kind in ('giveaway', 'lending'))
      or listing.listing_kind = kind_filter
    )
    and (
      category_filter is null
      or pg_catalog.lower(listing.category) = pg_catalog.lower(category_filter)
    )
    and (
      needle is null
      or listing.title ilike '%' || needle || '%'
      or listing.description ilike '%' || needle || '%'
      or listing.category ilike '%' || needle || '%'
      or coalesce(listing.area_label, school.suburb, '') ilike '%' || needle || '%'
    );

  return result;
end;
$fn$;
revoke all on function public.search_item_listings(text, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.search_item_listings(text, text, text, text, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- Marketplace chat + favourites: verified parents can contact neighbourhood listings
-- ---------------------------------------------------------------------------
create or replace function public.get_or_create_listing_chat(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
begin
  membership := public.listing_caller_membership();
  select * into listing from public.item_listings where id = p_listing_id for share;
  if listing.id is null or listing.status is distinct from 'active' then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.author_id = auth.uid() then
    raise exception 'authors cannot open marketplace chat with themselves' using errcode = '22023';
  end if;

  low_id := pg_catalog.least(auth.uid(), listing.author_id);
  high_id := pg_catalog.greatest(auth.uid(), listing.author_id);

  select * into room
  from public.chat_rooms
  where item_listing_id = listing.id
    and user_low = low_id
    and user_high = high_id
  for update;

  if room.id is null then
    perform set_config('yourturn.chat_room_mutate', '1', true);
    insert into public.chat_rooms (
      school_id, availability_pattern_id, instant_pickup_request_id, item_listing_id, user_low, user_high
    ) values (
      listing.school_id, null, null, listing.id, low_id, high_id
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
revoke all on function public.get_or_create_listing_chat(uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_listing_chat(uuid) to authenticated;

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
  if listing.id is null or listing.status is distinct from 'active' then
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

-- Listing-chat rooms: participants can read without own-school membership
-- when the room is pinned to a marketplace listing (neighbourhood trades).
drop policy if exists chat_rooms_select on public.chat_rooms;
create policy chat_rooms_select on public.chat_rooms
  for select to authenticated using (
    public.is_admin()
    or (
      auth.uid() in (user_low, user_high)
      and (
        public.is_member(school_id)
        or (
          item_listing_id is not null
          and exists (
            select 1
            from public.school_memberships as membership
            where membership.user_id = auth.uid()
              and membership.status = 'verified'
          )
        )
      )
    )
  );

drop policy if exists chat_participants_select on public.chat_participants;
create policy chat_participants_select on public.chat_participants
  for select to authenticated using (
    public.is_admin()
    or (
      (
        public.is_member(school_id)
        or exists (
          select 1
          from public.chat_rooms as room
          where room.id = chat_participants.room_id
            and room.item_listing_id is not null
            and auth.uid() in (room.user_low, room.user_high)
        )
      )
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

drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages
  for select to authenticated using (
    public.is_admin()
    or (
      exists (
        select 1 from public.chat_participants as participant
        where participant.room_id = chat_messages.room_id
          and participant.user_id = auth.uid()
      )
      and (
        public.is_member(school_id)
        or exists (
          select 1
          from public.chat_rooms as room
          where room.id = chat_messages.room_id
            and room.item_listing_id is not null
            and auth.uid() in (room.user_low, room.user_high)
        )
      )
    )
  );

notify pgrst, 'reload schema';
commit;
