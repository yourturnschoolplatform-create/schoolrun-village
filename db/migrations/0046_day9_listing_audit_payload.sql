-- Task 9.1 remediation: audit payloads may only use outcome/reason_code strings.
begin;
set local search_path = pg_catalog;

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
as $$
declare
  membership public.school_memberships%rowtype;
  created public.item_listings%rowtype;
begin
  membership := public.listing_caller_membership();
  if p_listing_kind is distinct from 'giveaway' and p_listing_kind is distinct from 'lending' then
    raise exception 'listing kind must be giveaway or lending' using errcode = '22023';
  end if;
  if p_display_offer_label is null
    or p_display_offer_label not in (
      'Free', 'Free to collect', 'Free giveaway', 'Lending only', 'Borrow free'
    ) then
    raise exception 'display offer label must be a free-only text label'
      using errcode = '22023';
  end if;
  if (p_listing_kind = 'giveaway'
      and p_display_offer_label not in ('Free', 'Free to collect', 'Free giveaway'))
    or (p_listing_kind = 'lending'
      and p_display_offer_label not in ('Lending only', 'Borrow free')) then
    raise exception 'display offer label must match listing kind' using errcode = '22023';
  end if;
  if not public.listing_text_is_allowed(p_title)
    or not public.listing_text_is_allowed(p_description)
    or not public.listing_text_is_allowed(p_category) then
    raise exception 'listing text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if public.listing_contains_restricted_item(p_title)
    or public.listing_contains_restricted_item(p_description)
    or public.listing_contains_restricted_item(p_category) then
    raise exception 'listing matches a restricted item and cannot be published'
      using errcode = '22023';
  end if;

  insert into public.item_listings (
    school_id, author_id, author_membership, listing_kind,
    title, description, category, display_offer_label
  ) values (
    membership.school_id, auth.uid(), membership.id, p_listing_kind,
    trim(p_title), trim(p_description), trim(p_category), p_display_offer_label
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
$$;
revoke all on function public.create_item_listing(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_item_listing(text, text, text, text, text)
  to authenticated;

commit;
