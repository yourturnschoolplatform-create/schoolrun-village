-- Upsert a dynamically chosen AU school (Overpass / onboarding) then join as verified.
-- Frontend: rpc('ensure_and_join_school', { p_display_name, p_suburb, p_state, p_external_key })
begin;
set local search_path = pg_catalog;

create or replace function public.ensure_and_join_school(
  p_display_name text,
  p_suburb text,
  p_state text default 'VIC',
  p_external_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  caller uuid := auth.uid();
  school_id uuid;
  membership_id uuid;
  clean_name text;
  clean_suburb text;
  clean_state text;
  base_slug text;
  final_slug text;
  tz text;
  sector text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_name := nullif(trim(coalesce(p_display_name, '')), '');
  -- Strip parentheticals e.g. "Melbourne (CBD)" → "Melbourne" for suburb-label checks.
  clean_suburb := nullif(
    trim(regexp_replace(coalesce(p_suburb, ''), '\s*\([^)]*\)', '', 'g')),
    ''
  );
  clean_suburb := nullif(regexp_replace(coalesce(clean_suburb, ''), '\s+', ' ', 'g'), '');
  clean_state := upper(nullif(trim(coalesce(p_state, '')), ''));
  if clean_name is null or char_length(clean_name) < 2 then
    raise exception 'school name required' using errcode = '22023';
  end if;
  if clean_suburb is null or char_length(clean_suburb) < 2 then
    raise exception 'suburb required' using errcode = '22023';
  end if;
  if not public.is_suburb_area_label(clean_suburb) then
    raise exception 'suburb must be a suburb-level label' using errcode = '22023';
  end if;
  if clean_state is null then
    clean_state := 'VIC';
  end if;

  -- Match an existing active school by suburb + display name (case-insensitive).
  select school.id into school_id
  from public.schools as school
  where school.is_active
    and lower(school.display_name) = lower(clean_name)
    and (
      school.suburb is null
      or lower(trim(school.suburb)) = lower(clean_suburb)
    )
  order by school.created_at asc
  limit 1;

  if school_id is null and p_external_key is not null and length(trim(p_external_key)) > 1 then
    base_slug := lower(trim(p_external_key));
    base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
    base_slug := trim(both '-' from base_slug);
    if base_slug <> '' then
      select school.id into school_id
      from public.schools as school
      where school.slug = left(base_slug, 80)
         or school.slug like left(base_slug, 60) || '-%'
      order by school.created_at asc
      limit 1;
    end if;
  end if;

  if school_id is null then
    base_slug := lower(clean_name || '-' || clean_suburb);
    base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
    base_slug := trim(both '-' from base_slug);
    if base_slug is null or base_slug = '' then
      base_slug := 'school';
    end if;
    base_slug := left(base_slug, 60);
    final_slug := base_slug;
    if exists (select 1 from public.schools where slug = final_slug) then
      final_slug := left(base_slug, 50) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    end if;

    tz := case clean_state
      when 'NSW' then 'Australia/Sydney'
      when 'ACT' then 'Australia/Sydney'
      when 'TAS' then 'Australia/Hobart'
      else 'Australia/Melbourne'
    end;

    sector := case
      when clean_name ~* '(high|secondary|college|grammar)' then 'secondary'
      else 'primary'
    end;

    insert into public.schools (slug, display_name, timezone, suburb, school_sector, is_active)
    values (final_slug, left(clean_name, 160), tz, left(clean_suburb, 64), sector, true)
    returning id into school_id;

    insert into public.school_configs (school_id)
    values (school_id)
    on conflict (school_id) do nothing;
  end if;

  select membership.id into membership_id
  from public.school_memberships as membership
  where membership.school_id = school_id
    and membership.user_id = caller
  for update;

  if membership_id is null then
    insert into public.school_memberships (
      school_id,
      user_id,
      status,
      verified_email_at,
      invite_code_verified_at,
      approved_by,
      approved_at
    ) values (
      school_id,
      caller,
      'verified',
      pg_catalog.now(),
      pg_catalog.now(),
      caller,
      pg_catalog.now()
    )
    returning id into membership_id;
  else
    update public.school_memberships as membership
    set
      status = 'verified',
      verified_email_at = coalesce(membership.verified_email_at, pg_catalog.now()),
      invite_code_verified_at = coalesce(membership.invite_code_verified_at, pg_catalog.now()),
      approved_by = coalesce(membership.approved_by, caller),
      approved_at = coalesce(membership.approved_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
    where membership.id = membership_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'schoolId', school_id,
    'membershipId', membership_id,
    'displayName', clean_name,
    'suburb', clean_suburb
  );
end;
$fn$;

comment on function public.ensure_and_join_school(text, text, text, text) is
  'Upsert onboarding school by name+suburb then join caller as verified. Args: p_display_name, p_suburb, p_state, p_external_key.';

revoke all on function public.ensure_and_join_school(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.ensure_and_join_school(text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
