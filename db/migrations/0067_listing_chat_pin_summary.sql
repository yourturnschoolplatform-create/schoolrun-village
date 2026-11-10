-- Enrich marketplace chat pins with listing summary (title, ask label, cover)
-- for Karrot-style chat headers. Reuses item_listings; no new money/phone columns.
begin;
set local search_path = pg_catalog;

create or replace function public.chat_listing_pin_json(
  p_listing public.item_listings
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $fn$
declare
  suburb text;
  ask_display text;
  cover_src text;
  offer_text text;
begin
  select coalesce(nullif(trim(coalesce(school.suburb, '')), ''), 'Local suburb')
    into suburb
  from public.schools as school
  where school.id = p_listing.school_id;

  if p_listing.ask_aud_cents is not null then
    if p_listing.ask_aud_cents % 100 = 0 then
      ask_display := '$' || (p_listing.ask_aud_cents / 100)::text || ' AUD';
    else
      ask_display := '$' || trim(to_char(p_listing.ask_aud_cents / 100.0, 'FM9999990.00')) || ' AUD';
    end if;
  elsif upper(coalesce(p_listing.display_offer_label, '')) in ('SWAP', 'SALE') then
    ask_display := initcap(lower(p_listing.display_offer_label));
  elsif p_listing.listing_kind = 'swap' then
    ask_display := 'Swap';
  else
    ask_display := 'Free Share';
  end if;

  select img.value ->> 'src'
    into cover_src
  from pg_catalog.jsonb_array_elements(coalesce(p_listing.listing_images, '[]'::jsonb))
    with ordinality as img(value, ord)
  where pg_catalog.lower(coalesce(img.value ->> 'cover', 'false')) in ('true', 't', '1')
  order by img.ord
  limit 1;

  if cover_src is null then
    select img.value ->> 'src'
      into cover_src
    from pg_catalog.jsonb_array_elements(coalesce(p_listing.listing_images, '[]'::jsonb))
      with ordinality as img(value, ord)
    order by img.ord
    limit 1;
  end if;

  offer_text := coalesce(nullif(trim(p_listing.display_offer_label), ''), p_listing.listing_kind);

  return pg_catalog.jsonb_build_object(
    'patternId', p_listing.id,
    'weekday', 1,
    'weekdayLabel', left(p_listing.title, 80),
    'windowStart', '',
    'windowEnd', '',
    'areaLabel', suburb,
    'direction', 'pickup',
    'intent', 'need_help',
    'pinKind', 'marketplace',
    'listingId', p_listing.id,
    'listingTitle', left(p_listing.title, 120),
    'askAudCents', p_listing.ask_aud_cents,
    'askAudDisplay', ask_display,
    'offerLabel', offer_text,
    'coverSrc', cover_src,
    'sellerId', p_listing.author_id
  );
end;
$fn$;
revoke all on function public.chat_listing_pin_json(public.item_listings)
  from public, anon, authenticated;

commit;
