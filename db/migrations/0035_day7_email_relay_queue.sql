-- Task 7.2: outbound email relay queue, address masking, and delivery policy.
-- No SMTP secrets in SQL. Handover reminder delivery remains Day 8.
-- No mobile numbers, amount/price/currency, or child nicknames in relay tables.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Delivery policy (immutable once published)
-- ---------------------------------------------------------------------------
create table public.email_relay_delivery_policies (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid references public.schools(id) on delete cascade,
  version integer not null check (version > 0),
  is_published boolean not null default false,
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_at timestamptz not null default pg_catalog.now(),
  published_at timestamptz,
  unique (school_id, version),
  check ((not is_published) or published_at is not null)
);
create unique index email_relay_one_published_per_scope_idx
  on public.email_relay_delivery_policies
  (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_published;

comment on table public.email_relay_delivery_policies is
  'Published email-relay delivery policy. No SMTP secrets. Handover reminders excluded until Day 8.';

create function public.email_relay_policy_definition_is_valid(definition jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_typeof(definition) = 'object'
    and definition ?& array[
      'relay_enabled', 'allowed_kinds', 'excluded_kinds',
      'max_attempts', 'retry_interval_minutes', 'transport'
    ]
    and (definition - array[
      'relay_enabled', 'allowed_kinds', 'excluded_kinds',
      'max_attempts', 'retry_interval_minutes', 'transport'
    ]) = '{}'::jsonb
    and jsonb_typeof(definition -> 'relay_enabled') = 'boolean'
    and jsonb_typeof(definition -> 'allowed_kinds') = 'array'
    and jsonb_typeof(definition -> 'excluded_kinds') = 'array'
    and jsonb_typeof(definition -> 'max_attempts') = 'number'
    and jsonb_typeof(definition -> 'retry_interval_minutes') = 'number'
    and jsonb_typeof(definition -> 'transport') = 'string'
    and (definition ->> 'transport') = 'server_admin_only'
    and (definition -> 'excluded_kinds') ? 'handover_reminder'
    and not ((definition -> 'allowed_kinds') ? 'handover_reminder');
$$;
revoke all on function public.email_relay_policy_definition_is_valid(jsonb)
  from public, anon, authenticated;

alter table public.email_relay_delivery_policies
  add constraint email_relay_delivery_policies_valid_definition_check
  check (public.email_relay_policy_definition_is_valid(definition));

create function public.guard_email_relay_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' and old.is_published then
    raise exception 'published email relay policies are immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and old.is_published then
    raise exception 'published email relay policies cannot be deleted' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.guard_email_relay_policy() from public, anon, authenticated;
create trigger email_relay_delivery_policies_guard
  before update or delete on public.email_relay_delivery_policies
  for each row execute function public.guard_email_relay_policy();

insert into public.email_relay_delivery_policies (
  school_id, version, is_published, published_at, definition
) values (
  null, 1, true, pg_catalog.now(),
  '{
    "relay_enabled": true,
    "allowed_kinds": ["contact_consent_revoked", "swap_partner_notice"],
    "excluded_kinds": ["handover_reminder"],
    "max_attempts": 5,
    "retry_interval_minutes": 15,
    "transport": "server_admin_only"
  }'::jsonb
);

-- ---------------------------------------------------------------------------
-- Queue and delivery events
-- ---------------------------------------------------------------------------
create table public.email_relay_queue (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  swap_id uuid references public.swap_proposals(id) on delete restrict,
  recipient_user_id uuid not null references public.profiles(id) on delete restrict,
  recipient_membership uuid not null,
  kind text not null check (kind in ('contact_consent_revoked', 'swap_partner_notice')),
  template_key text not null check (char_length(template_key) between 3 and 64),
  status text not null check (status in ('queued', 'claimed', 'sent', 'failed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 64),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  check (kind <> 'handover_reminder'),
  check (status <> 'queued' or (claimed_at is null and sent_at is null and cancelled_at is null)),
  check (status <> 'claimed' or claimed_at is not null),
  check (status <> 'sent' or sent_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null),
  foreign key (recipient_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create unique index email_relay_queue_unique_active_idx
  on public.email_relay_queue (swap_id, recipient_membership, kind)
  where status in ('queued', 'claimed');
create index email_relay_queue_claim_idx
  on public.email_relay_queue (status, next_attempt_at, created_at)
  where status in ('queued', 'failed');
create index email_relay_queue_school_idx
  on public.email_relay_queue (school_id, created_at desc);
alter table public.email_relay_queue
  add constraint email_relay_queue_id_school_key unique (id, school_id);

comment on table public.email_relay_queue is
  'Outbound email relay queue. No raw email, phone, nickname, amount, price or currency columns. Masking is RPC-only.';

create table public.email_relay_delivery_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  queue_id uuid not null,
  event_code text not null check (event_code in (
    'enqueued', 'claimed', 'sent', 'failed', 'cancelled', 'policy_blocked'
  )),
  detail_code text check (detail_code is null or char_length(detail_code) between 1 and 64),
  created_at timestamptz not null default pg_catalog.now(),
  foreign key (queue_id, school_id)
    references public.email_relay_queue(id, school_id) on delete restrict
);
create index email_relay_delivery_events_queue_idx
  on public.email_relay_delivery_events (queue_id, created_at);

comment on table public.email_relay_delivery_events is
  'Append-only relay delivery events. No recipient addresses or mobile numbers.';

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create function public.guard_email_relay_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
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

create trigger email_relay_queue_guard_rows
  before insert or update or delete on public.email_relay_queue
  for each row execute function public.guard_email_relay_history();
create trigger email_relay_queue_guard_truncate
  before truncate on public.email_relay_queue
  for each statement execute function public.guard_email_relay_history();
alter table public.email_relay_queue enable always trigger email_relay_queue_guard_rows;
alter table public.email_relay_queue enable always trigger email_relay_queue_guard_truncate;

create trigger email_relay_delivery_events_guard_rows
  before insert or update or delete on public.email_relay_delivery_events
  for each row execute function public.guard_email_relay_history();
create trigger email_relay_delivery_events_guard_truncate
  before truncate on public.email_relay_delivery_events
  for each statement execute function public.guard_email_relay_history();
alter table public.email_relay_delivery_events enable always trigger email_relay_delivery_events_guard_rows;
alter table public.email_relay_delivery_events enable always trigger email_relay_delivery_events_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.email_relay_delivery_policies enable row level security;
alter table public.email_relay_queue enable row level security;
alter table public.email_relay_delivery_events enable row level security;

create policy email_relay_delivery_policies_select on public.email_relay_delivery_policies
  for select to authenticated using (
    is_published
    and (school_id is null or public.is_member(school_id) or public.is_moderator(school_id) or public.is_admin())
  );

create policy email_relay_queue_select on public.email_relay_queue
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or recipient_user_id = auth.uid()
    or created_by = auth.uid()
  );

create policy email_relay_delivery_events_select on public.email_relay_delivery_events
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or exists (
      select 1 from public.email_relay_queue queue
      where queue.id = email_relay_delivery_events.queue_id
        and queue.school_id = email_relay_delivery_events.school_id
        and (queue.recipient_user_id = auth.uid() or queue.created_by = auth.uid())
    )
  );

revoke all on table public.email_relay_delivery_policies from public, anon, authenticated;
revoke all on table public.email_relay_queue from public, anon, authenticated;
revoke all on table public.email_relay_delivery_events from public, anon, authenticated;
grant select on table public.email_relay_delivery_policies to authenticated;
grant select on table public.email_relay_queue to authenticated;
grant select on table public.email_relay_delivery_events to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.mask_email_address(p_email text)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  trimmed text := lower(trim(coalesce(p_email, '')));
  local_part text;
  domain_part text;
  domain_name text;
  tld text;
  at_pos integer;
  dot_pos integer;
begin
  if trimmed !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return '***';
  end if;
  at_pos := position('@' in trimmed);
  local_part := left(trimmed, at_pos - 1);
  domain_part := substr(trimmed, at_pos + 1);
  dot_pos := pg_catalog.length(domain_part) - position('.' in reverse(domain_part)) + 1;
  if dot_pos <= 1 or dot_pos >= pg_catalog.length(domain_part) then
    return '***';
  end if;
  domain_name := left(domain_part, dot_pos - 1);
  tld := substr(domain_part, dot_pos + 1);
  return left(local_part, 1) || '***@'
    || left(domain_name, 1) || '***.'
    || tld;
end;
$$;
revoke all on function public.mask_email_address(text) from public, anon, authenticated;
grant execute on function public.mask_email_address(text) to authenticated;

create function public.email_relay_published_policy(p_school_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (
      select policy.definition
      from public.email_relay_delivery_policies policy
      where policy.is_published and policy.school_id = p_school_id
      order by policy.version desc
      limit 1
    ),
    (
      select policy.definition
      from public.email_relay_delivery_policies policy
      where policy.is_published and policy.school_id is null
      order by policy.version desc
      limit 1
    )
  );
$$;
revoke all on function public.email_relay_published_policy(uuid)
  from public, anon, authenticated;

create function public.email_relay_kind_allowed(p_school_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(
    (public.email_relay_published_policy(p_school_id) ->> 'relay_enabled')::boolean, false
  )
  and p_kind is distinct from 'handover_reminder'
  and coalesce(public.email_relay_published_policy(p_school_id) -> 'allowed_kinds', '[]'::jsonb) ? p_kind
  and not coalesce(public.email_relay_published_policy(p_school_id) -> 'excluded_kinds', '[]'::jsonb) ? p_kind;
$$;
revoke all on function public.email_relay_kind_allowed(uuid, text)
  from public, anon, authenticated;

create function public.email_relay_queue_json(p_queue public.email_relay_queue)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  raw_email text;
begin
  select u.email into raw_email from auth.users u where u.id = p_queue.recipient_user_id;
  return pg_catalog.jsonb_build_object(
    'id', p_queue.id,
    'school_id', p_queue.school_id,
    'swap_id', p_queue.swap_id,
    'recipient_user_id', p_queue.recipient_user_id,
    'kind', p_queue.kind,
    'template_key', p_queue.template_key,
    'status', p_queue.status,
    'attempt_count', p_queue.attempt_count,
    'masked_recipient', public.mask_email_address(raw_email),
    'created_at', p_queue.created_at,
    'sent_at', p_queue.sent_at
  );
end;
$$;
revoke all on function public.email_relay_queue_json(public.email_relay_queue)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authenticated RPCs
-- ---------------------------------------------------------------------------
create function public.get_email_relay_delivery_policy()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
  policy jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
  order by membership.created_at, membership.id
  limit 1;
  if school is null then
    raise exception 'verified membership required' using errcode = '42501';
  end if;
  policy := public.email_relay_published_policy(school);
  if policy is null then
    raise exception 'email relay policy unavailable' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'school_id', school,
    'relay_enabled', policy -> 'relay_enabled',
    'allowed_kinds', policy -> 'allowed_kinds',
    'excluded_kinds', policy -> 'excluded_kinds',
    'max_attempts', policy -> 'max_attempts',
    'retry_interval_minutes', policy -> 'retry_interval_minutes',
    'transport', policy -> 'transport'
  );
end;
$$;
revoke all on function public.get_email_relay_delivery_policy()
  from public, anon, authenticated;
grant execute on function public.get_email_relay_delivery_policy() to authenticated;

create function public.enqueue_email_relay(
  p_swap_id uuid,
  p_kind text,
  p_recipient_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  swap public.swap_proposals%rowtype;
  recipient public.school_memberships%rowtype;
  existing public.email_relay_queue%rowtype;
  created public.email_relay_queue%rowtype;
  template text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_kind = 'handover_reminder' then
    raise exception 'handover reminder delivery is Day 8' using errcode = '42501';
  end if;
  if p_kind not in ('contact_consent_revoked', 'swap_partner_notice') then
    raise exception 'email relay kind not allowed' using errcode = '22023';
  end if;

  select * into swap from public.swap_proposals where id = p_swap_id for update;
  if swap.id is null
    or auth.uid() not in (swap.proposer_id, swap.recipient_id)
    or not public.is_member(swap.school_id) then
    raise exception 'accepted swap participant required' using errcode = '42501';
  end if;
  if p_recipient_user_id not in (swap.proposer_id, swap.recipient_id)
    or p_recipient_user_id = auth.uid() then
    raise exception 'email relay recipient must be the swap partner' using errcode = '42501';
  end if;
  if not public.email_relay_kind_allowed(swap.school_id, p_kind) then
    raise exception 'email relay kind blocked by delivery policy' using errcode = '42501';
  end if;

  select * into recipient
  from public.school_memberships membership
  where membership.school_id = swap.school_id
    and membership.user_id = p_recipient_user_id
    and membership.status = 'verified';
  if recipient.id is null then
    raise exception 'verified recipient membership required' using errcode = '42501';
  end if;

  select row_queue.* into existing
  from public.email_relay_queue as row_queue
  where row_queue.swap_id = swap.id
    and row_queue.recipient_membership = recipient.id
    and row_queue.kind = p_kind
    and row_queue.status in ('queued', 'claimed')
  for update;
  if existing.id is not null then
    return public.email_relay_queue_json(existing);
  end if;

  template := case p_kind
    when 'contact_consent_revoked' then 'contact_consent_revoked_v1'
    else 'swap_partner_notice_v1'
  end;

  insert into public.email_relay_queue (
    school_id, swap_id, recipient_user_id, recipient_membership,
    kind, template_key, status, created_by
  ) values (
    swap.school_id, swap.id, p_recipient_user_id, recipient.id,
    p_kind, template, 'queued', auth.uid()
  ) returning * into created;

  insert into public.email_relay_delivery_events (school_id, queue_id, event_code, detail_code)
  values (created.school_id, created.id, 'enqueued', p_kind);
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), created.school_id, 'email_relay.enqueued', 'email_relay_queue', created.id,
    pg_catalog.jsonb_build_object('outcome', 'enqueued', 'reason_code', p_kind)
  );
  return public.email_relay_queue_json(created);
end;
$$;
revoke all on function public.enqueue_email_relay(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.enqueue_email_relay(uuid, text, uuid) to authenticated;

create function public.list_my_email_relay_queue()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select coalesce(pg_catalog.jsonb_agg(public.email_relay_queue_json(queue)
    order by queue.created_at desc, queue.id), '[]'::jsonb)
  from public.email_relay_queue queue
  where queue.recipient_user_id = auth.uid()
     or queue.created_by = auth.uid();
$$;
revoke all on function public.list_my_email_relay_queue()
  from public, anon, authenticated;
grant execute on function public.list_my_email_relay_queue() to authenticated;

create function public.list_school_email_relay_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and (public.is_moderator(membership.school_id) or public.is_admin())
  order by membership.created_at, membership.id
  limit 1;
  if school is null then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'school_id', school,
    'items', coalesce((
      select pg_catalog.jsonb_agg(public.email_relay_queue_json(queue)
        order by queue.created_at desc, queue.id)
      from public.email_relay_queue queue
      where queue.school_id = school
        and queue.status in ('queued', 'claimed', 'failed')
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.list_school_email_relay_queue()
  from public, anon, authenticated;
grant execute on function public.list_school_email_relay_queue() to authenticated;

-- ---------------------------------------------------------------------------
-- Service-role claim / complete (server admin transport only)
-- ---------------------------------------------------------------------------
create function public.claim_email_relay_batch(p_limit integer default 10)
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
    -- Allow DB owner/test harness labelled privileged path only when role is not authenticated/anon.
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
      and public.email_relay_kind_allowed(queue.school_id, queue.kind)
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

create function public.complete_email_relay_delivery(p_queue_id uuid, p_outcome text, p_detail_code text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  item public.email_relay_queue%rowtype;
  retry_minutes integer;
begin
  if auth.role() is distinct from 'service_role' and current_user is distinct from 'service_role' then
    if current_setting('request.jwt.claim.role', true) in ('authenticated', 'anon')
      or current_user in ('authenticated', 'anon') then
      raise exception 'service role required for email relay completion' using errcode = '42501';
    end if;
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid email relay outcome' using errcode = '22023';
  end if;

  select * into item from public.email_relay_queue where id = p_queue_id for update;
  if item.id is null then
    raise exception 'email relay queue item not found' using errcode = 'P0002';
  end if;
  if item.status not in ('claimed', 'queued', 'failed') then
    return item.status;
  end if;

  if p_outcome = 'sent' then
    update public.email_relay_queue
    set status = 'sent', sent_at = pg_catalog.now(), last_error_code = null
    where id = item.id;
    insert into public.email_relay_delivery_events (school_id, queue_id, event_code, detail_code)
    values (item.school_id, item.id, 'sent', coalesce(p_detail_code, 'delivered'));
    return 'sent';
  end if;

  retry_minutes := coalesce(
    (public.email_relay_published_policy(item.school_id) ->> 'retry_interval_minutes')::integer, 15);
  update public.email_relay_queue
  set status = 'failed',
      last_error_code = left(coalesce(p_detail_code, 'transport_failed'), 64),
      next_attempt_at = pg_catalog.now() + (retry_minutes * interval '1 minute'),
      claimed_at = null
  where id = item.id;
  insert into public.email_relay_delivery_events (school_id, queue_id, event_code, detail_code)
  values (item.school_id, item.id, 'failed', left(coalesce(p_detail_code, 'transport_failed'), 64));
  return 'failed';
end;
$$;
revoke all on function public.complete_email_relay_delivery(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_email_relay_delivery(uuid, text, text) to service_role;

commit;
