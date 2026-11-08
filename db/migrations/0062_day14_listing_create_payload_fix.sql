-- Harden marketplace create payload for PostgREST clients.
-- - Accept household env as jsonb (avoids text[] encode failures)
-- - Normalise listing_images cover before validate
-- - Optional fields default safely (empty images / env)
-- - Reload PostgREST schema cache so new args resolve
-- Inserts remain SECURITY DEFINER RPC-only (no direct INSERT grant).
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Normalise image JSON: empty OK; otherwise exactly one cover (first wins)
-- ---------------------------------------------------------------------------
create or replace function public.normalize_listing_images(p_images jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $fn$
declare
  src_list jsonb := '[]'::jsonb;
  entry jsonb;
  src text;
  idx integer;
  len integer;
  cover_idx integer := -1;
  out_json jsonb := '[]'::jsonb;
begin
  if p_images is null or pg_catalog.jsonb_typeof(p_images) is distinct from 'array' then
    return '[]'::jsonb;
  end if;
  len := pg_catalog.jsonb_array_length(p_images);
  if len = 0 then
    return '[]'::jsonb;
  end if;
  if len > 6 then
    len := 6;
  end if;

  for idx in 0 .. len - 1 loop
    entry := p_images -> idx;
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object' then
      continue;
    end if;
    src := coalesce(entry ->> 'src', '');
    if pg_catalog.char_length(src) < 32 or pg_catalog.char_length(src) > 220000 then
      continue;
    end if;
    if src !~ '^data:image/(jpeg|jpg|png|webp);base64,' then
      continue;
    end if;
    src_list := src_list || jsonb_build_array(src);
    if cover_idx < 0 and pg_catalog.lower(coalesce(entry ->> 'cover', 'false')) in ('true', 't', '1') then
      cover_idx := pg_catalog.jsonb_array_length(src_list) - 1;
    end if;
  end loop;

  len := pg_catalog.jsonb_array_length(src_list);
  if len = 0 then
    return '[]'::jsonb;
  end if;
  if cover_idx < 0 or cover_idx >= len then
    cover_idx := 0;
  end if;

  for idx in 0 .. len - 1 loop
    out_json := out_json || jsonb_build_array(
      jsonb_build_object(
        'src', src_list ->> idx,
        'cover', (idx = cover_idx)
      )
    );
  end loop;
  return out_json;
end;
$fn$;
revoke all on function public.normalize_listing_images(jsonb)
  from public, anon, authenticated;

create or replace function public.listing_images_are_valid(p_images jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $fn$
declare
  normalised jsonb := public.normalize_listing_images(p_images);
  entry jsonb;
  src text;
  cover_count integer := 0;
  idx integer;
  len integer;
begin
  if pg_catalog.jsonb_typeof(normalised) is distinct from 'array' then
    return false;
  end if;
  len := pg_catalog.jsonb_array_length(normalised);
  if len = 0 then
    return true;
  end if;
  if len > 6 then
    return false;
  end if;
  for idx in 0 .. len - 1 loop
    entry := normalised -> idx;
    src := coalesce(entry ->> 'src', '');
    if src !~ '^data:image/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$' then
      return false;
    end if;
    if coalesce((entry ->> 'cover')::boolean, false) then
      cover_count := cover_count + 1;
    end if;
  end loop;
  return cover_count = 1;
end;
$fn$;
revoke all on function public.listing_images_are_valid(jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recreate create RPC with jsonb household env + normalised images
-- ---------------------------------------------------------------------------
drop function if exists public.create_item_listing(text, text, text, text, text);
drop function if exists public.create_item_listing(text, text, text, text, text, integer);
drop function if exists public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, text[]);
drop function if exists public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb);

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
  p_household_env jsonb default '[]'::jsonb
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

  insert into public.item_listings (
    school_id, author_id, author_membership, listing_kind,
    title, description, category, display_offer_label, ask_aud_cents,
    listing_images, item_condition, size_age_label, household_env
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer, ask_cents,
    images, condition_value, size_value, coalesce(env_values, '{}'::text[])
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
revoke all on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text, integer, jsonb, text, text, jsonb)
  to authenticated;

-- Direct table INSERT remains denied; create goes through the RPC above.
-- Keep SELECT for authenticated school members (existing RLS). No INSERT policy.

notify pgrst, 'reload schema';

commit;
