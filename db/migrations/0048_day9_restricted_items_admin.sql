-- Task 9.3: administrator management of the restricted listing catalogue.
-- Soft deactivate only (no hard delete). No amount, price, currency, payment,
-- phone, photo, nickname or live location fields.
begin;
set local search_path = pg_catalog;

create function public.listing_restricted_item_json(p_item public.listing_restricted_items)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_item.id,
    'slug', p_item.slug,
    'label', p_item.label,
    'match_terms', pg_catalog.to_jsonb(p_item.match_terms),
    'is_active', p_item.is_active,
    'created_at', p_item.created_at,
    'updated_at', p_item.updated_at
  );
$$;
revoke all on function public.listing_restricted_item_json(public.listing_restricted_items)
  from public, anon, authenticated;

create function public.listing_require_admin()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'administrator role required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.listing_require_admin() from public, anon, authenticated;

create function public.listing_normalise_match_terms(p_terms text[])
returns text[]
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  normalised text[] := '{}'::text[];
  term text;
  cleaned text;
begin
  if p_terms is null or pg_catalog.cardinality(p_terms) < 1 then
    raise exception 'restricted item match terms are required' using errcode = '22023';
  end if;
  foreach term in array p_terms
  loop
    cleaned := pg_catalog.lower(trim(coalesce(term, '')));
    if char_length(cleaned) < 2 or char_length(cleaned) > 80 then
      raise exception 'restricted item match term length is invalid' using errcode = '22023';
    end if;
    if not public.listing_text_is_allowed(cleaned) then
      raise exception 'restricted item text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
    if not (cleaned = any (normalised)) then
      normalised := normalised || cleaned;
    end if;
  end loop;
  if pg_catalog.cardinality(normalised) < 1 then
    raise exception 'restricted item match terms are required' using errcode = '22023';
  end if;
  return normalised;
end;
$$;
revoke all on function public.listing_normalise_match_terms(text[])
  from public, anon, authenticated;

create function public.create_restricted_listing_item(
  p_slug text,
  p_label text,
  p_match_terms text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created public.listing_restricted_items%rowtype;
  slug_clean text;
  label_clean text;
  terms text[];
begin
  perform public.listing_require_admin();
  slug_clean := pg_catalog.lower(trim(coalesce(p_slug, '')));
  label_clean := trim(coalesce(p_label, ''));
  if char_length(slug_clean) < 2 or char_length(slug_clean) > 64
    or slug_clean !~ '^[a-z0-9_]+$' then
    raise exception 'restricted item slug is invalid' using errcode = '22023';
  end if;
  if char_length(label_clean) < 2 or char_length(label_clean) > 120
    or not public.listing_text_is_allowed(label_clean) then
    raise exception 'restricted item label is invalid' using errcode = '22023';
  end if;
  terms := public.listing_normalise_match_terms(p_match_terms);

  perform pg_catalog.set_config('yourturn.listing_restricted_admin', '1', true);
  insert into public.listing_restricted_items (slug, label, match_terms, is_active)
  values (slug_clean, label_clean, terms, true)
  returning * into created;
  perform pg_catalog.set_config('yourturn.listing_restricted_admin', '0', true);

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'listing_restricted.created', 'listing_restricted_item',
    created.id,
    pg_catalog.jsonb_build_object(
      'outcome', 'created',
      'reason_code', 'restricted_catalogue'
    )
  );

  return public.listing_restricted_item_json(created);
exception
  when unique_violation then
    perform pg_catalog.set_config('yourturn.listing_restricted_admin', '0', true);
    raise exception 'restricted item slug already exists' using errcode = '22023';
end;
$$;
revoke all on function public.create_restricted_listing_item(text, text, text[])
  from public, anon, authenticated;
grant execute on function public.create_restricted_listing_item(text, text, text[])
  to authenticated;

create function public.update_restricted_listing_item(
  p_item_id uuid,
  p_label text,
  p_match_terms text[],
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing public.listing_restricted_items%rowtype;
  updated public.listing_restricted_items%rowtype;
  label_clean text;
  terms text[];
begin
  perform public.listing_require_admin();
  select * into existing from public.listing_restricted_items where id = p_item_id;
  if existing.id is null then
    raise exception 'restricted item unavailable' using errcode = 'P0002';
  end if;
  label_clean := trim(coalesce(p_label, ''));
  if char_length(label_clean) < 2 or char_length(label_clean) > 120
    or not public.listing_text_is_allowed(label_clean) then
    raise exception 'restricted item label is invalid' using errcode = '22023';
  end if;
  terms := public.listing_normalise_match_terms(p_match_terms);
  if p_is_active is null then
    raise exception 'restricted item active flag is required' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('yourturn.listing_restricted_admin', '1', true);
  update public.listing_restricted_items
  set label = label_clean,
      match_terms = terms,
      is_active = p_is_active,
      updated_at = pg_catalog.now()
  where id = existing.id
  returning * into updated;
  perform pg_catalog.set_config('yourturn.listing_restricted_admin', '0', true);

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'listing_restricted.updated', 'listing_restricted_item',
    updated.id,
    pg_catalog.jsonb_build_object(
      'outcome', case when p_is_active then 'updated' else 'deactivated' end,
      'reason_code', 'restricted_catalogue'
    )
  );

  return public.listing_restricted_item_json(updated);
end;
$$;
revoke all on function public.update_restricted_listing_item(uuid, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.update_restricted_listing_item(uuid, text, text[], boolean)
  to authenticated;

create function public.list_all_restricted_listing_items()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  perform public.listing_require_admin();
  select coalesce(pg_catalog.jsonb_agg(
    public.listing_restricted_item_json(item)
    order by item.label, item.slug
  ), '[]'::jsonb)
  into result
  from public.listing_restricted_items item;
  return result;
end;
$$;
revoke all on function public.list_all_restricted_listing_items()
  from public, anon, authenticated;
grant execute on function public.list_all_restricted_listing_items() to authenticated;

commit;
