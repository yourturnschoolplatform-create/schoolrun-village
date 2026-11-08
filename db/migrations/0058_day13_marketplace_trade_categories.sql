-- Phase 2: marketplace trade types (sale / free share / swap), parent categories,
-- seller school location on listing JSON, and listing-pinned 1:1 chat.
-- Text badges only (SALE / FREE / SWAP). No amount, price, currency, payment or photo fields.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Expand listing kinds and offer badges
-- ---------------------------------------------------------------------------
alter table public.item_listings
  drop constraint if exists item_listings_listing_kind_check;
alter table public.item_listings
  drop constraint if exists item_listings_display_offer_label_check;
alter table public.item_listings
  drop constraint if exists item_listings_offer_matches_kind;

alter table public.item_listings
  add constraint item_listings_listing_kind_check
  check (listing_kind in ('giveaway', 'lending', 'sale', 'swap'));

alter table public.item_listings
  add constraint item_listings_display_offer_label_check
  check (display_offer_label in (
    'Free', 'Free to collect', 'Free giveaway', 'Lending only', 'Borrow free',
    'FREE', 'SALE', 'SWAP'
  ));

alter table public.item_listings
  add constraint item_listings_offer_matches_kind check (
    (listing_kind = 'giveaway' and display_offer_label in (
      'Free', 'Free to collect', 'Free giveaway', 'FREE'
    ))
    or (listing_kind = 'lending' and display_offer_label in (
      'Lending only', 'Borrow free', 'FREE'
    ))
    or (listing_kind = 'sale' and display_offer_label = 'SALE')
    or (listing_kind = 'swap' and display_offer_label = 'SWAP')
  );

alter table public.item_listings
  drop constraint if exists item_listings_category_check;

alter table public.item_listings
  add constraint item_listings_category_parent_check
  check (
    category in (
      'School Uniforms',
      'Books & Toys',
      'Baby & Kids Gear',
      'Kids Clothing'
    )
    or char_length(trim(category)) between 2 and 40
  );

comment on column public.item_listings.listing_kind is
  'giveaway/lending = Free Share (Relay); sale = SALE badge only; swap = SWAP badge. No money fields.';
comment on column public.item_listings.display_offer_label is
  'Text-only trade badge. Never amount, price, currency or payment.';

-- ---------------------------------------------------------------------------
-- Listing-pinned chat rooms (extend pin XOR)
-- ---------------------------------------------------------------------------
alter table public.chat_rooms
  add column if not exists item_listing_id uuid;

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
    where conname = 'chat_rooms_item_listing_id_fkey'
  ) then
    alter table public.chat_rooms
      add constraint chat_rooms_item_listing_id_fkey
      foreign key (item_listing_id)
      references public.item_listings(id) on delete restrict;
  end if;

  alter table public.chat_rooms
    add constraint chat_rooms_pin_xor_check check (
      (
        availability_pattern_id is not null
        and instant_pickup_request_id is null
        and item_listing_id is null
      )
      or (
        availability_pattern_id is null
        and instant_pickup_request_id is not null
        and item_listing_id is null
      )
      or (
        availability_pattern_id is null
        and instant_pickup_request_id is null
        and item_listing_id is not null
      )
    );
end;
$do$;

create unique index if not exists chat_rooms_item_listing_pair_uidx
  on public.chat_rooms (item_listing_id, user_low, user_high)
  where item_listing_id is not null;

-- ---------------------------------------------------------------------------
-- Listing JSON with seller suburb · school badge fields
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
begin
  select profile.display_name into author_name
  from public.profiles as profile
  where profile.id = p_listing.author_id;
  select school.display_name, school.suburb, school.school_sector
    into school_name, school_suburb, school_sector
  from public.schools as school
  where school.id = p_listing.school_id;
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
    'schoolSector', coalesce(school_sector, 'primary')
  );
end;
$fn$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

create or replace function public.chat_listing_pin_json(
  p_listing public.item_listings
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $fn$
  select pg_catalog.jsonb_build_object(
    'patternId', p_listing.id,
    'weekday', 1,
    'weekdayLabel', left(p_listing.title, 80),
    'windowStart', '',
    'windowEnd', '',
    'areaLabel', coalesce(nullif(trim(coalesce((
      select school.suburb from public.schools as school where school.id = p_listing.school_id
    ), '')), ''), 'Local suburb'),
    'direction', 'pickup',
    'intent', 'need_help',
    'pinKind', 'marketplace'
  )
$fn$;
revoke all on function public.chat_listing_pin_json(public.item_listings)
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
  listing public.item_listings%rowtype;
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
  else
    select * into listing from public.item_listings where id = p_room.item_listing_id;
    schedule := public.chat_listing_pin_json(listing);
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
-- Create / search RPCs
-- ---------------------------------------------------------------------------
create or replace function public.create_item_listing(
  p_listing_kind text,
  p_title text,
  p_description text,
  p_category text,
  p_display_offer_label text
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
begin
  membership := public.listing_caller_membership();
  if kind not in ('giveaway', 'lending', 'sale', 'swap') then
    raise exception 'listing kind must be giveaway, lending, sale or swap' using errcode = '22023';
  end if;
  if category_value not in (
    'School Uniforms', 'Books & Toys', 'Baby & Kids Gear', 'Kids Clothing'
  ) and pg_catalog.char_length(category_value) not between 2 and 40 then
    raise exception 'choose a parent marketplace category' using errcode = '22023';
  end if;
  if kind = 'sale' then
    offer := 'SALE';
  elsif kind = 'swap' then
    offer := 'SWAP';
  elsif kind in ('giveaway', 'lending') and offer not in (
    'Free', 'Free to collect', 'Free giveaway', 'Lending only', 'Borrow free', 'FREE'
  ) then
    offer := 'FREE';
  end if;
  if (kind = 'giveaway' and offer not in ('Free', 'Free to collect', 'Free giveaway', 'FREE'))
    or (kind = 'lending' and offer not in ('Lending only', 'Borrow free', 'FREE'))
    or (kind = 'sale' and offer is distinct from 'SALE')
    or (kind = 'swap' and offer is distinct from 'SWAP') then
    raise exception 'display offer label must match listing kind' using errcode = '22023';
  end if;
  if not public.listing_text_is_allowed(p_title)
    or not public.listing_text_is_allowed(p_description)
    or not public.listing_text_is_allowed(category_value) then
    raise exception 'listing text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if public.listing_contains_restricted_item(p_title)
    or public.listing_contains_restricted_item(p_description)
    or public.listing_contains_restricted_item(category_value) then
    raise exception 'listing matches a restricted item and cannot be published'
      using errcode = '22023';
  end if;

  insert into public.item_listings (
    school_id, author_id, author_membership, listing_kind,
    title, description, category, display_offer_label
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer
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
revoke all on function public.create_item_listing(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text)
  to authenticated;

create or replace function public.search_item_listings(
  p_query text default null,
  p_listing_kind text default null,
  p_category text default null
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
  result jsonb;
begin
  membership := public.listing_caller_membership();
  if p_listing_kind is not null
    and p_listing_kind not in ('giveaway', 'lending', 'sale', 'swap', 'free_share') then
    raise exception 'listing kind filter is invalid' using errcode = '22023';
  end if;
  needle := nullif(trim(coalesce(p_query, '')), '');
  if needle is not null and not public.listing_text_is_allowed(needle) then
    raise exception 'search text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  kind_filter := p_listing_kind;
  category_filter := nullif(trim(coalesce(p_category, '')), '');

  select coalesce(pg_catalog.jsonb_agg(public.item_listing_json(listing) order by listing.created_at desc), '[]'::jsonb)
  into result
  from public.item_listings listing
  where listing.school_id = membership.school_id
    and listing.status = 'active'
    and public.is_member(listing.school_id)
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
    );

  return result;
end;
$fn$;
revoke all on function public.search_item_listings(text, text, text)
  from public, anon, authenticated;
grant execute on function public.search_item_listings(text, text, text)
  to authenticated;

-- Open or create 1:1 chat with the listing author.
create or replace function public.get_or_create_listing_chat(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  listing public.item_listings%rowtype;
  room public.chat_rooms%rowtype;
  low_id uuid;
  high_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into listing from public.item_listings where id = p_listing_id for share;
  if listing.id is null
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
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

commit;
