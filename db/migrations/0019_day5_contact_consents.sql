-- Task 5.2: no mobile number is stored in an exposed schema or log.
begin;
set local search_path = pg_catalog;

alter table public.swap_proposals drop constraint swap_proposals_status_check;
alter table public.swap_proposals drop constraint swap_proposals_check2;
alter table public.swap_proposals add column cancelled_at timestamptz;
alter table public.swap_proposals add constraint swap_proposals_status_check check (
  status in ('proposed','accepted','declined','withdrawn','expired','cancelled_consent_revoked')
);
alter table public.swap_proposals add constraint swap_proposals_acceptance_state_check check (
  (status in ('accepted','cancelled_consent_revoked')) = (accepted_at is not null)
);
alter table public.swap_proposals add constraint swap_proposals_consent_cancel_time_check check (
  (status = 'cancelled_consent_revoked') = (cancelled_at is not null)
);

create table public.contact_consents (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  swap_id uuid not null references public.swap_proposals(id),
  member uuid not null,
  consent_version integer not null check (consent_version >= 1),
  policy_version integer not null default 1 check (policy_version = 1),
  scope text not null default 'swap_partner_and_chosen_backups'
    check (scope = 'swap_partner_and_chosen_backups'),
  granted_at timestamptz not null default pg_catalog.statement_timestamp(),
  revoked_at timestamptz,
  superseded_at timestamptz,
  foreign key (member,school_id) references public.school_memberships(id,school_id),
  unique (swap_id,member,consent_version),
  unique (id,school_id),
  unique (id,member),
  check (revoked_at is null or revoked_at >= granted_at),
  check (superseded_at is null or superseded_at >= granted_at),
  check (revoked_at is null or superseded_at is null)
);
create unique index contact_consents_one_active on public.contact_consents (swap_id,member)
  where revoked_at is null and superseded_at is null;

create table public.contact_consent_backups (
  consent_id uuid not null,
  school_id uuid not null,
  backup_membership uuid not null,
  primary key (consent_id,backup_membership),
  foreign key (consent_id,school_id) references public.contact_consents(id,school_id),
  foreign key (backup_membership,school_id) references public.school_memberships(id,school_id)
);

create schema if not exists yourturn_private;
revoke all on schema yourturn_private from public,anon,authenticated;
create table yourturn_private.mobile_numbers (
  consent_id uuid primary key,
  member uuid not null,
  mobile_number text not null check (mobile_number ~ '^\+614[0-9]{8}$'),
  foreign key (consent_id,member) references public.contact_consents(id,member)
);
alter table yourturn_private.mobile_numbers enable row level security;
revoke all on table yourturn_private.mobile_numbers from public,anon,authenticated;

create table public.swap_cancellation_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  swap_id uuid not null unique references public.swap_proposals(id),
  actor_membership uuid not null,
  consent_id uuid not null,
  reason text not null default 'consent_revoked' check (reason = 'consent_revoked'),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  foreign key (actor_membership,school_id) references public.school_memberships(id,school_id),
  foreign key (consent_id,school_id) references public.contact_consents(id,school_id)
);
create table public.swap_contact_notifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  swap_id uuid not null references public.swap_proposals(id),
  recipient_membership uuid not null,
  kind text not null default 'contact_consent_revoked' check (kind = 'contact_consent_revoked'),
  message text not null default 'Contact sharing was withdrawn. This swap has ended.'
    check (message = 'Contact sharing was withdrawn. This swap has ended.'),
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique (swap_id,recipient_membership,kind),
  foreign key (recipient_membership,school_id) references public.school_memberships(id,school_id)
);

-- Trigger-only: consent facts cannot be edited. A current version can be
-- superseded or revoked once, never un-revoked. Other history is append-only.
create function public.guard_contact_history()
returns trigger language plpgsql security definer
set search_path = pg_catalog as $$
begin
  if tg_table_name = 'contact_consents' and tg_op = 'UPDATE' then
    if (new.id,new.school_id,new.swap_id,new.member,new.consent_version,
        new.policy_version,new.scope,new.granted_at)
      is not distinct from
       (old.id,old.school_id,old.swap_id,old.member,old.consent_version,
        old.policy_version,old.scope,old.granted_at)
      and old.revoked_at is null and old.superseded_at is null
      and ((new.revoked_at is not null and new.superseded_at is null)
        or (new.superseded_at is not null and new.revoked_at is null))
    then return new; end if;
  end if;
  raise exception 'contact history is immutable except one-way revocation or supersession'
    using errcode = '55000';
end;
$$;
revoke all on function public.guard_contact_history() from public,anon,authenticated;
create trigger contact_consents_history_guard before update or delete on public.contact_consents
  for each row execute function public.guard_contact_history();
create trigger contact_backups_history_guard before update or delete on public.contact_consent_backups
  for each row execute function public.guard_contact_history();
create trigger swap_cancellation_history_guard before update or delete on public.swap_cancellation_events
  for each row execute function public.guard_contact_history();
create trigger swap_contact_notification_history_guard before update or delete on public.swap_contact_notifications
  for each row execute function public.guard_contact_history();
create trigger contact_consents_truncate_guard before truncate on public.contact_consents
  for each statement execute function public.guard_contact_history();
create trigger contact_backups_truncate_guard before truncate on public.contact_consent_backups
  for each statement execute function public.guard_contact_history();
create trigger swap_cancellation_truncate_guard before truncate on public.swap_cancellation_events
  for each statement execute function public.guard_contact_history();
create trigger swap_contact_notification_truncate_guard before truncate on public.swap_contact_notifications
  for each statement execute function public.guard_contact_history();

-- No client EXECUTE: used only by the qualified definer RPCs below to check
-- another membership, not to expose an identity/status oracle.
create function public.contact_member_is_active(p_member uuid,p_school uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog as $$
  select exists (
    select 1 from public.school_memberships m
    join public.profiles p on p.id=m.user_id
    join auth.users u on u.id=m.user_id
    where m.id=p_member and m.school_id=p_school and m.status='verified'
      and not p.admin_suspended and u.email_confirmed_at is not null
      and not exists (
        select 1 from public.consent_documents d where d.is_active
          and not exists (select 1 from public.consent_acceptances a
            where a.user_id=m.user_id and a.document_id=d.id)
      )
      and exists (
        select 1 from public.safety_declarations signed
        where signed.membership_id=m.id and signed.parent_id=m.user_id
          and signed.school_id=p_school
          and signed.declaration_version_id=coalesce(
            (select v.id from public.safety_declaration_versions v
              where v.school_id=p_school and v.is_published
              order by v.published_at desc,v.id desc limit 1),
            (select v.id from public.safety_declaration_versions v
              where v.school_id is null and v.is_published
              order by v.published_at desc,v.id desc limit 1)
          )
      )
  );
$$;
revoke all on function public.contact_member_is_active(uuid,uuid) from public,anon,authenticated;

alter table public.contact_consents enable row level security;
alter table public.contact_consent_backups enable row level security;
alter table public.swap_cancellation_events enable row level security;
alter table public.swap_contact_notifications enable row level security;
revoke all on table public.contact_consents,public.contact_consent_backups,
  public.swap_cancellation_events,public.swap_contact_notifications from public,anon,authenticated;
grant select on table public.contact_consents,public.contact_consent_backups,
  public.swap_cancellation_events,public.swap_contact_notifications to authenticated;
create policy contact_consents_owner on public.contact_consents for select to authenticated using (
  public.is_member(school_id) and exists (
    select 1 from public.school_memberships m where m.id=contact_consents.member
      and m.school_id=contact_consents.school_id and m.user_id=auth.uid() and m.status='verified'
  )
);
create policy contact_consent_backups_owner on public.contact_consent_backups for select to authenticated using (
  exists (select 1 from public.contact_consents c where c.id=contact_consent_backups.consent_id)
);
create policy swap_cancellation_participant on public.swap_cancellation_events for select to authenticated using (
  public.is_member(school_id) and exists (
    select 1 from public.swap_proposals s where s.id=swap_cancellation_events.swap_id
      and s.school_id=swap_cancellation_events.school_id
      and auth.uid() in (s.proposer_id,s.recipient_id)
  )
);
create policy swap_contact_notification_recipient on public.swap_contact_notifications for select to authenticated using (
  public.is_member(school_id) and exists (
    select 1 from public.school_memberships m where m.id=swap_contact_notifications.recipient_membership
      and m.school_id=swap_contact_notifications.school_id and m.user_id=auth.uid() and m.status='verified'
  )
);

create function public.grant_contact_sharing(
  p_swap_id uuid,p_mobile_number text,p_chosen_backups uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql security definer
set search_path = pg_catalog as $$
declare
  swap public.swap_proposals%rowtype;
  caller public.school_memberships%rowtype;
  consent public.contact_consents%rowtype;
  backup uuid;
  maximum integer;
  event_time timestamptz;
begin
  if auth.uid() is null then raise exception 'contact sharing is unavailable' using errcode='42501'; end if;
  select * into swap from public.swap_proposals where id=p_swap_id for update;
  select * into caller from public.school_memberships
    where school_id=swap.school_id and user_id=auth.uid() and status='verified';
  if swap.id is null or swap.status<>'accepted' or caller.id is null
    or auth.uid() not in (swap.proposer_id,swap.recipient_id)
    or not public.is_member(swap.school_id)
    or not public.contact_member_is_active(caller.id,swap.school_id)
  then raise exception 'contact sharing is unavailable' using errcode='42501'; end if;
  if p_mobile_number is null or p_mobile_number !~ '^\+614[0-9]{8}$' then
    raise exception 'use an Australian mobile number in international format' using errcode='22023';
  end if;
  select least(c.max_backups,2) into maximum from public.school_configs c where c.school_id=swap.school_id;
  maximum := coalesce(maximum,2);
  if p_chosen_backups is null or pg_catalog.cardinality(p_chosen_backups)>maximum
    or pg_catalog.cardinality(p_chosen_backups)<>(select count(distinct b) from pg_catalog.unnest(p_chosen_backups) b)
  then raise exception 'chosen backups are unavailable' using errcode='22023'; end if;
  foreach backup in array p_chosen_backups loop
    if not public.contact_member_is_active(backup,swap.school_id) or exists (
      select 1 from public.school_memberships m where m.id=backup
        and m.user_id in (swap.proposer_id,swap.recipient_id)
    ) then raise exception 'chosen backups are unavailable' using errcode='42501'; end if;
  end loop;

  event_time := pg_catalog.clock_timestamp();
  update public.contact_consents set superseded_at=event_time
    where swap_id=swap.id and member=caller.id and revoked_at is null and superseded_at is null;
  insert into public.contact_consents (school_id,swap_id,member,consent_version,granted_at)
    values (swap.school_id,swap.id,caller.id,
      coalesce((select max(c.consent_version) from public.contact_consents c
        where c.swap_id=swap.id and c.member=caller.id),0)+1,event_time)
    returning * into consent;
  insert into public.contact_consent_backups (consent_id,school_id,backup_membership)
    select consent.id,swap.school_id,b from pg_catalog.unnest(p_chosen_backups) b;
  insert into yourturn_private.mobile_numbers (consent_id,member,mobile_number)
    values (consent.id,caller.id,p_mobile_number);
  insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload)
    values (auth.uid(),swap.school_id,'contact.consent_granted','contact_consent',consent.id,'{}'::jsonb);
  return pg_catalog.jsonb_build_object('id',consent.id,'consentVersion',consent.consent_version,
    'policyVersion',consent.policy_version,'scope',consent.scope,'grantedAt',consent.granted_at,
    'defaultContactMethod','email_relay');
end;
$$;
revoke all on function public.grant_contact_sharing(uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.grant_contact_sharing(uuid,text,uuid[]) to authenticated;

create function public.revoke_contact_sharing(p_swap_id uuid)
returns text language plpgsql security definer
set search_path = pg_catalog as $$
declare
  swap public.swap_proposals%rowtype;
  caller public.school_memberships%rowtype;
  consent public.contact_consents%rowtype;
  partner uuid;
  event_time timestamptz;
begin
  if auth.uid() is null then raise exception 'contact sharing is unavailable' using errcode='42501'; end if;
  select * into swap from public.swap_proposals where id=p_swap_id for update;
  select * into caller from public.school_memberships where user_id=auth.uid() and school_id=swap.school_id;
  -- Revocation is allowed even if this parent became suspended or their policy
  -- expired: losing onboarding access must never remove the ability to withdraw.
  if swap.id is null or caller.id is null
    or auth.uid() not in (swap.proposer_id,swap.recipient_id)
    or swap.status not in ('accepted','cancelled_consent_revoked')
  then raise exception 'contact sharing is unavailable' using errcode='42501'; end if;
  select * into consent from public.contact_consents c
    where c.swap_id=swap.id and c.member=caller.id and c.superseded_at is null
    order by c.consent_version desc limit 1;
  if consent.id is null then raise exception 'contact sharing is unavailable' using errcode='42501'; end if;
  event_time := pg_catalog.clock_timestamp();
  if consent.revoked_at is null then
    update public.contact_consents set revoked_at=event_time where id=consent.id;
    insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload)
      values (auth.uid(),swap.school_id,'contact.consent_revoked','contact_consent',consent.id,'{}'::jsonb);
  end if;
  if swap.status='accepted' then
    update public.swap_proposals set status='cancelled_consent_revoked',cancelled_at=event_time,
      updated_at=event_time where id=swap.id;
    insert into public.swap_cancellation_events (school_id,swap_id,actor_membership,consent_id,created_at)
      values (swap.school_id,swap.id,caller.id,consent.id,event_time);
    select m.id into partner from public.school_memberships m where m.school_id=swap.school_id
      and m.user_id=case when auth.uid()=swap.proposer_id then swap.recipient_id else swap.proposer_id end;
    insert into public.swap_contact_notifications (school_id,swap_id,recipient_membership,created_at)
      values (swap.school_id,swap.id,partner,event_time);
    insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload)
      values (auth.uid(),swap.school_id,'swap.cancelled_consent_revoked','swap_proposal',swap.id,'{}'::jsonb);
  end if;
  return 'cancelled_consent_revoked';
end;
$$;
revoke all on function public.revoke_contact_sharing(uuid) from public,anon,authenticated;
grant execute on function public.revoke_contact_sharing(uuid) to authenticated;

create function public.get_shared_contact(p_swap_id uuid,p_member uuid)
returns text language sql stable security definer
set search_path = pg_catalog as $$
  select mobile.mobile_number
  from public.contact_consents consent
  join public.swap_proposals swap on swap.id=consent.swap_id and swap.school_id=consent.school_id
  join public.school_memberships owner on owner.id=consent.member and owner.school_id=swap.school_id
  join public.school_memberships caller on caller.user_id=auth.uid() and caller.school_id=swap.school_id
  join yourturn_private.mobile_numbers mobile on mobile.consent_id=consent.id and mobile.member=consent.member
  where swap.id=p_swap_id and consent.member=p_member and swap.status='accepted'
    and consent.revoked_at is null and consent.superseded_at is null
    and owner.user_id in (swap.proposer_id,swap.recipient_id)
    and caller.user_id<>owner.user_id
    and public.is_member(swap.school_id)
    and public.contact_member_is_active(caller.id,swap.school_id)
    and public.contact_member_is_active(owner.id,swap.school_id)
    and (
      caller.user_id in (swap.proposer_id,swap.recipient_id)
      or exists (select 1 from public.contact_consent_backups backup
        where backup.consent_id=consent.id and backup.backup_membership=caller.id
          and backup.school_id=swap.school_id)
    )
  order by consent.consent_version desc limit 1;
$$;
revoke all on function public.get_shared_contact(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_shared_contact(uuid,uuid) to authenticated;

commit;
