-- Task 10.1: in-app user notifications ledger with owner SELECT/UPDATE (read),
-- system-only INSERT via enqueue RPC, and blocked client DELETE/TRUNCATE.
-- No amount, price, currency, payment, phone, photo, nickname or live location.
begin;
set local search_path = pg_catalog;

create table public.notifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  school_id uuid not null references public.schools(id) on delete restrict,
  kind text not null
    check (kind in (
      'handover_reminder',
      'contact_consent_revoked',
      'listing_enquiry',
      'listing_status',
      'community_moderation',
      'swap_accepted',
      'system'
    )),
  title text not null
    check (char_length(trim(title)) between 1 and 120),
  body text not null
    check (char_length(trim(body)) between 1 and 1000),
  is_read boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  read_at timestamptz,
  check ((is_read = false and read_at is null) or (is_read = true and read_at is not null))
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where is_read = false;
create index notifications_school_created_idx
  on public.notifications (school_id, created_at desc);

comment on table public.notifications is
  'Owner in-app notification inbox. Phone-free text; system enqueue only; no money fields.';
comment on column public.notifications.metadata is
  'Safe string-only metadata keys: entity_type, entity_id, reason_code, outcome, source.';

create function public.notification_metadata_is_safe(p_metadata jsonb)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select p_metadata is not null
    and pg_catalog.jsonb_typeof(p_metadata) = 'object'
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_metadata) as entry(key, value)
      where entry.key not in ('entity_type', 'entity_id', 'reason_code', 'outcome', 'source')
        or pg_catalog.jsonb_typeof(entry.value) <> 'string'
        or char_length(entry.value #>> '{}') > 120
    );
$$;
revoke all on function public.notification_metadata_is_safe(jsonb)
  from public, anon, authenticated;

alter table public.notifications
  add constraint notifications_metadata_safe_check
  check (public.notification_metadata_is_safe(metadata));

create function public.guard_notifications()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'notifications cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'INSERT' then
    if current_setting('yourturn.notification_enqueue', true) is distinct from '1' then
      raise exception 'notifications are system-enqueued only' using errcode = '55000';
    end if;
    if not public.community_text_is_allowed(new.title)
      or not public.community_text_is_allowed(new.body) then
      raise exception 'notification text must not include phones, emails, photos or child full names'
        using errcode = '22023';
    end if;
    if not public.notification_metadata_is_safe(new.metadata) then
      raise exception 'notification metadata is invalid' using errcode = '22023';
    end if;
    if new.is_read or new.read_at is not null then
      raise exception 'new notifications must be unread' using errcode = '22023';
    end if;
    return new;
  end if;

  -- UPDATE: owner may mark read only (via RLS + this guard).
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.school_id is distinct from old.school_id
    or new.kind is distinct from old.kind
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.metadata is distinct from old.metadata
    or new.created_at is distinct from old.created_at then
    raise exception 'notification fields other than read state are immutable'
      using errcode = '55000';
  end if;
  if old.is_read = true then
    if new.is_read = true and new.read_at is not distinct from old.read_at then
      return new;
    end if;
    raise exception 'read notifications cannot be unmarked' using errcode = '22023';
  end if;
  if not (new.is_read = true and new.read_at is not null) then
    raise exception 'notification read transition is invalid' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_notifications() from public, anon, authenticated;

create trigger notifications_guard_rows
  before insert or update or delete on public.notifications
  for each row execute function public.guard_notifications();
create trigger notifications_guard_truncate
  before truncate on public.notifications
  for each statement execute function public.guard_notifications();
alter table public.notifications enable always trigger notifications_guard_rows;
alter table public.notifications enable always trigger notifications_guard_truncate;

alter table public.notifications enable row level security;

create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());

create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on table public.notifications from public, anon, authenticated;
grant select, update on table public.notifications to authenticated;

create function public.notification_json(p_row public.notifications)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'user_id', p_row.user_id,
    'school_id', p_row.school_id,
    'kind', p_row.kind,
    'title', p_row.title,
    'body', p_row.body,
    'is_read', p_row.is_read,
    'metadata', p_row.metadata,
    'created_at', p_row.created_at,
    'read_at', p_row.read_at
  );
$$;
revoke all on function public.notification_json(public.notifications)
  from public, anon, authenticated;

create function public.enqueue_user_notification(
  p_user_id uuid,
  p_school_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created public.notifications%rowtype;
begin
  if p_user_id is null or p_school_id is null then
    raise exception 'notification recipient and school are required' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in (
    'handover_reminder', 'contact_consent_revoked', 'listing_enquiry',
    'listing_status', 'community_moderation', 'swap_accepted', 'system'
  ) then
    raise exception 'notification kind is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles profile where profile.id = p_user_id
  ) then
    raise exception 'notification recipient unavailable' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.schools school where school.id = p_school_id
  ) then
    raise exception 'notification school unavailable' using errcode = 'P0002';
  end if;
  if not public.community_text_is_allowed(p_title)
    or not public.community_text_is_allowed(p_body) then
    raise exception 'notification text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if not public.notification_metadata_is_safe(coalesce(p_metadata, '{}'::jsonb)) then
    raise exception 'notification metadata is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('yourturn.notification_enqueue', '1', true);
  insert into public.notifications (
    user_id, school_id, kind, title, body, metadata
  ) values (
    p_user_id, p_school_id, p_kind, trim(p_title), trim(p_body),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into created;
  perform pg_catalog.set_config('yourturn.notification_enqueue', '0', true);

  return public.notification_json(created);
end;
$$;
revoke all on function public.enqueue_user_notification(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;

create function public.list_my_notifications(p_unread_only boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(public.notification_json(n) order by n.created_at desc), '[]'::jsonb)
  into result
  from public.notifications n
  where n.user_id = auth.uid()
    and (p_unread_only is distinct from true or n.is_read = false);

  return result;
end;
$$;
revoke all on function public.list_my_notifications(boolean)
  from public, anon, authenticated;
grant execute on function public.list_my_notifications(boolean) to authenticated;

create function public.mark_notification_read(p_notification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  updated public.notifications%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_notification_id is null then
    raise exception 'notification id is required' using errcode = '22023';
  end if;

  update public.notifications
  set is_read = true,
      read_at = coalesce(read_at, pg_catalog.now())
  where id = p_notification_id
    and user_id = auth.uid()
  returning * into updated;

  if updated.id is null then
    raise exception 'notification unavailable' using errcode = '42501';
  end if;
  return public.notification_json(updated);
end;
$$;
revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create function public.mark_all_notifications_read()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  marked integer := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  update public.notifications
  set is_read = true,
      read_at = pg_catalog.now()
  where user_id = auth.uid()
    and is_read = false;
  get diagnostics marked = row_count;

  return pg_catalog.jsonb_build_object(
    'outcome', 'marked_read',
    'marked_count', marked
  );
end;
$$;
revoke all on function public.mark_all_notifications_read()
  from public, anon, authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

commit;
