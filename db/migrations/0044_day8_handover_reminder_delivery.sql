-- Task 8.3: handover reminder delivery via email-relay queue after live
-- eligibility recheck. Authenticated enqueue of handover_reminder stays denied;
-- only the service delivery path may insert that kind. No amount/price/currency,
-- phones in payloads, child nicknames, or live location.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Allow handover_reminder on the queue table (dedicated delivery path only)
-- ---------------------------------------------------------------------------
do $$
declare
  constraint_row record;
  definition text;
begin
  for constraint_row in
    select c.oid, c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.email_relay_queue'::regclass
      and c.contype = 'c'
  loop
    definition := pg_catalog.pg_get_constraintdef(constraint_row.oid);
    if definition ~* 'handover_reminder'
      or definition ~* 'contact_consent_revoked'
    then
      execute format(
        'alter table public.email_relay_queue drop constraint %I',
        constraint_row.conname
      );
    end if;
  end loop;
end;
$$;

alter table public.email_relay_queue
  add constraint email_relay_queue_kind_check
  check (kind in (
    'contact_consent_revoked',
    'swap_partner_notice',
    'handover_reminder'
  ));

comment on column public.email_relay_queue.kind is
  'Relay kind. handover_reminder is inserted only by service delivery after eligibility recheck.';

-- Claim may transport handover_reminder rows even though general policy still excludes
-- them from authenticated enqueue_email_relay.
create or replace function public.claim_email_relay_batch(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  claimed jsonb := '[]'::jsonb;
  item record;
  raw_email text;
  max_attempts integer;
begin
  if auth.role() is distinct from 'service_role' and current_user is distinct from 'service_role' then
    if current_setting('request.jwt.claim.role', true) in ('authenticated', 'anon')
      or current_user in ('authenticated', 'anon') then
      raise exception 'service role required for email relay claim' using errcode = '42501';
    end if;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'claim limit out of range' using errcode = '22023';
  end if;

  for item in
    select queue.*
    from public.email_relay_queue queue
    where queue.status in ('queued', 'failed')
      and queue.next_attempt_at <= pg_catalog.now()
      and (
        public.email_relay_kind_allowed(queue.school_id, queue.kind)
        or queue.kind = 'handover_reminder'
      )
    order by queue.next_attempt_at, queue.created_at
    for update skip locked
    limit p_limit
  loop
    max_attempts := coalesce(
      (public.email_relay_published_policy(item.school_id) ->> 'max_attempts')::integer, 5);
    if item.attempt_count >= max_attempts then
      update public.email_relay_queue
      set status = 'failed',
          last_error_code = 'max_attempts',
          next_attempt_at = pg_catalog.now() + interval '365 days'
      where id = item.id;
      insert into public.email_relay_delivery_events (school_id, queue_id, event_code, detail_code)
      values (item.school_id, item.id, 'failed', 'max_attempts');
      continue;
    end if;

    select u.email into raw_email from auth.users u where u.id = item.recipient_user_id;
    update public.email_relay_queue
    set status = 'claimed',
        attempt_count = item.attempt_count + 1,
        claimed_at = pg_catalog.now(),
        last_error_code = null
    where id = item.id;

    insert into public.email_relay_delivery_events (school_id, queue_id, event_code, detail_code)
    values (item.school_id, item.id, 'claimed', item.kind);

    claimed := claimed || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', item.id,
      'school_id', item.school_id,
      'kind', item.kind,
      'template_key', item.template_key,
      'recipient_user_id', item.recipient_user_id,
      'recipient_email', raw_email,
      'masked_recipient', public.mask_email_address(raw_email)
    ));
  end loop;

  return pg_catalog.jsonb_build_object('items', claimed);
end;
$$;
revoke all on function public.claim_email_relay_batch(integer)
  from public, anon, authenticated;
grant execute on function public.claim_email_relay_batch(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Delivery ledger (append-only)
-- ---------------------------------------------------------------------------
create table public.handover_reminder_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  reminder_id uuid not null unique references public.swap_leg_reminders(id) on delete restrict,
  swap_leg_id uuid not null,
  swap_id uuid not null references public.swap_proposals(id) on delete restrict,
  recipient_user_id uuid not null references public.profiles(id) on delete restrict,
  recipient_membership uuid not null,
  outcome text not null check (outcome in (
    'queued',
    'suppressed_completed',
    'suppressed_cancelled',
    'suppressed_ineligible'
  )),
  email_relay_queue_id uuid references public.email_relay_queue(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  check (
    (outcome = 'queued' and email_relay_queue_id is not null)
    or (outcome <> 'queued' and email_relay_queue_id is null)
  ),
  foreign key (swap_leg_id, school_id)
    references public.swap_legs(id, school_id) on delete restrict,
  foreign key (recipient_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index handover_reminder_deliveries_school_idx
  on public.handover_reminder_deliveries (school_id, created_at desc);
create index handover_reminder_deliveries_recipient_idx
  on public.handover_reminder_deliveries (recipient_user_id, created_at desc);

comment on table public.handover_reminder_deliveries is
  'One delivery decision per reminder after live eligibility recheck. No phone nickname amount price or currency fields.';

create function public.guard_handover_reminder_deliveries()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' or tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'handover reminder deliveries are append-only' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_handover_reminder_deliveries()
  from public, anon, authenticated;

create trigger handover_reminder_deliveries_guard_rows
  before insert or update or delete on public.handover_reminder_deliveries
  for each row execute function public.guard_handover_reminder_deliveries();
create trigger handover_reminder_deliveries_guard_truncate
  before truncate on public.handover_reminder_deliveries
  for each statement execute function public.guard_handover_reminder_deliveries();
alter table public.handover_reminder_deliveries
  enable always trigger handover_reminder_deliveries_guard_rows;
alter table public.handover_reminder_deliveries
  enable always trigger handover_reminder_deliveries_guard_truncate;

alter table public.handover_reminder_deliveries enable row level security;
revoke all on table public.handover_reminder_deliveries from public, anon, authenticated;
grant select on table public.handover_reminder_deliveries to authenticated;

create policy handover_reminder_deliveries_select on public.handover_reminder_deliveries
  for select to authenticated using (
    public.is_admin()
    or (
      public.is_member(school_id)
      and recipient_user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function public.handover_reminder_live_eligibility(p_reminder_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  reminder public.swap_leg_reminders%rowtype;
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  confirmation_count integer;
  existing_kind text;
  expected_missing text;
begin
  select * into reminder from public.swap_leg_reminders where id = p_reminder_id;
  if reminder.id is null then
    return 'suppressed_ineligible';
  end if;
  select * into leg from public.swap_legs where id = reminder.swap_leg_id;
  select * into proposal from public.swap_proposals where id = leg.swap_id;
  if leg.id is null or proposal.id is null then
    return 'suppressed_ineligible';
  end if;
  if proposal.status is distinct from 'accepted' then
    return 'suppressed_cancelled';
  end if;
  if leg.completed_at is not null then
    return 'suppressed_completed';
  end if;
  if reminder.due_at > pg_catalog.clock_timestamp() then
    return 'suppressed_ineligible';
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.min(c.confirmation_kind)
    into confirmation_count, existing_kind
  from public.swap_leg_confirmations c
  where c.swap_leg_id = leg.id;

  if confirmation_count <> 1 then
    return 'suppressed_ineligible';
  end if;
  expected_missing := case
    when existing_kind = 'pickup_done' then 'child_arrived'
    else 'pickup_done'
  end;
  if reminder.missing_confirmation is distinct from expected_missing then
    return 'suppressed_ineligible';
  end if;
  return 'eligible';
end;
$$;
revoke all on function public.handover_reminder_live_eligibility(uuid)
  from public, anon, authenticated;

create function public.handover_reminder_delivery_json(
  p_delivery public.handover_reminder_deliveries
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_delivery.id,
    'school_id', p_delivery.school_id,
    'reminder_id', p_delivery.reminder_id,
    'swap_leg_id', p_delivery.swap_leg_id,
    'swap_id', p_delivery.swap_id,
    'outcome', p_delivery.outcome,
    'email_relay_queue_id', p_delivery.email_relay_queue_id,
    'created_at', p_delivery.created_at
  );
$$;
revoke all on function public.handover_reminder_delivery_json(public.handover_reminder_deliveries)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Service delivery sweep
-- ---------------------------------------------------------------------------
create function public.deliver_due_handover_reminders(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  reminder record;
  eligibility text;
  recipient public.school_memberships%rowtype;
  created_queue public.email_relay_queue%rowtype;
  created_delivery public.handover_reminder_deliveries%rowtype;
  queued_count integer := 0;
  suppressed_count integer := 0;
  result_items jsonb := '[]'::jsonb;
  limit_count integer;
begin
  if auth.role() is distinct from 'service_role' and current_user is distinct from 'service_role' then
    if current_setting('request.jwt.claim.role', true) in ('authenticated', 'anon')
      or current_user in ('authenticated', 'anon') then
      raise exception 'service role required for handover reminder delivery'
        using errcode = '42501';
    end if;
  end if;

  limit_count := coalesce(p_limit, 100);
  if limit_count < 1 or limit_count > 500 then
    raise exception 'delivery limit out of range' using errcode = '22023';
  end if;

  for reminder in
    select r.*, leg.swap_id
    from public.swap_leg_reminders r
    join public.swap_legs leg on leg.id = r.swap_leg_id
    where not exists (
      select 1 from public.handover_reminder_deliveries d where d.reminder_id = r.id
    )
    order by r.due_at, r.id
    limit limit_count
  loop
    created_queue := null;
    created_delivery := null;
    recipient := null;

    perform 1 from public.swap_proposals proposal
      where proposal.id = reminder.swap_id for update;
    perform 1 from public.swap_legs leg
      where leg.id = reminder.swap_leg_id for update;

    eligibility := public.handover_reminder_live_eligibility(reminder.id);
    select * into recipient
    from public.school_memberships membership
    where membership.id = reminder.recipient_membership;

    if eligibility is distinct from 'eligible' or recipient.id is null then
      if eligibility = 'eligible' then
        eligibility := 'suppressed_ineligible';
      end if;
      if recipient.id is null then
        continue;
      end if;
      insert into public.handover_reminder_deliveries (
        school_id, reminder_id, swap_leg_id, swap_id,
        recipient_user_id, recipient_membership, outcome, email_relay_queue_id
      ) values (
        reminder.school_id, reminder.id, reminder.swap_leg_id, reminder.swap_id,
        recipient.user_id, reminder.recipient_membership, eligibility, null
      )
      on conflict (reminder_id) do nothing
      returning * into created_delivery;
      if created_delivery.id is not null then
        suppressed_count := suppressed_count + 1;
        result_items := result_items || pg_catalog.jsonb_build_array(
          public.handover_reminder_delivery_json(created_delivery)
        );
        insert into public.audit_logs (
          actor_id, school_id, action, entity_type, entity_id, payload
        ) values (
          recipient.user_id,
          reminder.school_id,
          'handover_reminder.suppressed',
          'handover_reminder_delivery',
          created_delivery.id,
          pg_catalog.jsonb_build_object('outcome', eligibility, 'reason_code', 'eligibility_recheck')
        );
      end if;
      continue;
    end if;

    select row_queue.* into created_queue
    from public.email_relay_queue as row_queue
    where row_queue.swap_id = reminder.swap_id
      and row_queue.recipient_membership = reminder.recipient_membership
      and row_queue.kind = 'handover_reminder'
      and row_queue.status in ('queued', 'claimed')
    for update;
    if created_queue.id is null then
      insert into public.email_relay_queue (
        school_id, swap_id, recipient_user_id, recipient_membership,
        kind, template_key, status, created_by
      ) values (
        reminder.school_id, reminder.swap_id, recipient.user_id, recipient.id,
        'handover_reminder', 'handover_reminder_v1', 'queued', recipient.user_id
      ) returning * into created_queue;

      insert into public.email_relay_delivery_events (
        school_id, queue_id, event_code, detail_code
      ) values (
        created_queue.school_id, created_queue.id, 'enqueued', 'handover_reminder'
      );
    end if;

    insert into public.handover_reminder_deliveries (
      school_id, reminder_id, swap_leg_id, swap_id,
      recipient_user_id, recipient_membership, outcome, email_relay_queue_id
    ) values (
      reminder.school_id, reminder.id, reminder.swap_leg_id, reminder.swap_id,
      recipient.user_id, recipient.id, 'queued', created_queue.id
    )
    on conflict (reminder_id) do nothing
    returning * into created_delivery;

    if created_delivery.id is not null then
      queued_count := queued_count + 1;
      result_items := result_items || pg_catalog.jsonb_build_array(
        public.handover_reminder_delivery_json(created_delivery)
      );
      insert into public.audit_logs (
        actor_id, school_id, action, entity_type, entity_id, payload
      ) values (
        recipient.user_id, reminder.school_id, 'handover_reminder.queued',
        'handover_reminder_delivery', created_delivery.id,
        pg_catalog.jsonb_build_object('outcome', 'queued', 'reason_code', 'handover_reminder')
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'queued', queued_count,
    'suppressed', suppressed_count,
    'items', result_items
  );
end;
$$;
revoke all on function public.deliver_due_handover_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.deliver_due_handover_reminders(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Authenticated read of own delivery decisions (no email)
-- ---------------------------------------------------------------------------
create function public.list_my_handover_reminder_deliveries()
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
  select coalesce(
    pg_catalog.jsonb_agg(
      public.handover_reminder_delivery_json(delivery)
      order by delivery.created_at desc, delivery.id
    ),
    '[]'::jsonb
  )
  into result
  from public.handover_reminder_deliveries delivery
  where delivery.recipient_user_id = auth.uid()
    and public.is_member(delivery.school_id);
  return result;
end;
$$;
revoke all on function public.list_my_handover_reminder_deliveries()
  from public, anon, authenticated;
grant execute on function public.list_my_handover_reminder_deliveries() to authenticated;

commit;
