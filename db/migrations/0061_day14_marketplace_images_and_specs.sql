-- Marketplace listing images (up to 6) + smart item specs + richer create payload.
-- Safe on existing item_listings rows: new columns default empty/null.
-- Column names avoid banned photo_url / price patterns. No in-app payment or phones.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Columns (idempotent ADD IF NOT EXISTS)
-- ---------------------------------------------------------------------------
alter table public.item_listings
  add column if not exists listing_images jsonb not null default '[]'::jsonb;

alter table public.item_listings
  add column if not exists item_condition text;

alter table public.item_listings
  add column if not exists size_age_label text;

alter table public.item_listings
  add column if not exists household_env text[] not null default '{}'::text[];

-- ---------------------------------------------------------------------------
-- Constraints (drop-if-exists on this table, then re-add)
-- ---------------------------------------------------------------------------
do $do$
begin
  if exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'item_listings'
      and constraint_row.conname = 'item_listings_listing_images_check'
  ) then
    alter table public.item_listings drop constraint item_listings_listing_images_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_listing_images_check
    check (
      pg_catalog.jsonb_typeof(listing_images) = 'array'
      and pg_catalog.jsonb_array_length(listing_images) <= 6
    );

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'item_listings'
      and constraint_row.conname = 'item_listings_item_condition_check'
  ) then
    alter table public.item_listings drop constraint item_listings_item_condition_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_item_condition_check
    check (
      item_condition is null
      or item_condition in ('New', 'Like New', 'Good')
    );

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'item_listings'
      and constraint_row.conname = 'item_listings_size_age_label_check'
  ) then
    alter table public.item_listings drop constraint item_listings_size_age_label_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_size_age_label_check
    check (
      size_age_label is null
      or pg_catalog.char_length(pg_catalog.btrim(size_age_label)) between 1 and 40
    );

  if exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as relation on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'item_listings'
      and constraint_row.conname = 'item_listings_household_env_check'
  ) then
    alter table public.item_listings drop constraint item_listings_household_env_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_household_env_check
    check (
      household_env <@ array['Smoke-free', 'Pet-free']::text[]
    );
end;
$do$;

comment on column public.item_listings.listing_images is
  'Up to six compressed listing image data URLs for school marketplace cards. Cover flagged in JSON.';
comment on column public.item_listings.item_condition is
  'Quick spec: New, Like New, or Good.';
comment on column public.item_listings.size_age_label is
  'Quick size or age label for kids goods.';
comment on column public.item_listings.household_env is
  'Household environment chips such as Smoke-free and Pet-free.';

-- ---------------------------------------------------------------------------
-- Validate listing image JSON (data URLs only; max 6; exactly one cover when non-empty)
-- ---------------------------------------------------------------------------
create or replace function public.listing_images_are_valid(p_images jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $fn$
declare
  entry jsonb;
  src text;
  cover_raw text;
  cover_count integer := 0;
  idx integer;
  len integer;
begin
  if p_images is null or pg_catalog.jsonb_typeof(p_images) is distinct from 'array' then
    return false;
  end if;
  len := pg_catalog.jsonb_array_length(p_images);
  if len < 0 or len > 6 then
    return false;
  end if;
  if len = 0 then
    return true;
  end if;
  for idx in 0 .. len - 1 loop
    entry := p_images -> idx;
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object' then
      return false;
    end if;
    src := coalesce(entry ->> 'src', '');
    if pg_catalog.char_length(src) < 32 or pg_catalog.char_length(src) > 220000 then
      return false;
    end if;
    if src !~ '^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$' then
      return false;
    end if;
    cover_raw := pg_catalog.lower(coalesce(entry ->> 'cover', 'false'));
    if cover_raw in ('true', 't', '1') then
      cover_count := cover_count + 1;
    end if;
  end loop;
  if cover_count <> 1 then
    return false;
  end if;
  return true;
end;
$fn$;
revoke all on function public.listing_images_are_valid(jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Listing JSON with images + specs
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
    'householdEnv', to_jsonb(coalesce(p_listing.household_env, '{}'::text[]))
  );
end;
$fn$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create with images + smart specs
-- Defaults keep older 5-arg / 6-arg call shapes working after migrate.
-- ---------------------------------------------------------------------------
drop function if exists public.create_item_listing(text, text, text, text, text);
drop function if exists public.create_item_listing(text, text, text, text, text, integer);
drop function if exists public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, text[]);

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
  p_household_env text[] default null
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
  images jsonb := coalesce(p_listing_images, '[]'::jsonb);
  condition_value text := nullif(trim(coalesce(p_item_condition, '')), '');
  size_value text := nullif(trim(coalesce(p_size_age_label, '')), '');
  env_values text[] := coalesce(p_household_env, '{}'::text[]);
begin
  membership := public.listing_caller_membership();
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
  if not (env_values <@ array['Smoke-free', 'Pet-free']::text[]) then
    raise exception 'household environment chips are limited to Smoke-free and Pet-free'
      using errcode = '22023';
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

  insert into public.item_listings (
    school_id, author_id, author_membership, listing_kind,
    title, description, category, display_offer_label, ask_aud_cents,
    listing_images, item_condition, size_age_label, household_env
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer, ask_cents,
    images, condition_value, size_value, env_values
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
revoke all on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, text[])
  to authenticated;

commit;
