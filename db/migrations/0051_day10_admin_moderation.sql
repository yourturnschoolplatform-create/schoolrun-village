-- Task 10.3: global-admin console mutations and read models with append-only
-- audit via public.audit_logs. Uses existing public.is_admin() (role_assignments),
-- not email hardcoding. Does not invent a parallel membership or audit table.
-- No amount, price, currency, payment, phone, photo, nickname or live location.
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Internal admin gate (global role only; school moderators denied)
-- ---------------------------------------------------------------------------
create function public.admin_require()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'administrator role required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.admin_require() from public, anon, authenticated;

create function public.admin_reason_code_is_valid(p_reason_code text)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog
as $$
  select p_reason_code is not null
    and p_reason_code ~ '^[a-z][a-z0-9_]{2,60}$';
$$;
revoke all on function public.admin_reason_code_is_valid(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read models (no phones, nicknames, emails, or money fields)
-- ---------------------------------------------------------------------------
create function public.list_admin_safety_holds()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  perform public.admin_require();
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', hold.id,
    'school_id', hold.school_id,
    'subject_user_id', hold.subject_user_id,
    'status', hold.status,
    'reason_code', hold.reason_code,
    'placed_at', hold.placed_at,
    'review_due_at', hold.review_due_at,
    'resolved_at', hold.resolved_at
  ) order by hold.placed_at desc), '[]'::jsonb)
  into result
  from public.trust_safety_holds hold
  where hold.status = 'active';
  return result;
end;
$$;
revoke all on function public.list_admin_safety_holds()
  from public, anon, authenticated;
grant execute on function public.list_admin_safety_holds() to authenticated;

create function public.list_admin_suspended_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
begin
  perform public.admin_require();
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', profile.id,
    'admin_suspended', profile.admin_suspended,
    'updated_at', profile.updated_at
  ) order by profile.updated_at desc), '[]'::jsonb)
  into result
  from public.profiles profile
  where profile.admin_suspended;
  return result;
end;
$$;
revoke all on function public.list_admin_suspended_users()
  from public, anon, authenticated;
grant execute on function public.list_admin_suspended_users() to authenticated;

create function public.list_admin_audit_actions(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  result jsonb;
  lim integer;
begin
  perform public.admin_require();
  lim := greatest(1, least(coalesce(p_limit, 50), 200));
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', entry.id,
    'actor_id', entry.actor_id,
    'school_id', entry.school_id,
    'action', entry.action,
    'entity_type', entry.entity_type,
    'entity_id', entry.entity_id,
    'occurred_at', entry.occurred_at,
    'payload', entry.payload
  ) order by entry.occurred_at desc), '[]'::jsonb)
  into result
  from (
    select source.*
    from public.audit_logs source
    where source.action like 'admin.%'
    order by source.occurred_at desc
    limit lim
  ) as entry;
  return result;
end;
$$;
revoke all on function public.list_admin_audit_actions(integer)
  from public, anon, authenticated;
grant execute on function public.list_admin_audit_actions(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Mutations: platform suspend + admin-only safety-hold resolution
-- ---------------------------------------------------------------------------
create function public.admin_suspend_user(p_user_id uuid, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  profile public.profiles%rowtype;
begin
  perform public.admin_require();
  if p_user_id is null or p_user_id = auth.uid() then
    raise exception 'admin suspend target unavailable' using errcode = '22023';
  end if;
  if not public.admin_reason_code_is_valid(p_reason_code) then
    raise exception 'admin reason_code is invalid' using errcode = '22023';
  end if;

  select source.* into profile from public.profiles source
  where source.id = p_user_id for update;
  if profile.id is null then
    raise exception 'admin suspend target unavailable' using errcode = 'P0002';
  end if;
  if profile.admin_suspended then
    return pg_catalog.jsonb_build_object(
      'user_id', profile.id,
      'admin_suspended', true,
      'outcome', 'already_suspended'
    );
  end if;

  update public.profiles as target
  set admin_suspended = true, updated_at = pg_catalog.now()
  where target.id = profile.id
  returning * into profile;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'admin.user_suspended', 'profile', profile.id,
    pg_catalog.jsonb_build_object(
      'outcome', 'suspended',
      'reason_code', p_reason_code,
      'previous_status', 'active',
      'next_status', 'suspended',
      'source', 'admin_console'
    )
  );

  return pg_catalog.jsonb_build_object(
    'user_id', profile.id,
    'admin_suspended', true,
    'outcome', 'suspended'
  );
end;
$$;
revoke all on function public.admin_suspend_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_suspend_user(uuid, text) to authenticated;

create function public.admin_unsuspend_user(p_user_id uuid, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  profile public.profiles%rowtype;
begin
  perform public.admin_require();
  if p_user_id is null then
    raise exception 'admin unsuspend target unavailable' using errcode = '22023';
  end if;
  if not public.admin_reason_code_is_valid(p_reason_code) then
    raise exception 'admin reason_code is invalid' using errcode = '22023';
  end if;

  select source.* into profile from public.profiles source
  where source.id = p_user_id for update;
  if profile.id is null then
    raise exception 'admin unsuspend target unavailable' using errcode = 'P0002';
  end if;
  if not profile.admin_suspended then
    return pg_catalog.jsonb_build_object(
      'user_id', profile.id,
      'admin_suspended', false,
      'outcome', 'already_active'
    );
  end if;

  update public.profiles as target
  set admin_suspended = false, updated_at = pg_catalog.now()
  where target.id = profile.id
  returning * into profile;

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), null, 'admin.user_unsuspended', 'profile', profile.id,
    pg_catalog.jsonb_build_object(
      'outcome', 'unsuspended',
      'reason_code', p_reason_code,
      'previous_status', 'suspended',
      'next_status', 'active',
      'source', 'admin_console'
    )
  );

  return pg_catalog.jsonb_build_object(
    'user_id', profile.id,
    'admin_suspended', false,
    'outcome', 'unsuspended'
  );
end;
$$;
revoke all on function public.admin_unsuspend_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_unsuspend_user(uuid, text) to authenticated;

-- Global-admin-only hold resolution by subject (school moderators must use
-- resolve_safety_hold). Delegates status transition to resolve_safety_hold.
create function public.admin_resolve_safety_hold(
  p_subject_user_id uuid,
  p_outcome text,
  p_reason_code text default 'admin_review'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  hold public.trust_safety_holds%rowtype;
  next_status text;
begin
  perform public.admin_require();
  if p_subject_user_id is null then
    raise exception 'safety hold subject unavailable' using errcode = '22023';
  end if;
  if p_outcome not in ('lift', 'uphold') then
    raise exception 'invalid safety hold resolution' using errcode = '22023';
  end if;
  if not public.admin_reason_code_is_valid(p_reason_code) then
    raise exception 'admin reason_code is invalid' using errcode = '22023';
  end if;

  select source.* into hold
  from public.trust_safety_holds source
  where source.subject_user_id = p_subject_user_id
    and source.status = 'active'
  order by source.placed_at desc, source.id desc
  limit 1
  for update;
  if hold.id is null then
    raise exception 'active safety hold unavailable' using errcode = 'P0002';
  end if;

  next_status := public.resolve_safety_hold(hold.id, p_outcome);

  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), hold.school_id, 'admin.safety_hold_resolved', 'trust_safety_hold', hold.id,
    pg_catalog.jsonb_build_object(
      'outcome', next_status,
      'reason_code', p_reason_code,
      'previous_status', 'active',
      'next_status', next_status,
      'source', 'admin_console'
    )
  );

  return pg_catalog.jsonb_build_object(
    'hold_id', hold.id,
    'subject_user_id', hold.subject_user_id,
    'school_id', hold.school_id,
    'outcome', next_status
  );
end;
$$;
revoke all on function public.admin_resolve_safety_hold(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_safety_hold(uuid, text, text) to authenticated;

commit;
