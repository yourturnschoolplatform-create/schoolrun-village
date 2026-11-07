-- Task 6.3: provisional no-show / false-report cases, safety holds, appeals,
-- moderator resolution, swap-only disable, and no-show trip-penalty obligations.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.trust_incident_reports (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  swap_leg_id uuid not null,
  reporter_user_id uuid not null references public.profiles(id) on delete restrict,
  subject_user_id uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('no_show', 'false_report')),
  status text not null check (status in ('provisional', 'disputed', 'confirmed', 'rejected')),
  backup_accepted boolean not null default false,
  related_report_id uuid references public.trust_incident_reports(id) on delete restrict,
  provisional_until timestamptz not null,
  disputed_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  check (reporter_user_id <> subject_user_id),
  check ((kind = 'false_report') = (related_report_id is not null)),
  check ((status in ('confirmed', 'rejected')) = (resolved_at is not null)),
  check ((status = 'disputed') = (disputed_at is not null)),
  foreign key (swap_leg_id, school_id) references public.swap_legs(id, school_id) on delete restrict
);
create unique index trust_incident_reports_no_show_once_idx
  on public.trust_incident_reports (swap_leg_id)
  where kind = 'no_show';
create unique index trust_incident_reports_false_once_idx
  on public.trust_incident_reports (related_report_id)
  where kind = 'false_report';
create index trust_incident_reports_school_status_idx
  on public.trust_incident_reports (school_id, status, created_at desc);

create table public.trust_safety_holds (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  subject_user_id uuid not null references public.profiles(id) on delete restrict,
  placed_by uuid not null references public.profiles(id) on delete restrict,
  status text not null check (status in ('active', 'lifted', 'upheld')),
  reason_code text not null check (char_length(reason_code) between 1 and 64),
  placed_at timestamptz not null default pg_catalog.now(),
  review_due_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete restrict,
  check ((status = 'active') = (resolved_at is null)),
  check (review_due_at = placed_at + interval '24 hours')
);
create unique index trust_safety_holds_one_active_idx
  on public.trust_safety_holds (school_id, subject_user_id)
  where status = 'active';
create index trust_safety_holds_school_idx
  on public.trust_safety_holds (school_id, status, placed_at desc);

create table public.trust_appeals (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  appellant_user_id uuid not null references public.profiles(id) on delete restrict,
  target_type text not null check (target_type in ('incident_report', 'safety_hold')),
  target_id uuid not null,
  status text not null check (status in ('open', 'upheld', 'dismissed')),
  filed_at timestamptz not null default pg_catalog.now(),
  appeal_deadline_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete restrict,
  check ((status = 'open') = (resolved_at is null)),
  unique (target_type, target_id)
);
create index trust_appeals_school_idx
  on public.trust_appeals (school_id, status, filed_at desc);

-- Pair-specific no-show trip obligations (not money). Two +1 rows per confirmed no-show.
create table public.trust_trip_penalties (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  report_id uuid not null references public.trust_incident_reports(id) on delete restrict,
  from_membership uuid not null,
  to_membership uuid not null,
  trip_count_delta smallint not null check (trip_count_delta = 1),
  sequence_no smallint not null check (sequence_no in (1, 2)),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null,
  check (from_membership <> to_membership),
  check (expires_at = created_at + interval '1344 hours'),
  unique (report_id, sequence_no),
  foreign key (from_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict,
  foreign key (to_membership, school_id)
    references public.school_memberships(id, school_id) on delete restrict
);
create index trust_trip_penalties_pair_idx
  on public.trust_trip_penalties (school_id, from_membership, to_membership, expires_at);

comment on table public.trust_trip_penalties is
  'Append-only no-show trip obligations; never amount, price or currency.';

-- ---------------------------------------------------------------------------
-- Append-only guards for penalty rows and hold/report history integrity
-- ---------------------------------------------------------------------------
create function public.guard_trust_trip_penalties()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'trust trip penalties are append-only' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_trust_trip_penalties() from public, anon, authenticated;
create trigger trust_trip_penalties_guard_rows
  before insert or update or delete on public.trust_trip_penalties
  for each row execute function public.guard_trust_trip_penalties();
create trigger trust_trip_penalties_guard_truncate
  before truncate on public.trust_trip_penalties
  for each statement execute function public.guard_trust_trip_penalties();
alter table public.trust_trip_penalties enable always trigger trust_trip_penalties_guard_rows;
alter table public.trust_trip_penalties enable always trigger trust_trip_penalties_guard_truncate;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.trust_incident_reports enable row level security;
alter table public.trust_safety_holds enable row level security;
alter table public.trust_appeals enable row level security;
alter table public.trust_trip_penalties enable row level security;

create policy trust_incident_reports_select on public.trust_incident_reports
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or reporter_user_id = auth.uid()
    or subject_user_id = auth.uid()
  );
create policy trust_safety_holds_select on public.trust_safety_holds
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or subject_user_id = auth.uid()
  );
create policy trust_appeals_select on public.trust_appeals
  for select to authenticated using (
    public.is_admin()
    or public.is_moderator(school_id)
    or appellant_user_id = auth.uid()
  );
create policy trust_trip_penalties_select on public.trust_trip_penalties
  for select to authenticated using (
    public.is_member(school_id)
    and exists (
      select 1 from public.school_memberships membership
      where membership.user_id = auth.uid()
        and membership.status = 'verified'
        and membership.school_id = trust_trip_penalties.school_id
        and membership.id in (from_membership, to_membership)
    )
  );

revoke all on table public.trust_incident_reports from public, anon, authenticated;
revoke all on table public.trust_safety_holds from public, anon, authenticated;
revoke all on table public.trust_appeals from public, anon, authenticated;
revoke all on table public.trust_trip_penalties from public, anon, authenticated;
grant select on table public.trust_incident_reports to authenticated;
grant select on table public.trust_safety_holds to authenticated;
grant select on table public.trust_appeals to authenticated;
grant select on table public.trust_trip_penalties to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function public.user_has_active_safety_hold(p_user_id uuid, p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1 from public.trust_safety_holds hold
    where hold.subject_user_id = p_user_id
      and hold.school_id = p_school_id
      and hold.status = 'active'
  );
$$;
revoke all on function public.user_has_active_safety_hold(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.user_has_active_safety_hold(uuid, uuid) to authenticated;

create function public.apply_confirmed_no_show_effects(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  report public.trust_incident_reports%rowtype;
  reason text;
  owed integer;
  debtor uuid;
  creditor uuid;
  posted_at timestamptz := pg_catalog.now();
  seq smallint;
begin
  select source.* into report from public.trust_incident_reports source where source.id = p_report_id;
  if report.id is null or report.kind <> 'no_show' or report.status <> 'confirmed' then
    raise exception 'confirmed no-show report required' using errcode = '22023';
  end if;
  reason := case when report.backup_accepted then 'confirmed_no_show_with_backup' else 'confirmed_no_show' end;
  perform public.apply_trust_score_delta(
    report.subject_user_id, report.school_id,
    public.trust_policy_delta(report.school_id, reason),
    reason, 'trust_incident_report', report.id
  );
  select coalesce((public.trust_published_policy(report.school_id)
    ->> 'confirmed_no_show_trips_owed')::integer, 2)
  into owed;
  if owed < 1 then owed := 1; end if;
  if owed > 2 then owed := 2; end if;
  select membership.id into debtor
  from public.school_memberships membership
  where membership.school_id = report.school_id
    and membership.user_id = report.subject_user_id
    and membership.status = 'verified';
  select membership.id into creditor
  from public.school_memberships membership
  where membership.school_id = report.school_id
    and membership.user_id = report.reporter_user_id
    and membership.status = 'verified';
  if debtor is null or creditor is null then
    raise exception 'verified memberships required for no-show trips owed' using errcode = '42501';
  end if;
  for seq in 1..owed loop
    insert into public.trust_trip_penalties
      (school_id, report_id, from_membership, to_membership, trip_count_delta, sequence_no,
       created_at, expires_at)
    values (
      report.school_id, report.id, debtor, creditor, 1, seq,
      posted_at, posted_at + interval '1344 hours'
    )
    on conflict (report_id, sequence_no) do nothing;
  end loop;
end;
$$;
revoke all on function public.apply_confirmed_no_show_effects(uuid)
  from public, anon, authenticated;

create function public.apply_confirmed_false_report_effects(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  report public.trust_incident_reports%rowtype;
begin
  select source.* into report from public.trust_incident_reports source where source.id = p_report_id;
  if report.id is null or report.kind <> 'false_report' or report.status <> 'confirmed' then
    raise exception 'confirmed false-report case required' using errcode = '22023';
  end if;
  -- Subject of a false-report case is the original no-show reporter who filed falsely.
  perform public.apply_trust_score_delta(
    report.subject_user_id, report.school_id,
    public.trust_policy_delta(report.school_id, 'confirmed_false_report'),
    'confirmed_false_report', 'trust_incident_report', report.id
  );
end;
$$;
revoke all on function public.apply_confirmed_false_report_effects(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Parent / moderator RPCs
-- ---------------------------------------------------------------------------
create function public.report_no_show(p_swap_leg_id uuid, p_backup_accepted boolean default false)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  subject uuid;
  report_id uuid;
  event_time timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select source.* into leg from public.swap_legs source where source.id = p_swap_leg_id;
  if leg.id is null then raise exception 'swap leg unavailable' using errcode = '42501'; end if;
  select source.* into proposal from public.swap_proposals source where source.id = leg.swap_id;
  if proposal.status <> 'accepted'
    or auth.uid() not in (leg.helper_id, leg.requester_id)
    or not public.is_member(leg.school_id) then
    raise exception 'accepted same-school participant required' using errcode = '42501';
  end if;
  subject := case when auth.uid() = leg.helper_id then leg.requester_id else leg.helper_id end;
  insert into public.trust_incident_reports (
    school_id, swap_leg_id, reporter_user_id, subject_user_id, kind, status,
    backup_accepted, provisional_until, created_at
  ) values (
    leg.school_id, leg.id, auth.uid(), subject, 'no_show', 'provisional',
    coalesce(p_backup_accepted, false), event_time + interval '24 hours', event_time
  )
  returning id into report_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), leg.school_id, 'trust.report_filed', 'trust_incident_report', report_id,
    pg_catalog.jsonb_build_object('reason_code', 'no_show', 'outcome', 'provisional')
  );
  return report_id;
end;
$$;
revoke all on function public.report_no_show(uuid, boolean) from public, anon, authenticated;
grant execute on function public.report_no_show(uuid, boolean) to authenticated;

create function public.dispute_trust_report(p_report_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  report public.trust_incident_reports%rowtype;
  event_time timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select source.* into report from public.trust_incident_reports source
  where source.id = p_report_id for update;
  if report.id is null or report.subject_user_id <> auth.uid()
    or not public.is_member(report.school_id) then
    raise exception 'report dispute unavailable' using errcode = '42501';
  end if;
  if report.status <> 'provisional' or event_time > report.provisional_until then
    raise exception 'provisional dispute window closed' using errcode = '22023';
  end if;
  update public.trust_incident_reports as target
  set status = 'disputed', disputed_at = event_time
  where target.id = report.id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), report.school_id, 'trust.report_disputed', 'trust_incident_report', report.id,
    pg_catalog.jsonb_build_object('previous_status', 'provisional', 'next_status', 'disputed')
  );
  return 'disputed';
end;
$$;
revoke all on function public.dispute_trust_report(uuid) from public, anon, authenticated;
grant execute on function public.dispute_trust_report(uuid) to authenticated;

create function public.report_false_report(p_no_show_report_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  source_report public.trust_incident_reports%rowtype;
  report_id uuid;
  event_time timestamptz := pg_catalog.now();
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select source.* into source_report from public.trust_incident_reports source
  where source.id = p_no_show_report_id for update;
  if source_report.id is null or source_report.kind <> 'no_show'
    or source_report.subject_user_id <> auth.uid()
    or source_report.status not in ('provisional', 'disputed', 'confirmed')
    or not public.is_member(source_report.school_id) then
    raise exception 'false report unavailable' using errcode = '42501';
  end if;
  insert into public.trust_incident_reports (
    school_id, swap_leg_id, reporter_user_id, subject_user_id, kind, status,
    backup_accepted, related_report_id, provisional_until, created_at
  ) values (
    source_report.school_id, source_report.swap_leg_id, auth.uid(),
    source_report.reporter_user_id, 'false_report', 'provisional', false,
    source_report.id, event_time + interval '24 hours', event_time
  )
  returning id into report_id;
  if source_report.status = 'provisional' then
    update public.trust_incident_reports as target
    set status = 'disputed', disputed_at = event_time
    where target.id = source_report.id and target.status = 'provisional';
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), source_report.school_id, 'trust.report_filed', 'trust_incident_report', report_id,
    pg_catalog.jsonb_build_object('reason_code', 'false_report', 'outcome', 'provisional')
  );
  return report_id;
end;
$$;
revoke all on function public.report_false_report(uuid) from public, anon, authenticated;
grant execute on function public.report_false_report(uuid) to authenticated;

create function public.resolve_trust_report(p_report_id uuid, p_outcome text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  report public.trust_incident_reports%rowtype;
  event_time timestamptz := pg_catalog.now();
  next_status text;
begin
  if auth.uid() is null or p_outcome not in ('confirm', 'reject') then
    raise exception 'invalid trust report resolution' using errcode = '22023';
  end if;
  select source.* into report from public.trust_incident_reports source
  where source.id = p_report_id for update;
  if report.id is null
    or not (public.is_moderator(report.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if report.status not in ('provisional', 'disputed') then
    raise exception 'report already resolved' using errcode = '22023';
  end if;
  next_status := case when p_outcome = 'confirm' then 'confirmed' else 'rejected' end;
  update public.trust_incident_reports as target
  set status = next_status, resolved_at = event_time, resolved_by = auth.uid()
  where target.id = report.id;
  if next_status = 'confirmed' and report.kind = 'no_show' then
    perform public.apply_confirmed_no_show_effects(report.id);
  elsif next_status = 'confirmed' and report.kind = 'false_report' then
    perform public.apply_confirmed_false_report_effects(report.id);
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), report.school_id, 'trust.report_resolved', 'trust_incident_report', report.id,
    pg_catalog.jsonb_build_object(
      'previous_status', report.status, 'next_status', next_status, 'outcome', p_outcome
    )
  );
  return next_status;
end;
$$;
revoke all on function public.resolve_trust_report(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_trust_report(uuid, text) to authenticated;

create function public.sweep_provisional_trust_reports()
returns integer
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  report record;
  changed integer := 0;
begin
  for report in
    select source.id, source.kind
    from public.trust_incident_reports source
    where source.status = 'provisional'
      and source.provisional_until <= pg_catalog.now()
    for update skip locked
  loop
    update public.trust_incident_reports as target
    set status = 'confirmed', resolved_at = pg_catalog.now(), resolved_by = null
    where target.id = report.id and target.status = 'provisional';
    if report.kind = 'no_show' then
      perform public.apply_confirmed_no_show_effects(report.id);
    elsif report.kind = 'false_report' then
      perform public.apply_confirmed_false_report_effects(report.id);
    end if;
    insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
    select null, target.school_id, 'trust.report_resolved', 'trust_incident_report', target.id,
      pg_catalog.jsonb_build_object(
        'previous_status', 'provisional', 'next_status', 'confirmed', 'outcome', 'undisputed'
      )
    from public.trust_incident_reports target where target.id = report.id;
    changed := changed + 1;
  end loop;
  return changed;
end;
$$;
revoke all on function public.sweep_provisional_trust_reports() from public, anon, authenticated;

create function public.place_safety_hold(p_subject_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
  hold_id uuid;
  event_time timestamptz := pg_catalog.now();
begin
  if auth.uid() is null or p_subject_user_id is null or p_subject_user_id = auth.uid() then
    raise exception 'safety hold unavailable' using errcode = '22023';
  end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = p_subject_user_id
    and membership.status = 'verified'
    and (public.is_moderator(membership.school_id) or public.is_admin())
  order by membership.created_at, membership.id
  limit 1;
  if school is null then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = school
      and membership.user_id = p_subject_user_id
      and membership.status = 'verified'
  ) then
    raise exception 'verified subject membership required' using errcode = '42501';
  end if;
  insert into public.trust_safety_holds (
    school_id, subject_user_id, placed_by, status, reason_code, placed_at, review_due_at
  ) values (
    school, p_subject_user_id, auth.uid(), 'active', 'safety_hold',
    event_time, event_time + interval '24 hours'
  )
  returning id into hold_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), school, 'trust.safety_hold_placed', 'trust_safety_hold', hold_id,
    pg_catalog.jsonb_build_object('outcome', 'active', 'reason_code', 'safety_hold')
  );
  -- Alert administrator via audit only; outbound notification is a later stage.
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), school, 'trust.safety_hold_admin_alert', 'trust_safety_hold', hold_id,
    pg_catalog.jsonb_build_object('outcome', 'alerted', 'source', 'moderator')
  );
  return hold_id;
end;
$$;
revoke all on function public.place_safety_hold(uuid) from public, anon, authenticated;
grant execute on function public.place_safety_hold(uuid) to authenticated;

create function public.resolve_safety_hold(p_hold_id uuid, p_outcome text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  hold public.trust_safety_holds%rowtype;
  event_time timestamptz := pg_catalog.now();
  next_status text;
begin
  if auth.uid() is null or p_outcome not in ('lift', 'uphold') then
    raise exception 'invalid safety hold resolution' using errcode = '22023';
  end if;
  select source.* into hold from public.trust_safety_holds source
  where source.id = p_hold_id for update;
  if hold.id is null
    or not (public.is_moderator(hold.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if hold.status <> 'active' then
    raise exception 'safety hold already resolved' using errcode = '22023';
  end if;
  next_status := case when p_outcome = 'lift' then 'lifted' else 'upheld' end;
  update public.trust_safety_holds as target
  set status = next_status, resolved_at = event_time, resolved_by = auth.uid()
  where target.id = hold.id;
  if next_status = 'upheld' then
    perform public.apply_trust_score_delta(
      hold.subject_user_id, hold.school_id,
      public.trust_policy_delta(hold.school_id, 'reviewed_safety_violation'),
      'reviewed_safety_violation', 'trust_safety_hold', hold.id
    );
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), hold.school_id, 'trust.safety_hold_resolved', 'trust_safety_hold', hold.id,
    pg_catalog.jsonb_build_object(
      'previous_status', 'active', 'next_status', next_status, 'outcome', p_outcome
    )
  );
  return next_status;
end;
$$;
revoke all on function public.resolve_safety_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_safety_hold(uuid, text) to authenticated;

create function public.file_trust_appeal(p_target_type text, p_target_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
  deadline timestamptz;
  appeal_id uuid;
  event_time timestamptz := pg_catalog.now();
  report public.trust_incident_reports%rowtype;
  hold public.trust_safety_holds%rowtype;
begin
  if auth.uid() is null or p_target_type not in ('incident_report', 'safety_hold') then
    raise exception 'trust appeal unavailable' using errcode = '22023';
  end if;
  if p_target_type = 'incident_report' then
    select source.* into report from public.trust_incident_reports source where source.id = p_target_id;
    if report.id is null or report.subject_user_id <> auth.uid() or report.status <> 'confirmed' then
      raise exception 'trust appeal unavailable' using errcode = '42501';
    end if;
    school := report.school_id;
    deadline := report.resolved_at + interval '48 hours';
  else
    select source.* into hold from public.trust_safety_holds source where source.id = p_target_id;
    if hold.id is null or hold.subject_user_id <> auth.uid()
      or hold.status not in ('active', 'upheld') then
      raise exception 'trust appeal unavailable' using errcode = '42501';
    end if;
    school := hold.school_id;
    deadline := coalesce(hold.resolved_at, hold.placed_at) + interval '48 hours';
  end if;
  if not public.is_member(school) then
    raise exception 'trust appeal unavailable' using errcode = '42501';
  end if;
  if event_time > deadline then
    raise exception 'appeal window closed' using errcode = '22023';
  end if;
  insert into public.trust_appeals (
    school_id, appellant_user_id, target_type, target_id, status, filed_at, appeal_deadline_at
  ) values (
    school, auth.uid(), p_target_type, p_target_id, 'open', event_time, deadline
  )
  returning id into appeal_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), school, 'trust.appeal_filed', 'trust_appeal', appeal_id,
    pg_catalog.jsonb_build_object('outcome', 'open', 'source', p_target_type)
  );
  return appeal_id;
end;
$$;
revoke all on function public.file_trust_appeal(text, uuid) from public, anon, authenticated;
grant execute on function public.file_trust_appeal(text, uuid) to authenticated;

create function public.resolve_trust_appeal(p_appeal_id uuid, p_outcome text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  appeal public.trust_appeals%rowtype;
  event_time timestamptz := pg_catalog.now();
  next_status text;
begin
  if auth.uid() is null or p_outcome not in ('uphold', 'dismiss') then
    raise exception 'invalid trust appeal resolution' using errcode = '22023';
  end if;
  select source.* into appeal from public.trust_appeals source
  where source.id = p_appeal_id for update;
  if appeal.id is null
    or not (public.is_moderator(appeal.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if appeal.status <> 'open' then
    raise exception 'appeal already resolved' using errcode = '22023';
  end if;
  next_status := case when p_outcome = 'uphold' then 'upheld' else 'dismissed' end;
  update public.trust_appeals as target
  set status = next_status, resolved_at = event_time, resolved_by = auth.uid()
  where target.id = appeal.id;
  if next_status = 'upheld' and appeal.target_type = 'safety_hold' then
    update public.trust_safety_holds as hold
    set status = 'lifted', resolved_at = event_time, resolved_by = auth.uid()
    where hold.id = appeal.target_id and hold.status in ('active', 'upheld');
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), appeal.school_id, 'trust.appeal_resolved', 'trust_appeal', appeal.id,
    pg_catalog.jsonb_build_object(
      'previous_status', 'open', 'next_status', next_status, 'outcome', p_outcome
    )
  );
  return next_status;
end;
$$;
revoke all on function public.resolve_trust_appeal(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_trust_appeal(uuid, text) to authenticated;

create function public.list_my_trust_cases()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'reports', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', report.id, 'school_id', report.school_id, 'kind', report.kind,
        'status', report.status, 'swap_leg_id', report.swap_leg_id,
        'provisional_until', report.provisional_until, 'created_at', report.created_at
      ) order by report.created_at desc, report.id)
      from public.trust_incident_reports report
      where report.reporter_user_id = auth.uid() or report.subject_user_id = auth.uid()
    ), '[]'::jsonb),
    'holds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', hold.id, 'school_id', hold.school_id, 'status', hold.status,
        'placed_at', hold.placed_at, 'review_due_at', hold.review_due_at
      ) order by hold.placed_at desc, hold.id)
      from public.trust_safety_holds hold
      where hold.subject_user_id = auth.uid()
    ), '[]'::jsonb),
    'appeals', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', appeal.id, 'school_id', appeal.school_id, 'target_type', appeal.target_type,
        'status', appeal.status, 'filed_at', appeal.filed_at
      ) order by appeal.filed_at desc, appeal.id)
      from public.trust_appeals appeal
      where appeal.appellant_user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.list_my_trust_cases() from public, anon, authenticated;
grant execute on function public.list_my_trust_cases() to authenticated;

create function public.list_school_trust_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
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
    'reports', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', report.id, 'kind', report.kind, 'status', report.status,
        'subject_user_id', report.subject_user_id, 'created_at', report.created_at
      ) order by report.created_at, report.id)
      from public.trust_incident_reports report
      where report.school_id = school and report.status in ('provisional', 'disputed')
    ), '[]'::jsonb),
    'holds', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', hold.id, 'status', hold.status, 'subject_user_id', hold.subject_user_id,
        'review_due_at', hold.review_due_at
      ) order by hold.placed_at, hold.id)
      from public.trust_safety_holds hold
      where hold.school_id = school and hold.status = 'active'
    ), '[]'::jsonb),
    'appeals', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', appeal.id, 'target_type', appeal.target_type, 'status', appeal.status,
        'appellant_user_id', appeal.appellant_user_id, 'filed_at', appeal.filed_at
      ) order by appeal.filed_at, appeal.id)
      from public.trust_appeals appeal
      where appeal.school_id = school and appeal.status = 'open'
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.list_school_trust_queue() from public, anon, authenticated;
grant execute on function public.list_school_trust_queue() to authenticated;

-- ---------------------------------------------------------------------------
-- Ledger partners include no-show trip penalties
-- ---------------------------------------------------------------------------
create or replace function public.get_my_ledger()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with caller as (
    select membership.id, membership.school_id
    from public.school_memberships membership
    where membership.user_id = auth.uid() and membership.status = 'verified'
      and public.is_member(membership.school_id)
    order by membership.created_at, membership.id limit 1
  ), own_entries as (
    select entry.id, entry.school_id, entry.from_membership, entry.to_membership,
      entry.swap_leg_id, entry.trip_count_delta, entry.created_at, entry.expires_at,
      entry.reminder_due_at,
      case when entry.from_membership = caller.id
        then entry.to_membership else entry.from_membership end as partner_membership,
      entry.expires_at <= pg_catalog.statement_timestamp() as is_expired,
      case when entry.from_membership = caller.id
        then entry.trip_count_delta else -entry.trip_count_delta end as directed_count
    from public.swap_ledger_entries entry
    join caller on caller.school_id = entry.school_id
      and caller.id in (entry.from_membership, entry.to_membership)
    union all
    select penalty.id, penalty.school_id, penalty.from_membership, penalty.to_membership,
      report.swap_leg_id, penalty.trip_count_delta::integer, penalty.created_at, penalty.expires_at,
      penalty.created_at + interval '1008 hours',
      case when penalty.from_membership = caller.id
        then penalty.to_membership else penalty.from_membership end as partner_membership,
      penalty.expires_at <= pg_catalog.statement_timestamp() as is_expired,
      case when penalty.from_membership = caller.id
        then penalty.trip_count_delta else -penalty.trip_count_delta end as directed_count
    from public.trust_trip_penalties penalty
    join public.trust_incident_reports report on report.id = penalty.report_id
    join caller on caller.school_id = penalty.school_id
      and caller.id in (penalty.from_membership, penalty.to_membership)
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
      'trips_i_owe', case when net_count > 0 then net_count else 0 end,
      'trips_owed_to_me', case when net_count < 0 then -net_count else 0 end
    ) order by partner_membership) from netted), '[]'::jsonb)
  );
$$;
revoke all on function public.get_my_ledger() from public, anon, authenticated;
grant execute on function public.get_my_ledger() to authenticated;

-- ---------------------------------------------------------------------------
-- Swap-only disable: match / propose / accept
-- ---------------------------------------------------------------------------
create or replace function public.get_reciprocal_match_candidates(p_allow_different_date boolean default false)
returns table (
  viewer_need_instance_id uuid, candidate_help_instance_id uuid,
  candidate_need_instance_id uuid, viewer_help_instance_id uuid,
  candidate_id uuid, candidate_name text, trust_band text, area_label text,
  first_date date, reciprocal_date date, time_overlap_minutes integer,
  reciprocal_overlap_minutes integer, same_area boolean
)
language sql
security definer
set search_path = pg_catalog
as $$
  with mine as (
    select membership.school_id from public.school_memberships membership
    where membership.user_id = auth.uid() and membership.status = 'verified'
      and public.is_member(membership.school_id)
      and not public.user_has_active_safety_hold(auth.uid(), membership.school_id)
    order by membership.created_at limit 1
  ), config as (
    select school_config.* from public.school_configs school_config
    join mine on mine.school_id = school_config.school_id
  )
  select a_need.id, b_help.id, b_need.id, a_help.id,
    b_help.owner_id, candidate.display_name, public.trust_band_for_score(candidate.trust_score),
    b_help.area_label, a_need.service_date, b_need.service_date,
    greatest(0, (extract(epoch from (least(a_need.window_end, b_help.window_end)
      - greatest(a_need.window_start, b_help.window_start)))::int / 60)),
    greatest(0, (extract(epoch from (least(b_need.window_end, a_help.window_end)
      - greatest(b_need.window_start, a_help.window_start)))::int / 60)),
    lower(a_need.area_label) = lower(b_help.area_label)
  from mine join config on true
  join public.availability_instances a_need on a_need.school_id = mine.school_id
    and a_need.owner_id = auth.uid() and a_need.intent = 'need_help' and a_need.status = 'open'
    and a_need.service_date >= public.school_local_today(mine.school_id)
  join public.availability_instances b_help on b_help.school_id = mine.school_id
    and b_help.owner_id <> auth.uid() and b_help.intent = 'can_help' and b_help.status = 'open'
    and b_help.direction = a_need.direction and b_help.service_date = a_need.service_date
  join public.availability_instances b_need on b_need.school_id = mine.school_id
    and b_need.owner_id = b_help.owner_id and b_need.intent = 'need_help' and b_need.status = 'open'
    and b_need.direction = a_need.direction
  join public.availability_instances a_help on a_help.school_id = mine.school_id
    and a_help.owner_id = auth.uid() and a_help.intent = 'can_help' and a_help.status = 'open'
    and a_help.direction = b_need.direction and a_help.service_date = b_need.service_date
  join public.profiles candidate on candidate.id = b_help.owner_id
  join public.school_memberships candidate_membership
    on candidate_membership.school_id = mine.school_id
    and candidate_membership.user_id = b_help.owner_id
    and candidate_membership.status = 'verified'
  where not candidate.admin_suspended
    and not public.user_has_active_safety_hold(b_help.owner_id, mine.school_id)
    and public.trust_band_for_score(candidate.trust_score) <> 'Suspended'
    and b_need.service_date >= public.school_local_today(mine.school_id)
    and a_help.service_date >= public.school_local_today(mine.school_id)
    and abs(extract(epoch from (a_need.window_start - b_help.window_start)))
      <= config.matching_window_minutes * 60
    and abs(extract(epoch from (b_need.window_start - a_help.window_start)))
      <= config.matching_window_minutes * 60
    and (not p_allow_different_date or config.allow_different_date_reciprocity)
    and (p_allow_different_date or not config.strict_reciprocity_default
      or b_need.service_date = a_need.service_date)
    and (not p_allow_different_date
      or abs(b_need.service_date - a_need.service_date) <= config.reciprocal_window_days)
    and not public.is_same_household(auth.uid(), b_help.owner_id)
    and not exists (
      select 1 from public.match_blocks block
      where block.school_id = mine.school_id
        and ((block.blocker_id = auth.uid() and block.blocked_id = b_help.owner_id)
          or (block.blocker_id = b_help.owner_id and block.blocked_id = auth.uid()))
    )
    and not exists (
      select 1 from public.swap_legs trip
      join public.swap_proposals proposal on proposal.id = trip.swap_id
      where proposal.status in ('proposed', 'accepted')
        and (trip.requester_instance_id in (a_need.id, b_need.id)
          or trip.helper_instance_id in (a_help.id, b_help.id))
    )
  order by (lower(a_need.area_label) = lower(b_help.area_label)) desc,
    (greatest(0, (extract(epoch from (least(a_need.window_end, b_help.window_end)
      - greatest(a_need.window_start, b_help.window_start)))::int / 60))
     + greatest(0, (extract(epoch from (least(b_need.window_end, a_help.window_end)
      - greatest(b_need.window_start, a_help.window_start)))::int / 60))) desc,
    case public.trust_band_for_score(candidate.trust_score)
      when 'Trusted' then 4 when 'Standard' then 3 when 'Caution' then 2 else 1 end desc,
    b_help.service_date asc
$$;
revoke all on function public.get_reciprocal_match_candidates(boolean)
  from public, anon, authenticated;
grant execute on function public.get_reciprocal_match_candidates(boolean) to authenticated;

create or replace function public.transition_swap_proposal(p_swap uuid, p_action text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  swap public.swap_proposals%rowtype;
  next_status text;
  leg record;
begin
  if auth.uid() is null or p_action not in ('accept', 'decline', 'withdraw') then
    raise exception 'invalid swap action' using errcode = '22023';
  end if;
  select source.* into swap from public.swap_proposals source where source.id = p_swap for update;
  if swap.id is null or not public.is_member(swap.school_id) then
    raise exception 'swap is unavailable' using errcode = '42501';
  end if;
  if public.user_has_active_safety_hold(auth.uid(), swap.school_id)
    or public.user_has_active_safety_hold(swap.proposer_id, swap.school_id)
    or public.user_has_active_safety_hold(swap.recipient_id, swap.school_id) then
    raise exception 'safety hold disables swaps' using errcode = '42501';
  end if;
  if swap.status = 'proposed' and swap.expires_at <= pg_catalog.now() then
    update public.swap_proposals as proposal
    set status = 'expired', updated_at = pg_catalog.now()
    where proposal.id = swap.id;
    return 'expired';
  end if;
  if p_action = 'accept' and swap.recipient_id = auth.uid() and swap.status = 'proposed' then
    for leg in
      select
        trip.*,
        helper.status as helper_status,
        requester.status as requester_status,
        helper.service_date as helper_date,
        requester.service_date as requester_date
      from public.swap_legs trip
      join public.availability_instances helper on helper.id = trip.helper_instance_id
      join public.availability_instances requester on requester.id = trip.requester_instance_id
      where trip.swap_id = swap.id
      for update of trip
    loop
      if leg.helper_status <> 'open' or leg.requester_status <> 'open'
        or leg.helper_date < public.school_local_today(swap.school_id)
        or leg.requester_date < public.school_local_today(swap.school_id) then
        raise exception 'swap leg is unavailable' using errcode = '42501';
      end if;
    end loop;
    if exists (
      select 1 from public.match_blocks block
      where block.school_id = swap.school_id
        and (
          (block.blocker_id = swap.proposer_id and block.blocked_id = swap.recipient_id)
          or (block.blocker_id = swap.recipient_id and block.blocked_id = swap.proposer_id)
        )
    ) then
      raise exception 'swap is blocked' using errcode = '42501';
    end if;
    next_status := 'accepted';
  elsif p_action = 'decline' and swap.recipient_id = auth.uid() and swap.status = 'proposed' then
    next_status := 'declined';
  elsif p_action = 'withdraw' and swap.proposer_id = auth.uid() and swap.status = 'proposed' then
    next_status := 'withdrawn';
  else
    raise exception 'swap transition is unavailable' using errcode = '42501';
  end if;
  update public.swap_proposals as proposal
  set
    status = next_status,
    accepted_at = case when next_status = 'accepted' then pg_catalog.now() else null end,
    updated_at = pg_catalog.now()
  where proposal.id = swap.id;
  if next_status = 'accepted'
    and not exists (
      select 1 from public.analytics_events event
      where event.actor_id = auth.uid() and event.event_name = 'first_swap_accepted'
    ) then
    insert into public.analytics_events (actor_id, school_id, event_name)
    values (auth.uid(), swap.school_id, 'first_swap_accepted');
  end if;
  if next_status = 'accepted' then
    perform public.post_trust_urgent_cover_for_swap(swap.id);
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), swap.school_id, 'swap.' || next_status, 'swap_proposal', swap.id,
    pg_catalog.jsonb_build_object('outcome', next_status)
  );
  return next_status;
end;
$$;
revoke all on function public.transition_swap_proposal(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_swap_proposal(uuid, text) to authenticated;

-- Patch propose to refuse held callers/candidates without rewriting the full body.
create or replace function public.propose_reciprocal_swap(
  p_viewer_need uuid, p_candidate_help uuid, p_candidate_need uuid, p_viewer_help uuid,
  p_allow_different_date boolean default false
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  a_need public.availability_instances%rowtype;
  b_help public.availability_instances%rowtype;
  b_need public.availability_instances%rowtype;
  a_help public.availability_instances%rowtype;
  cfg public.school_configs%rowtype;
  swap_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_viewer_need::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_candidate_help::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_candidate_need::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_viewer_help::text));
  select source.* into a_need from public.availability_instances source where source.id = p_viewer_need for update;
  select source.* into b_help from public.availability_instances source where source.id = p_candidate_help for update;
  select source.* into b_need from public.availability_instances source where source.id = p_candidate_need for update;
  select source.* into a_help from public.availability_instances source where source.id = p_viewer_help for update;
  if a_need.id is null or b_help.id is null or b_need.id is null or a_help.id is null
    or a_need.owner_id <> auth.uid() or a_help.owner_id <> auth.uid()
    or a_need.school_id <> b_help.school_id or a_need.school_id <> b_need.school_id
    or a_need.school_id <> a_help.school_id
    or a_need.intent <> 'need_help' or b_help.intent <> 'can_help'
    or b_need.intent <> 'need_help' or a_help.intent <> 'can_help'
    or a_need.status <> 'open' or b_help.status <> 'open'
    or b_need.status <> 'open' or a_help.status <> 'open'
    or b_help.owner_id <> b_need.owner_id or b_help.owner_id = auth.uid()
    or not public.is_member(a_need.school_id)
    or public.user_has_active_safety_hold(auth.uid(), a_need.school_id)
    or public.user_has_active_safety_hold(b_help.owner_id, a_need.school_id)
    or not exists (
      select 1 from public.school_memberships membership
      where membership.school_id = a_need.school_id
        and membership.user_id = b_help.owner_id and membership.status = 'verified'
    )
    or a_need.service_date < public.school_local_today(a_need.school_id)
    or b_help.service_date < public.school_local_today(a_need.school_id)
    or b_need.service_date < public.school_local_today(a_need.school_id)
    or a_help.service_date < public.school_local_today(a_need.school_id)
    or public.is_same_household(auth.uid(), b_help.owner_id) then
    raise exception 'reciprocal candidate is unavailable' using errcode = '42501';
  end if;
  select source.* into cfg from public.school_configs source where source.school_id = a_need.school_id;
  if a_need.direction <> b_help.direction or b_need.direction <> a_help.direction
    or a_need.service_date <> b_help.service_date or b_need.service_date <> a_help.service_date
    or abs(extract(epoch from (a_need.window_start - b_help.window_start))) > cfg.matching_window_minutes * 60
    or abs(extract(epoch from (b_need.window_start - a_help.window_start))) > cfg.matching_window_minutes * 60
    or (cfg.strict_reciprocity_default and not p_allow_different_date
      and b_need.service_date <> a_need.service_date)
    or (p_allow_different_date and (
      not cfg.allow_different_date_reciprocity
      or abs(b_need.service_date - a_need.service_date) > cfg.reciprocal_window_days
    ))
    or exists (
      select 1 from public.match_blocks block
      where block.school_id = a_need.school_id
        and ((block.blocker_id = auth.uid() and block.blocked_id = b_help.owner_id)
          or (block.blocker_id = b_help.owner_id and block.blocked_id = auth.uid()))
    )
    or exists (
      select 1 from public.swap_legs trip
      join public.swap_proposals proposal on proposal.id = trip.swap_id
      where proposal.status in ('proposed', 'accepted')
        and (trip.requester_instance_id in (a_need.id, b_need.id)
          or trip.helper_instance_id in (a_help.id, b_help.id))
    ) then
    raise exception 'reciprocal candidate is unavailable' using errcode = '42501';
  end if;
  insert into public.swap_proposals
    (school_id, proposer_id, recipient_id, status, proposed_at, expires_at)
  values (
    a_need.school_id, auth.uid(), b_help.owner_id, 'proposed', pg_catalog.now(),
    pg_catalog.now() + interval '48 hours'
  )
  returning id into swap_id;
  insert into public.swap_legs
    (swap_id, school_id, helper_instance_id, requester_instance_id, helper_id, requester_id, service_date)
  values
    (swap_id, a_need.school_id, b_help.id, a_need.id, b_help.owner_id, auth.uid(), a_need.service_date),
    (swap_id, a_need.school_id, a_help.id, b_need.id, auth.uid(), b_help.owner_id, b_need.service_date);
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), a_need.school_id, 'swap.proposed', 'swap_proposal', swap_id,
    pg_catalog.jsonb_build_object('outcome', 'proposed')
  );
  return swap_id;
end;
$$;
revoke all on function public.propose_reciprocal_swap(uuid, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.propose_reciprocal_swap(uuid, uuid, uuid, uuid, boolean)
  to authenticated;

commit;
