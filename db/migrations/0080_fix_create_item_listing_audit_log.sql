-- Fix create_item_listing audit insert: 23514 on audit_logs_safe_payload_check.
-- Cause: payload included 'area_label' (and possibly JSON null), but
-- public.audit_payload_is_safe only allows string keys:
--   source, outcome, reason_code, previous_status, next_status, version
-- Keep area_label on item_listings; audit only outcome + reason_code (0046 pattern).
begin;
set local search_path = pg_catalog;

create or replace function public.create_item_listing(
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
  ask_cents integer;
  images jsonb := public.normalize_listing_images(coalesce(p_listing_images, '[]'::jsonb));
  condition_value text := nullif(trim(coalesce(p_item_condition, '')), '');
  size_value text := nullif(trim(coalesce(p_size_age_label, '')), '');
  env_values text[] := '{}'::text[];
  env_item text;
  area_value text := nullif(trim(coalesce(p_area_label, '')), '');
  school_suburb text;
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

  -- audit_logs_safe_payload_check / audit_payload_is_safe: string keys only from
  -- {source, outcome, reason_code, previous_status, next_status, version}.
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
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text
) is
  'PostgREST: p_listing_kind, p_title, p_description, p_category, p_display_offer_label, p_ask_aud_cents (AUD cents), p_listing_images, p_item_condition, p_size_age_label, p_household_env, p_area_label. Audit payload: outcome + reason_code only.';

revoke all on function public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.create_item_listing(
  text, text, text, text, text, numeric, jsonb, text, text, jsonb, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
