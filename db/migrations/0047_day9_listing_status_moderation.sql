-- Task 9.2: listing status (collected/fulfilled), author withdrawal, and
-- reporting/moderation with append-only audit. No amount, price, currency,
-- payment, phone, photo, nickname or live location fields.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Expand listing status
-- ---------------------------------------------------------------------------
alter table public.item_listings
  drop constraint if exists item_listings_status_check;
alter table public.item_listings
  add constraint item_listings_status_check
  check (status in ('active', 'collected', 'fulfilled', 'hidden', 'withdrawn'));

comment on column public.item_listings.status is
  'active searchable; collected/fulfilled terminal free fulfilment; hidden moderation; withdrawn author or moderator remove.';

-- ---------------------------------------------------------------------------
-- Reports and append-only moderation audit
-- ---------------------------------------------------------------------------
create table public.listing_reports (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  listing_id uuid not null,
  reporter_id uuid not null references public.profiles(id) on delete restrict,
  reporter_membership uuid not null,
  reason text not null
    check (char_length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  unique (reporter_id, listing_id),
  foreign key (listing_id, school_id)
    references public.item_listings(id, school_id) on delete restrict,
  foreign key (reporter_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index listing_reports_listing_idx
  on public.listing_reports (listing_id, created_at);
create index listing_reports_school_idx
  on public.listing_reports (school_id, created_at desc);

comment on table public.listing_reports is
  'Unique member reports on free listings. Reason text only; no money or contact fields.';

create table public.listing_moderation_actions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  listing_id uuid not null,
  action text not null
    check (action in (
      'report_received', 'auto_hide', 'hide', 'restore', 'remove',
      'collected', 'fulfilled', 'withdrawn'
    )),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  actor_membership uuid,
  report_count integer
    check (report_count is null or report_count >= 0),
  note text
    check (note is null or char_length(trim(note)) between 1 and 500),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (listing_id, school_id)
    references public.item_listings(id, school_id) on delete restrict,
  foreign key (actor_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index listing_moderation_actions_listing_idx
  on public.listing_moderation_actions (listing_id, created_at);
create index listing_moderation_actions_school_idx
  on public.listing_moderation_actions (school_id, created_at desc);

comment on table public.listing_moderation_actions is
  'Append-only listing status and moderation audit. No phone email nickname amount price or currency.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.guard_item_listings()
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
    if current_setting('yourturn.listing_status', true) = '1'
      or current_setting('yourturn.listing_moderation', true) = '1' then
      if new.id is distinct from old.id
        or new.school_id is distinct from old.school_id
        or new.author_id is distinct from old.author_id
        or new.author_membership is distinct from old.author_membership
        or new.created_at is distinct from old.created_at
        or new.listing_kind is distinct from old.listing_kind
        or new.title is distinct from old.title
        or new.description is distinct from old.description
        or new.category is distinct from old.category
        or new.display_offer_label is distinct from old.display_offer_label then
        raise exception 'listing status changes may only update status'
          using errcode = '55000';
      end if;
      if current_setting('yourturn.listing_status', true) = '1' then
        if not (
          old.status = 'active'
          and new.status in ('collected', 'fulfilled', 'withdrawn')
        ) then
          raise exception 'listing author status transition is not allowed'
            using errcode = '22023';
        end if;
        return new;
      end if;
      -- moderation gate
      if not (
        (old.status = 'active' and new.status in ('hidden', 'withdrawn'))
        or (old.status = 'hidden' and new.status in ('active', 'withdrawn'))
      ) then
        raise exception 'listing moderation status transition is not allowed'
          using errcode = '22023';
      end if;
      return new;
    end if;
    raise exception 'item listings are immutable without status or moderation gate'
      using errcode = '55000';
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

create function public.guard_listing_moderation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'listing moderation history is append-only' using errcode = '55000';
  end if;
  if tg_table_name = 'listing_reports' then
    if not public.listing_text_is_allowed(new.reason) then
      raise exception 'listing report must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  elsif tg_table_name = 'listing_moderation_actions' then
    if new.note is not null
      and not public.listing_text_is_allowed(new.note) then
      raise exception 'listing moderation note must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_listing_moderation() from public, anon, authenticated;

create trigger listing_reports_guard_rows
  before insert or update or delete on public.listing_reports
  for each row execute function public.guard_listing_moderation();
create trigger listing_reports_guard_truncate
  before truncate on public.listing_reports
  for each statement execute function public.guard_listing_moderation();
alter table public.listing_reports enable always trigger listing_reports_guard_rows;
alter table public.listing_reports enable always trigger listing_reports_guard_truncate;

create trigger listing_moderation_actions_guard_rows
  before insert or update or delete on public.listing_moderation_actions
  for each row execute function public.guard_listing_moderation();
create trigger listing_moderation_actions_guard_truncate
  before truncate on public.listing_moderation_actions
  for each statement execute function public.guard_listing_moderation();
alter table public.listing_moderation_actions
  enable always trigger listing_moderation_actions_guard_rows;
alter table public.listing_moderation_actions
  enable always trigger listing_moderation_actions_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.listing_reports enable row level security;
alter table public.listing_moderation_actions enable row level security;

drop policy if exists item_listings_select on public.item_listings;
create policy item_listings_select on public.item_listings
  for select to authenticated using (
    public.is_admin()
    or (status = 'active' and public.is_member(school_id))
    or (author_id = auth.uid() and public.is_member(school_id))
    or public.is_moderator(school_id)
  );

create policy listing_reports_select on public.listing_reports
  for select to authenticated using (
    public.is_admin()
    or reporter_id = auth.uid()
    or public.is_moderator(school_id)
  );

create policy listing_moderation_actions_select on public.listing_moderation_actions
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or (
      public.is_member(school_id)
      and exists (
        select 1 from public.item_listings listing
        where listing.id = listing_moderation_actions.listing_id
          and listing.school_id = listing_moderation_actions.school_id
          and listing.author_id = auth.uid()
      )
    )
  );

revoke all on table public.listing_reports from public, anon, authenticated;
revoke all on table public.listing_moderation_actions from public, anon, authenticated;
grant select on table public.listing_reports to authenticated;
grant select on table public.listing_moderation_actions to authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function public.listing_apply_status(
  p_listing_id uuid,
  p_new_status text,
  p_gate text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  updated integer := 0;
begin
  if p_gate is distinct from 'status' and p_gate is distinct from 'moderation' then
    raise exception 'listing status gate is invalid' using errcode = '22023';
  end if;
  if p_gate = 'status' then
    perform pg_catalog.set_config('yourturn.listing_status', '1', true);
  else
    perform pg_catalog.set_config('yourturn.listing_moderation', '1', true);
  end if;
  update public.item_listings
    set status = p_new_status
    where id = p_listing_id;
  get diagnostics updated = row_count;
  perform pg_catalog.set_config('yourturn.listing_status', '0', true);
  perform pg_catalog.set_config('yourturn.listing_moderation', '0', true);
  if updated <> 1 then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  return p_new_status;
end;
$$;
revoke all on function public.listing_apply_status(uuid, text, text)
  from public, anon, authenticated;

create function public.listing_require_moderator_membership()
returns public.school_memberships
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
begin
  membership := public.listing_caller_membership();
  if not (public.is_moderator(membership.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  return membership;
end;
$$;
revoke all on function public.listing_require_moderator_membership()
  from public, anon, authenticated;

create function public.listing_moderation_queue_item_json(
  p_listing public.item_listings,
  p_report_count integer
)
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
    'report_count', p_report_count,
    'created_at', p_listing.created_at
  );
$$;
revoke all on function public.listing_moderation_queue_item_json(public.item_listings, integer)
  from public, anon, authenticated;

create function public.listing_author_transition(
  p_listing_id uuid,
  p_new_status text,
  p_action text
)
returns jsonb
language plpgsql
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
    or listing.author_id is distinct from auth.uid()
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if p_new_status not in ('collected', 'fulfilled', 'withdrawn')
    or p_action not in ('collected', 'fulfilled', 'withdrawn') then
    raise exception 'listing author transition is invalid' using errcode = '22023';
  end if;

  perform public.listing_apply_status(listing.id, p_new_status, 'status');
  select * into listing from public.item_listings where id = p_listing_id;

  insert into public.listing_moderation_actions (
    school_id, listing_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, listing.id, p_action, auth.uid(), membership.id, null, null
  );

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.' || p_action, 'item_listing',
    listing.id,
    pg_catalog.jsonb_build_object(
      'outcome', p_action,
      'reason_code', 'listing_author_status'
    )
  );

  return public.item_listing_json(listing);
end;
$$;
revoke all on function public.listing_author_transition(uuid, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs — author status
-- ---------------------------------------------------------------------------
create function public.mark_item_listing_collected(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  return public.listing_author_transition(p_listing_id, 'collected', 'collected');
end;
$$;
revoke all on function public.mark_item_listing_collected(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_item_listing_collected(uuid) to authenticated;

create function public.mark_item_listing_fulfilled(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  return public.listing_author_transition(p_listing_id, 'fulfilled', 'fulfilled');
end;
$$;
revoke all on function public.mark_item_listing_fulfilled(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_item_listing_fulfilled(uuid) to authenticated;

create function public.withdraw_item_listing(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  return public.listing_author_transition(p_listing_id, 'withdrawn', 'withdrawn');
end;
$$;
revoke all on function public.withdraw_item_listing(uuid)
  from public, anon, authenticated;
grant execute on function public.withdraw_item_listing(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs — reporting and moderation
-- ---------------------------------------------------------------------------
create function public.report_item_listing(p_listing_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  report_count integer;
  outcome text := 'reported';
  existing_id uuid;
begin
  membership := public.listing_caller_membership();
  if not public.listing_text_is_allowed(p_reason) then
    raise exception 'listing report must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;

  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or listing.status is distinct from 'active'
    or not public.is_member(listing.school_id) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.author_id is not distinct from auth.uid() then
    raise exception 'authors cannot report their own listing' using errcode = '42501';
  end if;

  select report.id into existing_id
  from public.listing_reports report
  where report.reporter_id = auth.uid()
    and report.listing_id = listing.id;
  if existing_id is not null then
    select count(*)::integer into report_count
    from public.listing_reports report
    where report.listing_id = listing.id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'already_reported',
      'listing_id', listing.id,
      'status', listing.status,
      'report_count', report_count
    );
  end if;

  insert into public.listing_reports (
    school_id, listing_id, reporter_id, reporter_membership, reason
  ) values (
    membership.school_id, listing.id, auth.uid(), membership.id, trim(p_reason)
  );

  select count(*)::integer into report_count
  from public.listing_reports report
  where report.listing_id = listing.id;

  insert into public.listing_moderation_actions (
    school_id, listing_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, listing.id, 'report_received',
    auth.uid(), membership.id, report_count, null
  );

  if report_count >= 3 then
    perform public.listing_apply_status(listing.id, 'hidden', 'moderation');
    insert into public.listing_moderation_actions (
      school_id, listing_id, action, actor_id, actor_membership, report_count, note
    ) values (
      membership.school_id, listing.id, 'auto_hide',
      auth.uid(), membership.id, report_count, 'auto-hidden after three unique reports'
    );
    insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
    values (
      auth.uid(), membership.school_id, 'listing.auto_hidden', 'item_listing',
      listing.id,
      pg_catalog.jsonb_build_object(
        'outcome', 'auto_hidden',
        'reason_code', 'three_unique_reports'
      )
    );
    outcome := 'auto_hidden';
    select * into listing from public.item_listings where id = p_listing_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', outcome,
    'listing_id', listing.id,
    'status', listing.status,
    'report_count', report_count
  );
end;
$$;
revoke all on function public.report_item_listing(uuid, text)
  from public, anon, authenticated;
grant execute on function public.report_item_listing(uuid, text) to authenticated;

create function public.hide_item_listing(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  report_count integer;
begin
  membership := public.listing_require_moderator_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or not (public.is_moderator(listing.school_id) or public.is_admin()) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.status is distinct from 'active' then
    if listing.status = 'hidden' then
      select count(*)::integer into report_count
      from public.listing_reports report where report.listing_id = listing.id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'already_hidden',
        'listing_id', listing.id,
        'status', 'hidden',
        'report_count', report_count
      );
    end if;
    raise exception 'listing unavailable' using errcode = '42501';
  end if;

  perform public.listing_apply_status(listing.id, 'hidden', 'moderation');
  select count(*)::integer into report_count
  from public.listing_reports report where report.listing_id = listing.id;
  insert into public.listing_moderation_actions (
    school_id, listing_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, listing.id, 'hide',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.hidden', 'item_listing',
    listing.id,
    pg_catalog.jsonb_build_object('outcome', 'hidden', 'reason_code', 'moderator_hide')
  );
  select * into listing from public.item_listings where id = p_listing_id;
  return pg_catalog.jsonb_build_object(
    'outcome', 'hidden',
    'listing_id', listing.id,
    'status', listing.status,
    'report_count', report_count
  );
end;
$$;
revoke all on function public.hide_item_listing(uuid) from public, anon, authenticated;
grant execute on function public.hide_item_listing(uuid) to authenticated;

create function public.restore_item_listing(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  report_count integer;
begin
  membership := public.listing_require_moderator_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or listing.status is distinct from 'hidden'
    or not (public.is_moderator(listing.school_id) or public.is_admin()) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;

  perform public.listing_apply_status(listing.id, 'active', 'moderation');
  select count(*)::integer into report_count
  from public.listing_reports report where report.listing_id = listing.id;
  insert into public.listing_moderation_actions (
    school_id, listing_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, listing.id, 'restore',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.restored', 'item_listing',
    listing.id,
    pg_catalog.jsonb_build_object('outcome', 'restored', 'reason_code', 'moderator_restore')
  );
  select * into listing from public.item_listings where id = p_listing_id;
  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'listing_id', listing.id,
    'status', listing.status,
    'report_count', report_count
  );
end;
$$;
revoke all on function public.restore_item_listing(uuid) from public, anon, authenticated;
grant execute on function public.restore_item_listing(uuid) to authenticated;

create function public.remove_item_listing(p_listing_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  membership public.school_memberships%rowtype;
  listing public.item_listings%rowtype;
  report_count integer;
begin
  membership := public.listing_require_moderator_membership();
  select * into listing from public.item_listings where id = p_listing_id;
  if listing.id is null
    or listing.school_id is distinct from membership.school_id
    or not (public.is_moderator(listing.school_id) or public.is_admin()) then
    raise exception 'listing unavailable' using errcode = '42501';
  end if;
  if listing.status not in ('active', 'hidden') then
    if listing.status = 'withdrawn' then
      select count(*)::integer into report_count
      from public.listing_reports report where report.listing_id = listing.id;
      return pg_catalog.jsonb_build_object(
        'outcome', 'already_removed',
        'listing_id', listing.id,
        'status', 'withdrawn',
        'report_count', report_count
      );
    end if;
    raise exception 'listing unavailable' using errcode = '42501';
  end if;

  perform public.listing_apply_status(listing.id, 'withdrawn', 'moderation');
  select count(*)::integer into report_count
  from public.listing_reports report where report.listing_id = listing.id;
  insert into public.listing_moderation_actions (
    school_id, listing_id, action, actor_id, actor_membership, report_count, note
  ) values (
    membership.school_id, listing.id, 'remove',
    auth.uid(), membership.id, report_count, null
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), membership.school_id, 'listing.removed', 'item_listing',
    listing.id,
    pg_catalog.jsonb_build_object('outcome', 'removed', 'reason_code', 'moderator_remove')
  );
  select * into listing from public.item_listings where id = p_listing_id;
  return pg_catalog.jsonb_build_object(
    'outcome', 'removed',
    'listing_id', listing.id,
    'status', listing.status,
    'report_count', report_count
  );
end;
$$;
revoke all on function public.remove_item_listing(uuid) from public, anon, authenticated;
grant execute on function public.remove_item_listing(uuid) to authenticated;

create function public.list_listing_moderation_queue()
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
  membership := public.listing_require_moderator_membership();
  select coalesce(pg_catalog.jsonb_agg(
    public.listing_moderation_queue_item_json(
      listing,
      (
        select count(*)::integer from public.listing_reports report
        where report.listing_id = listing.id
      )
    )
    order by listing.created_at desc
  ), '[]'::jsonb)
  into result
  from public.item_listings listing
  where listing.school_id = membership.school_id
    and listing.status = 'hidden'
    and (public.is_moderator(listing.school_id) or public.is_admin());
  return result;
end;
$$;
revoke all on function public.list_listing_moderation_queue()
  from public, anon, authenticated;
grant execute on function public.list_listing_moderation_queue() to authenticated;

commit;
