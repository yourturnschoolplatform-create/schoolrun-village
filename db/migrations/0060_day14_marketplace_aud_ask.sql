-- Marketplace full kids categories + Sell ask in AUD cents (listing display only).
-- No in-app payment capture. Free Share / Swap keep null ask. No photos or phones.
begin;
set local search_path = pg_catalog;

alter table public.item_listings
  add column if not exists ask_aud_cents integer;

do $do$
begin
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'item_listings_ask_aud_cents_check'
  ) then
    alter table public.item_listings drop constraint item_listings_ask_aud_cents_check;
  end if;
  alter table public.item_listings
    add constraint item_listings_ask_aud_cents_check
    check (
      ask_aud_cents is null
      or ask_aud_cents between 100 and 99999900
    );

  if exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'item_listings_ask_matches_kind'
  ) then
    alter table public.item_listings drop constraint item_listings_ask_matches_kind;
  end if;
  -- Ask cents only on sale. New sales require ask via create RPC; legacy null sale rows allowed.
  alter table public.item_listings
    add constraint item_listings_ask_matches_kind check (
      (listing_kind = 'sale' and (
        ask_aud_cents is null
        or ask_aud_cents between 100 and 99999900
      ))
      or (listing_kind in ('giveaway', 'lending', 'swap') and ask_aud_cents is null)
    );
end;
$do$;

comment on column public.item_listings.ask_aud_cents is
  'Parent-to-parent Sell ask in Australian cents for card display. Null for Free Share and Swap. No in-app payment.';

alter table public.item_listings
  drop constraint if exists item_listings_category_parent_check;

alter table public.item_listings
  add constraint item_listings_category_parent_check
  check (
    category in (
      'Baby & Toddler Gear',
      'Toys & Outdoor',
      'Kids Fashion & Shoes',
      'Books & Learning',
      'School & Nursery',
      'School Uniforms',
      'Books & Toys',
      'Baby & Kids Gear',
      'Kids Clothing'
    )
    or char_length(trim(category)) between 2 and 40
  );

-- ---------------------------------------------------------------------------
-- Listing JSON with AUD ask display
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
      ask_display := '$' || (p_listing.ask_aud_cents / 100)::text;
    else
      ask_display := '$' || trim(to_char(p_listing.ask_aud_cents / 100.0, 'FM9999990.00'));
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
    'askAudDisplay', ask_display
  );
end;
$fn$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create with optional AUD ask (required for sale)
-- ---------------------------------------------------------------------------
drop function if exists public.create_item_listing(text, text, text, text, text);

create function public.create_item_listing(
  p_listing_kind text,
  p_title text,
  p_description text,
  p_category text,
  p_display_offer_label text,
  p_ask_aud_cents integer default null
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
    title, description, category, display_offer_label, ask_aud_cents
  ) values (
    membership.school_id, auth.uid(), membership.id, kind,
    trim(p_title), trim(p_description), category_value, offer, ask_cents
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
revoke all on function public.create_item_listing(text, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text, integer)
  to authenticated;

commit;
