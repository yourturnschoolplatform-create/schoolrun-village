-- Task 7.3: 90-day disclosure / access-log / departure-check retention purge.
-- Does not touch ledger, trust history, child profiles, or handover confirmations.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Departure check logs (retention target; no live location)
-- ---------------------------------------------------------------------------
create table public.departure_check_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  swap_id uuid not null references public.swap_proposals(id) on delete restrict,
  swap_leg_id uuid not null,
  membership uuid not null,
  outcome text not null check (outcome in ('confirmed', 'timeout', 'backup_accepted')),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (swap_leg_id, school_id) references public.swap_legs(id, school_id) on delete restrict,
  foreign key (membership, school_id) references public.school_memberships(id, school_id) on delete restrict
);
create index departure_check_logs_swap_idx
  on public.departure_check_logs (swap_id, created_at);
create index departure_check_logs_school_idx
  on public.departure_check_logs (school_id, created_at desc);

comment on table public.departure_check_logs is
  'Departure check outcomes only. No live location, phone, nickname, amount, price or currency. Purged 90 days after swap end.';

create table public.retention_purge_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  started_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz,
  retention_days integer not null check (retention_days = 90),
  swaps_considered integer not null default 0 check (swaps_considered >= 0),
  contact_disclosures_purged integer not null default 0 check (contact_disclosures_purged >= 0),
  notice_logs_purged integer not null default 0 check (notice_logs_purged >= 0),
  departure_checks_purged integer not null default 0 check (departure_checks_purged >= 0),
  email_relay_rows_purged integer not null default 0 check (email_relay_rows_purged >= 0),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object')
);

comment on table public.retention_purge_runs is
  'Append-oriented retention purge run counters. No personal payloads.';

create function public.guard_departure_check_logs()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if current_setting('yourturn.retention_purge', true) = '1' and tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'departure check logs are append-only except retention purge'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_departure_check_logs() from public, anon, authenticated;
create trigger departure_check_logs_guard_rows
  before insert or update or delete on public.departure_check_logs
  for each row execute function public.guard_departure_check_logs();
create trigger departure_check_logs_guard_truncate
  before truncate on public.departure_check_logs
  for each statement execute function public.guard_departure_check_logs();
alter table public.departure_check_logs enable always trigger departure_check_logs_guard_rows;
alter table public.departure_check_logs enable always trigger departure_check_logs_guard_truncate;

create function public.guard_retention_purge_runs()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'retention purge runs cannot be deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.started_at, new.retention_days) is distinct from
       (old.id, old.started_at, old.retention_days)
      or old.finished_at is not null then
      raise exception 'retention purge runs are immutable after finish' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_retention_purge_runs() from public, anon, authenticated;
create trigger retention_purge_runs_guard_rows
  before update or delete on public.retention_purge_runs
  for each row execute function public.guard_retention_purge_runs();
create trigger retention_purge_runs_guard_truncate
  before truncate on public.retention_purge_runs
  for each statement execute function public.guard_retention_purge_runs();

alter table public.departure_check_logs enable row level security;
alter table public.retention_purge_runs enable row level security;

create policy departure_check_logs_select on public.departure_check_logs
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or exists (
      select 1 from public.school_memberships membership
      where membership.id = departure_check_logs.membership
        and membership.school_id = departure_check_logs.school_id
        and membership.user_id = auth.uid()
    )
    or exists (
      select 1 from public.swap_proposals swap
      where swap.id = departure_check_logs.swap_id
        and auth.uid() in (swap.proposer_id, swap.recipient_id)
        and public.is_member(swap.school_id)
    )
  );

create policy retention_purge_runs_select on public.retention_purge_runs
  for select to authenticated using (public.is_admin());

revoke all on table public.departure_check_logs from public, anon, authenticated;
revoke all on table public.retention_purge_runs from public, anon, authenticated;
grant select on table public.departure_check_logs to authenticated;
grant select on table public.retention_purge_runs to authenticated;

-- ---------------------------------------------------------------------------
-- Allow retention purge deletes through existing history guards
-- ---------------------------------------------------------------------------
create or replace function public.guard_contact_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if current_setting('yourturn.retention_purge', true) = '1' and tg_op = 'DELETE' then
    return old;
  end if;
  if tg_table_name = 'contact_consents' and tg_op = 'UPDATE' then
    if (new.id, new.school_id, new.swap_id, new.member, new.consent_version,
        new.policy_version, new.scope, new.granted_at)
      is not distinct from
       (old.id, old.school_id, old.swap_id, old.member, old.consent_version,
        old.policy_version, old.scope, old.granted_at)
      and old.revoked_at is null and old.superseded_at is null
      and ((new.revoked_at is not null and new.superseded_at is null)
        or (new.superseded_at is not null and new.revoked_at is null))
    then
      return new;
    end if;
  end if;
  raise exception 'contact history is immutable except one-way revocation or supersession'
    using errcode = '55000';
end;
$$;
revoke all on function public.guard_contact_history() from public, anon, authenticated;

create or replace function public.guard_school_notice_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if current_setting('yourturn.retention_purge', true) = '1' and tg_op = 'DELETE' then
    return old;
  end if;

  if tg_table_name = 'school_notice_access_logs' then
    if tg_op <> 'INSERT' then
      raise exception 'school notice access logs are append-only' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'school notices cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if (new.id, new.school_id, new.swap_id, new.swap_leg_id, new.generated_by,
        new.service_date, new.year_levels, new.collector_display_name, new.notice_body,
        new.created_at)
      is distinct from
       (old.id, old.school_id, old.swap_id, old.swap_leg_id, old.generated_by,
        old.service_date, old.year_levels, old.collector_display_name, old.notice_body,
        old.created_at)
    then
      raise exception 'school notice identity fields are immutable' using errcode = '55000';
    end if;
    if old.status = 'withdrawn' then
      raise exception 'withdrawn school notices are immutable' using errcode = '55000';
    end if;
    if not (old.status = 'active' and new.status = 'withdrawn'
      and new.withdrawn_at is not null and new.withdrawn_by is not null) then
      raise exception 'school notices may only transition active to withdrawn' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_school_notice_history() from public, anon, authenticated;

create or replace function public.guard_email_relay_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if current_setting('yourturn.retention_purge', true) = '1' and tg_op = 'DELETE' then
    return old;
  end if;

  if tg_table_name = 'email_relay_delivery_events' then
    if tg_op <> 'INSERT' then
      raise exception 'email relay delivery events are append-only' using errcode = '55000';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'email relay queue rows cannot be deleted' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if (new.id, new.school_id, new.swap_id, new.recipient_user_id, new.recipient_membership,
        new.kind, new.template_key, new.created_by, new.created_at)
      is distinct from
       (old.id, old.school_id, old.swap_id, old.recipient_user_id, old.recipient_membership,
        old.kind, old.template_key, old.created_by, old.created_at)
    then
      raise exception 'email relay queue identity fields are immutable' using errcode = '55000';
    end if;
    if old.status = 'sent' or old.status = 'cancelled' then
      raise exception 'terminal email relay queue rows are immutable' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_email_relay_history() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers and purge RPC
-- ---------------------------------------------------------------------------
create function public.swap_retention_ended_at(p_swap public.swap_proposals)
returns timestamptz
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select case
    when p_swap.status = 'cancelled_consent_revoked' then p_swap.cancelled_at
    when p_swap.status in ('declined', 'withdrawn', 'expired') then p_swap.updated_at
    else null
  end;
$$;
revoke all on function public.swap_retention_ended_at(public.swap_proposals)
  from public, anon, authenticated;

create function public.purge_expired_disclosure_retention()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  run_id uuid;
  ended_swaps uuid[];
  contact_count integer := 0;
  notice_count integer := 0;
  departure_count integer := 0;
  relay_count integer := 0;
  mobiles_deleted integer := 0;
  backups_deleted integer := 0;
  consents_deleted integer := 0;
  notifications_deleted integer := 0;
  access_logs_deleted integer := 0;
  notices_deleted integer := 0;
  relay_events_deleted integer := 0;
  relay_queue_deleted integer := 0;
begin
  if auth.role() is distinct from 'service_role' and current_user is distinct from 'service_role' then
    if current_setting('request.jwt.claim.role', true) in ('authenticated', 'anon')
      or current_user in ('authenticated', 'anon') then
      raise exception 'service role required for retention purge' using errcode = '42501';
    end if;
  end if;

  insert into public.retention_purge_runs (retention_days)
  values (90)
  returning id into run_id;

  select coalesce(pg_catalog.array_agg(swap.id), array[]::uuid[])
    into ended_swaps
  from public.swap_proposals swap
  where public.swap_retention_ended_at(swap) is not null
    and public.swap_retention_ended_at(swap) <= pg_catalog.now() - interval '90 days';

  -- swap count captured after purge deletes for the run summary
  perform set_config('yourturn.retention_purge', '1', true);

  -- Contact disclosures (private mobiles first).
  delete from yourturn_private.mobile_numbers mobile
  using public.contact_consents consent
  where mobile.consent_id = consent.id
    and consent.swap_id = any (ended_swaps);
  get diagnostics mobiles_deleted = row_count;

  delete from public.contact_consent_backups backup
  using public.contact_consents consent
  where backup.consent_id = consent.id
    and consent.swap_id = any (ended_swaps);
  get diagnostics backups_deleted = row_count;

  delete from public.contact_consents consent
  where consent.swap_id = any (ended_swaps);
  get diagnostics consents_deleted = row_count;

  delete from public.swap_contact_notifications notification
  where notification.swap_id = any (ended_swaps);
  get diagnostics notifications_deleted = row_count;

  contact_count := mobiles_deleted + backups_deleted + consents_deleted + notifications_deleted;

  -- Notice access logs then notices.
  delete from public.school_notice_access_logs access_log
  using public.school_notices notice
  where access_log.notice_id = notice.id
    and notice.swap_id = any (ended_swaps);
  get diagnostics access_logs_deleted = row_count;

  delete from public.school_notices notice
  where notice.swap_id = any (ended_swaps);
  get diagnostics notices_deleted = row_count;

  notice_count := access_logs_deleted + notices_deleted;

  -- Departure checks.
  delete from public.departure_check_logs departure
  where departure.swap_id = any (ended_swaps);
  get diagnostics departure_count = row_count;

  -- Email relay events then queue rows for ended swaps.
  delete from public.email_relay_delivery_events delivery
  using public.email_relay_queue queue
  where delivery.queue_id = queue.id
    and queue.swap_id = any (ended_swaps);
  get diagnostics relay_events_deleted = row_count;

  delete from public.email_relay_queue queue
  where queue.swap_id = any (ended_swaps);
  get diagnostics relay_queue_deleted = row_count;

  relay_count := relay_events_deleted + relay_queue_deleted;

  perform set_config('yourturn.retention_purge', '0', true);

  update public.retention_purge_runs
  set finished_at = pg_catalog.now(),
      swaps_considered = coalesce(pg_catalog.cardinality(ended_swaps), 0),
      contact_disclosures_purged = contact_count,
      notice_logs_purged = notice_count,
      departure_checks_purged = departure_count,
      email_relay_rows_purged = relay_count,
      detail = pg_catalog.jsonb_build_object(
        'mobiles', mobiles_deleted,
        'backups', backups_deleted,
        'consents', consents_deleted,
        'notifications', notifications_deleted,
        'notice_access_logs', access_logs_deleted,
        'notices', notices_deleted,
        'relay_events', relay_events_deleted,
        'relay_queue', relay_queue_deleted
      )
  where id = run_id;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'retention.purge_completed', 'retention_purge_run', run_id,
    pg_catalog.jsonb_build_object('outcome', 'completed', 'reason_code', 'retention_90d')
  );

  return pg_catalog.jsonb_build_object(
    'run_id', run_id,
    'retention_days', 90,
    'swaps_considered', coalesce(pg_catalog.cardinality(ended_swaps), 0),
    'contact_disclosures_purged', contact_count,
    'notice_logs_purged', notice_count,
    'departure_checks_purged', departure_count,
    'email_relay_rows_purged', relay_count
  );
end;
$$;
revoke all on function public.purge_expired_disclosure_retention()
  from public, anon, authenticated;
grant execute on function public.purge_expired_disclosure_retention() to service_role;

create function public.get_retention_purge_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'retention_days', 90,
    'targets', pg_catalog.jsonb_build_array(
      'contact_disclosures',
      'school_notice_access_logs',
      'school_notices',
      'departure_check_logs',
      'email_relay_queue'
    ),
    'preserved', pg_catalog.jsonb_build_array(
      'swap_ledger_entries',
      'trust_score_events',
      'child_profiles',
      'swap_leg_confirmations',
      'swap_cancellation_events'
    )
  );
$$;
revoke all on function public.get_retention_purge_policy()
  from public, anon, authenticated;
grant execute on function public.get_retention_purge_policy() to authenticated;

commit;
