-- Task 5.1 only. No public completion command: a future trusted handover writes
-- completed_at after both confirmations. Ledger obligations are never money.
begin;

alter table public.swap_legs add column completed_at timestamptz;
create unique index school_memberships_id_school_ledger_idx
  on public.school_memberships (id, school_id);
create unique index swap_legs_id_school_ledger_idx
  on public.swap_legs (id, school_id);

create table public.swap_ledger_entries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  from_membership uuid not null,
  to_membership uuid not null,
  swap_leg_id uuid not null unique,
  trip_count_delta integer not null check (trip_count_delta = 1),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  reminder_due_at timestamptz not null,
  foreign key (from_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict,
  foreign key (to_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict,
  foreign key (swap_leg_id, school_id)
    references public.swap_legs(id, school_id) on delete restrict,
  check (from_membership <> to_membership),
  -- Hours, not calendar-day timestamptz arithmetic: elapsed weeks across DST.
  check (expires_at = created_at + interval '1344 hours'),
  check (reminder_due_at = created_at + interval '1008 hours')
);
create index swap_ledger_from_pair_idx on public.swap_ledger_entries
  (school_id, from_membership, to_membership, expires_at);
create index swap_ledger_to_pair_idx on public.swap_ledger_entries
  (school_id, to_membership, from_membership, expires_at);
create index swap_ledger_reminder_idx on public.swap_ledger_entries (reminder_due_at);

comment on column public.swap_ledger_entries.from_membership is
  'Recipient membership that owes the provider one school trip; non-transferable.';
comment on column public.swap_ledger_entries.expires_at is
  'Expiry deadline; is_expired is computed at read time without mutating history.';
comment on column public.swap_ledger_entries.reminder_due_at is
  'Week-six deadline only. No notification delivery is implemented by this migration.';

-- Validate even privileged inserts against the immutable source pair. Mutation
-- always raises, including DELETE cascades and TRUNCATE. No correction/transfer
-- command exists; privileged DDL owners remain able to change database objects.
create function public.guard_swap_ledger_entry()
returns trigger language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  source public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  debtor public.school_memberships%rowtype;
  provider public.school_memberships%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'trip ledger history is append-only' using errcode = '55000';
  end if;
  select * into source from public.swap_legs where id = new.swap_leg_id;
  select * into proposal from public.swap_proposals where id = source.swap_id;
  select * into debtor from public.school_memberships where id = new.from_membership;
  select * into provider from public.school_memberships where id = new.to_membership;
  if source.id is null or source.completed_at is null
    or proposal.status is distinct from 'accepted'
    or new.school_id is distinct from source.school_id
    or proposal.school_id is distinct from source.school_id
    or debtor.school_id is distinct from source.school_id
    or provider.school_id is distinct from source.school_id
    or debtor.user_id is distinct from source.requester_id
    or provider.user_id is distinct from source.helper_id
    or new.from_membership = new.to_membership
    or new.trip_count_delta is distinct from 1
    or new.created_at is distinct from source.completed_at
    or new.expires_at is distinct from source.completed_at + interval '1344 hours'
    or new.reminder_due_at is distinct from source.completed_at + interval '1008 hours'
  then
    raise exception 'ledger entry must match its completed same-school trip pair'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_swap_ledger_entry() from public, anon, authenticated;

create trigger swap_ledger_guard_rows
before insert or update or delete on public.swap_ledger_entries
for each row execute function public.guard_swap_ledger_entry();
create trigger swap_ledger_guard_truncate
before truncate on public.swap_ledger_entries
for each statement execute function public.guard_swap_ledger_entry();
alter table public.swap_ledger_entries enable always trigger swap_ledger_guard_rows;
alter table public.swap_ledger_entries enable always trigger swap_ledger_guard_truncate;

create function public.record_completed_swap_leg()
returns trigger language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  proposal public.swap_proposals%rowtype;
  debtor uuid;
  provider uuid;
begin
  if tg_op = 'UPDATE' and old.completed_at is not null then
    if (new.id, new.school_id, new.swap_id, new.helper_id, new.requester_id,
        new.helper_instance_id, new.requester_instance_id, new.service_date, new.completed_at)
      is distinct from
       (old.id, old.school_id, old.swap_id, old.helper_id, old.requester_id,
        old.helper_instance_id, old.requester_instance_id, old.service_date, old.completed_at)
    then
      raise exception 'completed trip identity and completion are immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if new.completed_at is null then return new; end if;

  select * into proposal from public.swap_proposals where id = new.swap_id;
  if proposal.id is null or proposal.status <> 'accepted'
    or proposal.school_id <> new.school_id
    or not (new.helper_id in (proposal.proposer_id, proposal.recipient_id)
      and new.requester_id in (proposal.proposer_id, proposal.recipient_id))
    or new.completed_at < proposal.accepted_at
    or new.completed_at > pg_catalog.statement_timestamp()
    or not exists (
      select 1 from public.availability_instances h
      join public.availability_instances r on r.id = new.requester_instance_id
      where h.id = new.helper_instance_id and h.owner_id = new.helper_id
        and r.owner_id = new.requester_id and h.school_id = new.school_id
        and r.school_id = new.school_id and h.intent = 'can_help' and r.intent = 'need_help'
        and h.direction = r.direction and h.service_date = new.service_date
        and r.service_date = new.service_date
    )
  then
    raise exception 'only an accepted same-school trip can complete'
      using errcode = '23514';
  end if;
  select id into debtor from public.school_memberships
    where school_id = new.school_id and user_id = new.requester_id and status = 'verified';
  select id into provider from public.school_memberships
    where school_id = new.school_id and user_id = new.helper_id and status = 'verified';
  if debtor is null or provider is null or debtor = provider then
    raise exception 'completed trip requires two verified same-school memberships'
      using errcode = '23514';
  end if;
  insert into public.swap_ledger_entries
    (school_id, from_membership, to_membership, swap_leg_id, trip_count_delta,
     created_at, expires_at, reminder_due_at)
  values (new.school_id, debtor, provider, new.id, 1, new.completed_at,
    new.completed_at + interval '1344 hours', new.completed_at + interval '1008 hours')
  on conflict (swap_leg_id) do nothing;
  insert into public.audit_logs
    (actor_id, school_id, action, entity_type, entity_id, payload)
  values (auth.uid(), new.school_id, 'ledger.trip_recorded', 'swap_leg', new.id, '{}'::jsonb);
  return new;
end;
$$;
revoke all on function public.record_completed_swap_leg() from public, anon, authenticated;
create trigger swap_leg_completed_to_ledger
  after insert or update on public.swap_legs
  for each row execute function public.record_completed_swap_leg();
alter table public.swap_legs enable always trigger swap_leg_completed_to_ledger;

alter table public.swap_ledger_entries enable row level security;
create policy swap_ledger_select_own_pair on public.swap_ledger_entries
for select to authenticated using (
  public.is_member(school_id)
  and exists (
    select 1 from public.school_memberships membership
    where membership.user_id = auth.uid() and membership.status = 'verified'
      and membership.school_id = swap_ledger_entries.school_id
      and membership.id in (swap_ledger_entries.from_membership, swap_ledger_entries.to_membership)
  )
);
revoke all on table public.swap_ledger_entries from public, anon, authenticated;
grant select on table public.swap_ledger_entries to authenticated;
-- No client role may complete a leg. A future trusted, audited two-party
-- handover command is the sole application integration point for completed_at.
revoke insert, update, delete, truncate on table public.swap_legs from public, anon, authenticated;

create function public.get_my_ledger()
returns jsonb language sql stable security definer
set search_path = pg_catalog
as $$
  with caller as (
    select membership.id, membership.school_id
    from public.school_memberships membership
    where membership.user_id = auth.uid() and membership.status = 'verified'
      and public.is_member(membership.school_id)
    order by membership.created_at, membership.id limit 1
  ), own_entries as (
    select entry.*,
      case when entry.from_membership = caller.id
        then entry.to_membership else entry.from_membership end as partner_membership,
      entry.expires_at <= pg_catalog.statement_timestamp() as is_expired,
      case when entry.from_membership = caller.id
        then entry.trip_count_delta else -entry.trip_count_delta end as directed_count
    from public.swap_ledger_entries entry
    join caller on caller.school_id = entry.school_id
      and caller.id in (entry.from_membership, entry.to_membership)
  ), netted as (
    select partner_membership, pg_catalog.sum(directed_count) as net_count
    from own_entries where not is_expired group by partner_membership
  )
  select pg_catalog.jsonb_build_object(
    'entries', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', entry.id, 'school_id', entry.school_id,
      'from_membership', entry.from_membership, 'to_membership', entry.to_membership,
      'swap_leg_id', entry.swap_leg_id, 'trip_count_delta', entry.trip_count_delta,
      'created_at', entry.created_at, 'expires_at', entry.expires_at,
      'reminder_due_at', entry.reminder_due_at, 'is_expired', entry.is_expired
    ) order by entry.created_at, entry.id) from own_entries entry), '[]'::jsonb),
    'partners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'partner_membership', partner_membership,
      'trips_i_owe', greatest(net_count, 0),
      'trips_owed_to_me', greatest(-net_count, 0)
    ) order by partner_membership) from netted), '[]'::jsonb)
  );
$$;
revoke all on function public.get_my_ledger() from public, anon, authenticated;
grant execute on function public.get_my_ledger() to authenticated;

commit;
