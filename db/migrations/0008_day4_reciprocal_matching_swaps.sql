-- YourTurn Day 4: privacy-preserving reciprocal matching and two-party swaps.
-- No price, amount, score disclosure, address, contact, map, or route fields.

begin;

create table if not exists public.match_blocks (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (blocker_id <> blocked_id),
  unique (school_id, blocker_id, blocked_id)
);

create table if not exists public.swap_proposals (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  proposer_id uuid not null references public.profiles(id) on delete restrict,
  recipient_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'declined', 'withdrawn', 'expired')),
  proposed_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null default now() + interval '48 hours',
  updated_at timestamptz not null default now(),
  check (proposer_id <> recipient_id),
  check (expires_at > proposed_at),
  check ((status = 'accepted') = (accepted_at is not null))
);
create index if not exists swap_proposals_participant_idx on public.swap_proposals (school_id, proposer_id, recipient_id, status);

-- Exactly two reciprocal legs per proposal: each records helper and requester
-- instances only, never an address, child, price, or trust score.
create table if not exists public.swap_legs (
  id uuid primary key default gen_random_uuid(),
  swap_id uuid not null references public.swap_proposals(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete restrict,
  helper_instance_id uuid not null references public.availability_instances(id) on delete restrict,
  requester_instance_id uuid not null references public.availability_instances(id) on delete restrict,
  helper_id uuid not null references public.profiles(id) on delete restrict,
  requester_id uuid not null references public.profiles(id) on delete restrict,
  service_date date not null,
  created_at timestamptz not null default now(),
  check (helper_id <> requester_id),
  check (helper_instance_id <> requester_instance_id),
  unique (swap_id, helper_instance_id),
  unique (swap_id, requester_instance_id)
);
create index if not exists swap_legs_instance_idx on public.swap_legs (helper_instance_id, requester_instance_id);

create or replace function public.trust_band_for_score(score smallint)
returns text language sql immutable set search_path = public as $$
  select case when score >= 85 then 'Trusted' when score >= 60 then 'Standard'
    when score >= 40 then 'Caution' when score >= 20 then 'Restricted' else 'Suspended' end
$$;

create or replace function public.expire_my_swap_proposals()
returns integer language plpgsql security definer set search_path = public as $$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  update public.swap_proposals set status = 'expired', updated_at = now()
  where status = 'proposed' and expires_at <= now() and (proposer_id = auth.uid() or recipient_id = auth.uid());
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- Candidate output is deliberately bounded to display name, band, coarse area,
-- overlap and four instance IDs required for an audited proposal command.
create or replace function public.get_reciprocal_match_candidates(p_allow_different_date boolean default false)
returns table (
  viewer_need_instance_id uuid, candidate_help_instance_id uuid,
  candidate_need_instance_id uuid, viewer_help_instance_id uuid,
  candidate_id uuid, candidate_name text, trust_band text, area_label text,
  first_date date, reciprocal_date date, time_overlap_minutes integer,
  reciprocal_overlap_minutes integer, same_area boolean
)
language sql security definer set search_path = public as $$
  with mine as (
    select m.school_id from public.school_memberships m
    where m.user_id = auth.uid() and m.status = 'verified' and public.is_member(m.school_id)
    order by m.created_at limit 1
  ), config as (
    select c.* from public.school_configs c join mine on mine.school_id = c.school_id
  )
  select a_need.id, b_help.id, b_need.id, a_help.id,
    b_help.owner_id, candidate.display_name, public.trust_band_for_score(candidate.trust_score),
    b_help.area_label, a_need.service_date, b_need.service_date,
    greatest(0, extract(epoch from (least(a_need.window_end, b_help.window_end) - greatest(a_need.window_start, b_help.window_start)))::int / 60),
    greatest(0, extract(epoch from (least(b_need.window_end, a_help.window_end) - greatest(b_need.window_start, a_help.window_start)))::int / 60),
    lower(a_need.area_label) = lower(b_help.area_label)
  from mine join config on true
  join public.availability_instances a_need on a_need.school_id = mine.school_id and a_need.owner_id = auth.uid() and a_need.intent = 'need_help' and a_need.status = 'open' and a_need.service_date >= public.school_local_today(mine.school_id)
  join public.availability_instances b_help on b_help.school_id = mine.school_id and b_help.owner_id <> auth.uid() and b_help.intent = 'can_help' and b_help.status = 'open' and b_help.direction = a_need.direction and b_help.service_date = a_need.service_date
  join public.availability_instances b_need on b_need.school_id = mine.school_id and b_need.owner_id = b_help.owner_id and b_need.intent = 'need_help' and b_need.status = 'open' and b_need.direction = a_need.direction
  join public.availability_instances a_help on a_help.school_id = mine.school_id and a_help.owner_id = auth.uid() and a_help.intent = 'can_help' and a_help.status = 'open' and a_help.direction = b_need.direction and a_help.service_date = b_need.service_date
  join public.profiles candidate on candidate.id = b_help.owner_id
  join public.school_memberships candidate_membership on candidate_membership.school_id = mine.school_id and candidate_membership.user_id = b_help.owner_id and candidate_membership.status = 'verified'
  where not candidate.admin_suspended
    and public.trust_band_for_score(candidate.trust_score) <> 'Suspended'
    and b_need.service_date >= public.school_local_today(mine.school_id)
    and a_help.service_date >= public.school_local_today(mine.school_id)
    and abs(extract(epoch from (a_need.window_start - b_help.window_start))) <= config.matching_window_minutes * 60
    and abs(extract(epoch from (b_need.window_start - a_help.window_start))) <= config.matching_window_minutes * 60
    and (not p_allow_different_date or config.allow_different_date_reciprocity)
    and (p_allow_different_date or not config.strict_reciprocity_default or b_need.service_date = a_need.service_date)
    and (not p_allow_different_date or abs(b_need.service_date - a_need.service_date) <= config.reciprocal_window_days)
    and not public.is_same_household(auth.uid(), b_help.owner_id)
    and not exists (select 1 from public.match_blocks block where block.school_id = mine.school_id and ((block.blocker_id = auth.uid() and block.blocked_id = b_help.owner_id) or (block.blocker_id = b_help.owner_id and block.blocked_id = auth.uid())))
    and not exists (select 1 from public.swap_legs l join public.swap_proposals s on s.id = l.swap_id where s.status in ('proposed','accepted') and (l.requester_instance_id in (a_need.id, b_need.id) or (l.helper_instance_id in (a_help.id, b_help.id))))
  order by (lower(a_need.area_label) = lower(b_help.area_label)) desc,
    (greatest(0, extract(epoch from (least(a_need.window_end, b_help.window_end) - greatest(a_need.window_start, b_help.window_start)))::int / 60)
     + greatest(0, extract(epoch from (least(b_need.window_end, a_help.window_end) - greatest(b_need.window_start, a_help.window_start)))::int / 60)) desc,
    case public.trust_band_for_score(candidate.trust_score) when 'Trusted' then 4 when 'Standard' then 3 when 'Caution' then 2 else 1 end desc,
    b_help.service_date asc
$$;

create or replace function public.propose_reciprocal_swap(p_viewer_need uuid, p_candidate_help uuid, p_candidate_need uuid, p_viewer_help uuid, p_allow_different_date boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare a_need public.availability_instances%rowtype; declare b_help public.availability_instances%rowtype;
declare b_need public.availability_instances%rowtype; declare a_help public.availability_instances%rowtype;
declare cfg public.school_configs%rowtype; declare swap_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext(p_viewer_need::text));
  perform pg_advisory_xact_lock(hashtext(p_candidate_help::text));
  perform pg_advisory_xact_lock(hashtext(p_candidate_need::text));
  perform pg_advisory_xact_lock(hashtext(p_viewer_help::text));
  select * into a_need from public.availability_instances where id=p_viewer_need for update;
  select * into b_help from public.availability_instances where id=p_candidate_help for update;
  select * into b_need from public.availability_instances where id=p_candidate_need for update;
  select * into a_help from public.availability_instances where id=p_viewer_help for update;
  if a_need.id is null or b_help.id is null or b_need.id is null or a_help.id is null
    or a_need.owner_id <> auth.uid() or a_help.owner_id <> auth.uid()
    or a_need.school_id <> b_help.school_id or a_need.school_id <> b_need.school_id or a_need.school_id <> a_help.school_id
    or a_need.intent <> 'need_help' or b_help.intent <> 'can_help' or b_need.intent <> 'need_help' or a_help.intent <> 'can_help'
    or a_need.status <> 'open' or b_help.status <> 'open' or b_need.status <> 'open' or a_help.status <> 'open'
    or b_help.owner_id <> b_need.owner_id or b_help.owner_id = auth.uid() or not public.is_member(a_need.school_id)
    or not exists(select 1 from public.school_memberships membership where membership.school_id=a_need.school_id and membership.user_id=b_help.owner_id and membership.status='verified')
    or a_need.service_date < public.school_local_today(a_need.school_id) or b_help.service_date < public.school_local_today(a_need.school_id) or b_need.service_date < public.school_local_today(a_need.school_id) or a_help.service_date < public.school_local_today(a_need.school_id)
    or public.is_same_household(auth.uid(), b_help.owner_id) then raise exception 'reciprocal candidate is unavailable' using errcode='42501'; end if;
  select * into cfg from public.school_configs where school_id=a_need.school_id;
  if a_need.direction <> b_help.direction or b_need.direction <> a_help.direction or a_need.service_date <> b_help.service_date or b_need.service_date <> a_help.service_date
    or abs(extract(epoch from (a_need.window_start-b_help.window_start))) > cfg.matching_window_minutes*60
    or abs(extract(epoch from (b_need.window_start-a_help.window_start))) > cfg.matching_window_minutes*60
    or (cfg.strict_reciprocity_default and not p_allow_different_date and b_need.service_date <> a_need.service_date)
    or (p_allow_different_date and not cfg.allow_different_date_reciprocity)
    or abs(b_need.service_date-a_need.service_date) > cfg.reciprocal_window_days
    or exists (select 1 from public.match_blocks block where block.school_id=a_need.school_id and ((block.blocker_id=auth.uid() and block.blocked_id=b_help.owner_id) or (block.blocker_id=b_help.owner_id and block.blocked_id=auth.uid())))
    or exists (select 1 from public.swap_legs l join public.swap_proposals s on s.id=l.swap_id where s.status in ('proposed','accepted') and (l.requester_instance_id in (a_need.id,b_need.id) or l.helper_instance_id in (a_help.id,b_help.id)))
  then raise exception 'reciprocal candidate is unavailable' using errcode='42501'; end if;
  insert into public.swap_proposals (school_id, proposer_id, recipient_id) values (a_need.school_id, auth.uid(), b_help.owner_id) returning id into swap_id;
  insert into public.swap_legs (swap_id,school_id,helper_instance_id,requester_instance_id,helper_id,requester_id,service_date) values
    (swap_id,a_need.school_id,b_help.id,a_need.id,b_help.owner_id,auth.uid(),a_need.service_date),
    (swap_id,a_need.school_id,a_help.id,b_need.id,auth.uid(),b_help.owner_id,b_need.service_date);
  insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload) values (auth.uid(),a_need.school_id,'swap.proposed','swap_proposal',swap_id,jsonb_build_object('outcome','proposed'));
  return swap_id;
end;
$$;

create or replace function public.transition_swap_proposal(p_swap uuid, p_action text)
returns text language plpgsql security definer set search_path = public as $$
declare swap public.swap_proposals%rowtype; declare next_status text;
begin
  if auth.uid() is null or p_action not in ('accept','decline','withdraw') then raise exception 'invalid swap action' using errcode='22023'; end if;
  select * into swap from public.swap_proposals where id=p_swap for update;
  if swap.id is null or not public.is_member(swap.school_id) then raise exception 'swap is unavailable' using errcode='42501'; end if;
  if swap.status='proposed' and swap.expires_at <= now() then update public.swap_proposals set status='expired',updated_at=now() where id=swap.id; return 'expired'; end if;
  if p_action='accept' and swap.recipient_id=auth.uid() and swap.status='proposed' then next_status:='accepted';
  elsif p_action='decline' and swap.recipient_id=auth.uid() and swap.status='proposed' then next_status:='declined';
  elsif p_action='withdraw' and swap.proposer_id=auth.uid() and swap.status='proposed' then next_status:='withdrawn';
  else raise exception 'swap transition is unavailable' using errcode='42501'; end if;
  update public.swap_proposals set status=next_status,accepted_at=case when next_status='accepted' then now() else null end,updated_at=now() where id=swap.id;
  if next_status='accepted' and not exists(select 1 from public.analytics_events where actor_id=auth.uid() and event_name='first_swap_accepted') then insert into public.analytics_events(actor_id,school_id,event_name) values(auth.uid(),swap.school_id,'first_swap_accepted'); end if;
  insert into public.audit_logs(actor_id,school_id,action,entity_type,entity_id,payload) values(auth.uid(),swap.school_id,'swap.'||next_status,'swap_proposal',swap.id,jsonb_build_object('outcome',next_status));
  return next_status;
end;
$$;

create or replace function public.list_my_swaps()
returns jsonb language sql security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'status',s.status,'isIncoming',s.recipient_id=auth.uid(),'partnerName',p.display_name,'expiresAt',s.expires_at,'acceptedAt',s.accepted_at,'schoolId',s.school_id) order by s.proposed_at desc),'[]'::jsonb)
  from public.swap_proposals s join public.profiles p on p.id=case when s.proposer_id=auth.uid() then s.recipient_id else s.proposer_id end
  where (s.proposer_id=auth.uid() or s.recipient_id=auth.uid()) and public.is_member(s.school_id)
$$;

create or replace function public.get_accepted_swap_children(p_swap uuid)
returns jsonb language sql security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('nickname',c.nickname,'yearLevel',c.year_level) order by c.nickname),'[]'::jsonb)
  from public.swap_proposals s join public.swap_legs l on l.swap_id=s.id
  join public.child_profiles c on c.parent_id=l.requester_id
  join public.school_memberships m on m.id=c.membership_id and m.school_id=s.school_id
  where s.id=p_swap and s.status='accepted' and (s.proposer_id=auth.uid() or s.recipient_id=auth.uid()) and public.is_member(s.school_id)
$$;

alter table public.match_blocks enable row level security;
alter table public.swap_proposals enable row level security;
alter table public.swap_legs enable row level security;
create policy match_blocks_select_owner on public.match_blocks for select to authenticated using (blocker_id=auth.uid() and public.is_member(school_id));
create policy swaps_select_participant on public.swap_proposals for select to authenticated using ((proposer_id=auth.uid() or recipient_id=auth.uid()) and public.is_member(school_id));
create policy swap_legs_select_participant on public.swap_legs for select to authenticated using (exists(select 1 from public.swap_proposals s where s.id=swap_id and (s.proposer_id=auth.uid() or s.recipient_id=auth.uid()) and public.is_member(s.school_id)));
revoke all on public.match_blocks,public.swap_proposals,public.swap_legs from anon,authenticated;
grant select on public.match_blocks,public.swap_proposals,public.swap_legs to authenticated;
revoke all on function public.get_reciprocal_match_candidates(boolean),public.propose_reciprocal_swap(uuid,uuid,uuid,uuid,boolean),public.transition_swap_proposal(uuid,text),public.list_my_swaps(),public.get_accepted_swap_children(uuid),public.expire_my_swap_proposals() from public;
grant execute on function public.get_reciprocal_match_candidates(boolean),public.propose_reciprocal_swap(uuid,uuid,uuid,uuid,boolean),public.transition_swap_proposal(uuid,text),public.list_my_swaps(),public.get_accepted_swap_children(uuid),public.expire_my_swap_proposals() to authenticated;

alter table public.analytics_events drop constraint if exists analytics_events_allowed_name_check;
alter table public.analytics_events add constraint analytics_events_allowed_name_check check (event_name in ('signed_up','email_verified','school_joined','approved','child_added','declaration_signed','invite_sent','invite_joined','first_listing_created','first_match_viewed','first_swap_accepted'));
create unique index if not exists analytics_first_match_once_idx on public.analytics_events(actor_id,event_name) where event_name='first_match_viewed';
create unique index if not exists analytics_first_swap_accept_once_idx on public.analytics_events(actor_id,event_name) where event_name='first_swap_accepted';

commit;
