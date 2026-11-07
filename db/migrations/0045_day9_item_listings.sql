-- Task 9.1: school-scoped free giveaway/lending listings, restricted-item
-- enforcement, search/filter, and same-school enquiries.
-- Text-only free display offer label only. No amount, price, currency, payment,
-- phone, photo, child nickname, or live location fields.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Restricted item catalogue (seeded; admin edit path arrives in Task 9.3)
-- ---------------------------------------------------------------------------
create table public.listing_restricted_items (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  slug text not null
    check (char_length(trim(slug)) between 2 and 64),
  label text not null
    check (char_length(trim(label)) between 2 and 120),
  match_terms text[] not null
    check (pg_catalog.cardinality(match_terms) >= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (slug)
);

comment on table public.listing_restricted_items is
  'Admin-editable catalogue of items that must not be listed. No money fields.';

create index listing_restricted_items_active_idx
  on public.listing_restricted_items (is_active);

create table public.item_listings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  author_id uuid not null references public.profiles(id) on delete restrict,
  author_membership uuid not null,
  listing_kind text not null
    check (listing_kind in ('giveaway', 'lending')),
  title text not null
    check (char_length(trim(title)) between 3 and 120),
  description text not null
    check (char_length(trim(description)) between 1 and 2000),
  category text not null
    check (char_length(trim(category)) between 2 and 40),
  -- Free-only text display of the offer. Never amount, money, currency or payment.
  display_offer_label text not null
    check (display_offer_label in (
      'Free',
      'Free to collect',
      'Free giveaway',
      'Lending only',
      'Borrow free'
    )),
  status text not null default 'active'
    check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (author_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict,
  constraint item_listings_offer_matches_kind check (
    (listing_kind = 'giveaway' and display_offer_label in ('Free', 'Free to collect', 'Free giveaway'))
    or (listing_kind = 'lending' and display_offer_label in ('Lending only', 'Borrow free'))
  )
);
create index item_listings_school_created_idx
  on public.item_listings (school_id, created_at desc);
create index item_listings_school_kind_idx
  on public.item_listings (school_id, listing_kind, status);
create index item_listings_school_category_idx
  on public.item_listings (school_id, lower(category), status);
alter table public.item_listings
  add constraint item_listings_id_school_key unique (id, school_id);

comment on table public.item_listings is
  'School-scoped free giveaway or lending listings. Text-only free offer label; no amount, price, currency, payment, photo or phone.';
comment on column public.item_listings.display_offer_label is
  'Strict text-only free display offer. Never money, amount, currency or payment.';

create table public.listing_enquiries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  listing_id uuid not null,
  enquirer_id uuid not null references public.profiles(id) on delete restrict,
  enquirer_membership uuid not null,
  body text not null
    check (char_length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (listing_id, school_id)
    references public.item_listings(id, school_id) on delete restrict,
  foreign key (enquirer_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index listing_enquiries_listing_idx
  on public.listing_enquiries (listing_id, created_at);
create index listing_enquiries_school_idx
  on public.listing_enquiries (school_id, created_at desc);
create index listing_enquiries_enquirer_idx
  on public.listing_enquiries (enquirer_id, created_at desc);

comment on table public.listing_enquiries is
  'Same-school text enquiries on free listings. No payment, contact numbers or money fields.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.listing_text_is_allowed(p_text text)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
begin
  return public.community_text_is_allowed(p_text);
end;
$$;
revoke all on function public.listing_text_is_allowed(text) from public, anon, authenticated;

create function public.listing_contains_restricted_item(p_text text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  normalised text;
  item record;
  term text;
begin
  if p_text is null then
    return false;
  end if;
  normalised := pg_catalog.lower(trim(p_text));
  if char_length(normalised) = 0 then
    return false;
  end if;
  for item in
    select match_terms
    from public.listing_restricted_items
    where is_active
  loop
    foreach term in array item.match_terms
    loop
      if term is not null
        and char_length(trim(term)) > 0
        and position(pg_catalog.lower(trim(term)) in normalised) > 0 then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end;
$$;
revoke all on function public.listing_contains_restricted_item(text)
  from public, anon, authenticated;

create function public.guard_listing_restricted_items()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'listing restricted items cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE'
    and current_setting('yourturn.listing_restricted_admin', true) is distinct from '1' then
    raise exception 'listing restricted items are admin-gated'
      using errcode = '55000';
  end if;
  if tg_op = 'INSERT'
    and current_setting('yourturn.listing_restricted_admin', true) is distinct from '1'
    and current_user in ('authenticated', 'anon') then
    raise exception 'listing restricted items are admin-gated'
      using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_listing_restricted_items() from public, anon, authenticated;

create trigger listing_restricted_items_guard_rows
  before insert or update or delete on public.listing_restricted_items
  for each row execute function public.guard_listing_restricted_items();
create trigger listing_restricted_items_guard_truncate
  before truncate on public.listing_restricted_items
  for each statement execute function public.guard_listing_restricted_items();
alter table public.listing_restricted_items enable always trigger listing_restricted_items_guard_rows;
alter table public.listing_restricted_items enable always trigger listing_restricted_items_guard_truncate;

create function public.guard_item_listings()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'item listings cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'item listings are immutable in Task 9.1' using errcode = '55000';
  end if;
  if not public.listing_text_is_allowed(new.title)
    or not public.listing_text_is_allowed(new.description)
    or not public.listing_text_is_allowed(new.category) then
    raise exception 'listing text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if public.listing_contains_restricted_item(new.title)
    or public.listing_contains_restricted_item(new.description)
    or public.listing_contains_restricted_item(new.category) then
    raise exception 'listing matches a restricted item and cannot be published'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_item_listings() from public, anon, authenticated;

create trigger item_listings_guard_rows
  before insert or update or delete on public.item_listings
  for each row execute function public.guard_item_listings();
create trigger item_listings_guard_truncate
  before truncate on public.item_listings
  for each statement execute function public.guard_item_listings();
alter table public.item_listings enable always trigger item_listings_guard_rows;
alter table public.item_listings enable always trigger item_listings_guard_truncate;

create function public.guard_listing_enquiries()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'listing enquiries cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'listing enquiries are append-only' using errcode = '55000';
  end if;
  if not public.listing_text_is_allowed(new.body) then
    raise exception 'listing enquiry must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_listing_enquiries() from public, anon, authenticated;

create trigger listing_enquiries_guard_rows
  before insert or update or delete on public.listing_enquiries
  for each row execute function public.guard_listing_enquiries();
create trigger listing_enquiries_guard_truncate
  before truncate on public.listing_enquiries
  for each statement execute function public.guard_listing_enquiries();
alter table public.listing_enquiries enable always trigger listing_enquiries_guard_rows;
alter table public.listing_enquiries enable always trigger listing_enquiries_guard_truncate;

-- ---------------------------------------------------------------------------
-- Seed restricted catalogue (migration owner; admin GUC)
-- ---------------------------------------------------------------------------
select pg_catalog.set_config('yourturn.listing_restricted_admin', '1', true);

insert into public.listing_restricted_items (slug, label, match_terms) values
  ('car_seat', 'Car seats',
    array['car seat', 'car seats', 'infant car seat', 'booster seat']),
  ('cot', 'Cots',
    array['cot', 'cots', 'baby cot']),
  ('bassinet', 'Bassinets',
    array['bassinet', 'bassinets', 'bassinettes']),
  ('bunk_bed', 'Bunk beds',
    array['bunk bed', 'bunk beds', 'bunkbed']),
  ('baby_walker', 'Baby walkers',
    array['baby walker', 'baby walkers', 'infant walker']),
  ('recalled_item', 'Recalled items',
    array['recalled', 'recall', 'product recall', 'safety recall']);

select pg_catalog.set_config('yourturn.listing_restricted_admin', '', true);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.listing_restricted_items enable row level security;
alter table public.item_listings enable row level security;
alter table public.listing_enquiries enable row level security;

create policy listing_restricted_items_select on public.listing_restricted_items
  for select to authenticated using (
    public.is_admin() or is_active
  );

create policy item_listings_select on public.item_listings
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
    or (author_id = auth.uid() and public.is_member(school_id))
  );

create policy listing_enquiries_select on public.listing_enquiries
  for select to authenticated using (
    public.is_admin()
    or (
      public.is_member(school_id)
      and (
        enquirer_id = auth.uid()
        or exists (
          select 1 from public.item_listings listing
          where listing.id = listing_enquiries.listing_id
            and listing.school_id = listing_enquiries.school_id
            and listing.author_id = auth.uid()
        )
      )
    )
  );

revoke all on table public.listing_restricted_items from public, anon, authenticated;
revoke all on table public.item_listings from public, anon, authenticated;
revoke all on table public.listing_enquiries from public, anon, authenticated;
grant select on table public.listing_restricted_items to authenticated;
grant select on table public.item_listings to authenticated;
grant select on table public.listing_enquiries to authenticated;

-- ---------------------------------------------------------------------------
-- Internal membership + JSON
-- ---------------------------------------------------------------------------
create function public.listing_caller_membership()
returns public.school_memberships
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into membership
  from public.school_memberships row_membership
  where row_membership.user_id = auth.uid()
    and row_membership.status = 'verified'
  order by row_membership.created_at, row_membership.id
  limit 1;
  if membership.id is null or not public.is_member(membership.school_id) then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  return membership;
end;
$$;
revoke all on function public.listing_caller_membership() from public, anon, authenticated;

create function public.item_listing_json(p_listing public.item_listings)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_listing.id,
    'school_id', p_listing.school_id,
    'author_id', p_listing.author_id,
    'author_display_name', (
      select profile.display_name from public.profiles profile where profile.id = p_listing.author_id
    ),
    'listing_kind', p_listing.listing_kind,
    'title', p_listing.title,
    'description', p_listing.description,
    'category', p_listing.category,
    'display_offer_label', p_listing.display_offer_label,
    'status', p_listing.status,
    'created_at', p_listing.created_at
  );
$$;
revoke all on function public.item_listing_json(public.item_listings)
  from public, anon, authenticated;

create function public.listing_enquiry_json(p_enquiry public.listing_enquiries)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_enquiry.id,
    'school_id', p_enquiry.school_id,
    'listing_id', p_enquiry.listing_id,
    'enquirer_id', p_enquiry.enquirer_id,
    'enquirer_display_name', (
      select profile.display_name from public.profiles profile where profile.id = p_enquiry.enquirer_id
    ),
    'body', p_enquiry.body,
    'created_at', p_enquiry.created_at
  );
$$;
revoke all on function public.listing_enquiry_json(public.listing_enquiries)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create function public.create_item_listing(
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

create function public.search_item_listings(
  p_query text default null,
  p_listing_kind text default null,
  p_category text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  needle text;
  kind_filter text;
  category_filter text;
  result jsonb;
begin
  membership := public.listing_caller_membership();
  if p_listing_kind is not null
    and p_listing_kind is distinct from 'giveaway'
    and p_listing_kind is distinct from 'lending' then
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
    and (kind_filter is null or listing.listing_kind = kind_filter)
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
$$;
revoke all on function public.search_item_listings(text, text, text)
  from public, anon, authenticated;
grant execute on function public.search_item_listings(text, text, text)
  to authenticated;

create function public.get_item_listing(p_listing_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
begin
  membership := public.listing_caller_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  return public.item_listing_json(listing);
end;
$$;
revoke all on function public.get_item_listing(uuid) from public, anon, authenticated;
grant execute on function public.get_item_listing(uuid) to authenticated;

create function public.create_listing_enquiry(p_listing_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  created public.listing_enquiries%rowtype;
begin
  membership := public.listing_caller_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.author_id = auth.uid() then
    raise exception 'authors cannot enquire on their own listing' using errcode = '22023';
  end if;
  if not public.listing_text_is_allowed(p_body) then
    raise exception 'listing enquiry must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  insert into public.listing_enquiries (
    school_id, listing_id, enquirer_id, enquirer_membership, body
  ) values (
    membership.school_id, listing.id, auth.uid(), membership.id, trim(p_body)
  ) returning * into created;

  return public.listing_enquiry_json(created);
end;
$$;
revoke all on function public.create_listing_enquiry(uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_listing_enquiry(uuid, text) to authenticated;

create function public.list_listing_enquiries(p_listing_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  result jsonb;
begin
  membership := public.listing_caller_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.author_id is distinct from auth.uid() then
    -- Non-authors may only see their own enquiries on that listing.
    select coalesce(pg_catalog.jsonb_agg(public.listing_enquiry_json(enquiry) order by enquiry.created_at), '[]'::jsonb)
    into result
    from public.listing_enquiries enquiry
    where enquiry.listing_id = listing.id
      and enquiry.school_id = membership.school_id
      and enquiry.enquirer_id = auth.uid();
    return result;
  end if;

  select coalesce(pg_catalog.jsonb_agg(public.listing_enquiry_json(enquiry) order by enquiry.created_at), '[]'::jsonb)
  into result
  from public.listing_enquiries enquiry
  where enquiry.listing_id = listing.id
    and enquiry.school_id = membership.school_id;
  return result;
end;
$$;
revoke all on function public.list_listing_enquiries(uuid)
  from public, anon, authenticated;
grant execute on function public.list_listing_enquiries(uuid) to authenticated;

create function public.list_restricted_listing_items()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  result jsonb;
begin
  membership := public.listing_caller_membership();
  -- membership proves verified school parent; catalogue is global, not school-scoped.
  if membership.id is null then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'slug', item.slug,
      'label', item.label,
      'is_active', item.is_active
    )
    order by item.label
  ), '[]'::jsonb)
  into result
  from public.listing_restricted_items item
  where item.is_active;
  return result;
end;
$$;
revoke all on function public.list_restricted_listing_items()
  from public, anon, authenticated;
grant execute on function public.list_restricted_listing_items() to authenticated;

commit;
