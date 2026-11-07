-- Task 6.1 fix: least/greatest are not schema-qualifiable under pg_catalog-only search_path.
-- Clamp with CASE so the posting engine resolves without pg_catalog.least/greatest.
begin;
set local search_path = pg_catalog;

create or replace function public.apply_trust_score_delta(
  p_subject_user_id uuid,
  p_school_id uuid,
  p_delta smallint,
  p_reason_code text,
  p_source_entity_type text,
  p_source_entity_id uuid
) returns smallint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_score smallint;
  next_score smallint;
  policy_version integer;
  raw_score integer;
begin
  if p_subject_user_id is null or p_school_id is null or p_delta is null or p_delta = 0 then
    raise exception 'trust score delta is invalid' using errcode = '22023';
  end if;
  if p_reason_code is null or p_source_entity_type is null or p_source_entity_id is null then
    raise exception 'trust score delta is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = p_school_id
      and membership.user_id = p_subject_user_id
      and membership.status = 'verified'
  ) then
    raise exception 'verified school membership required for trust scoring' using errcode = '42501';
  end if;
  select version into policy_version
  from public.trust_policy_versions
  where is_published and (school_id = p_school_id or school_id is null)
  order by case when school_id = p_school_id then 0 else 1 end, version desc
  limit 1;

  select profile.trust_score into current_score
  from public.profiles profile
  where profile.id = p_subject_user_id
  for update;
  if current_score is null then
    raise exception 'profile required for trust scoring' using errcode = 'P0002';
  end if;
  raw_score := current_score::integer + p_delta::integer;
  next_score := case
    when raw_score > 150 then 150::smallint
    when raw_score < -100 then (-100)::smallint
    else raw_score::smallint
  end;

  insert into public.trust_score_events (
    school_id, subject_user_id, delta, score_after, reason_code,
    source_entity_type, source_entity_id, policy_version
  ) values (
    p_school_id, p_subject_user_id, p_delta, next_score, p_reason_code,
    p_source_entity_type, p_source_entity_id, policy_version
  )
  on conflict (source_entity_type, source_entity_id, reason_code) do nothing;
  if not found then
    select profile.trust_score into next_score
    from public.profiles profile
    where profile.id = p_subject_user_id;
    return next_score;
  end if;

  update public.profiles as profile
  set trust_score = next_score, updated_at = pg_catalog.now()
  where profile.id = p_subject_user_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), p_school_id, 'trust.score_adjusted', 'profile', p_subject_user_id,
    pg_catalog.jsonb_build_object(
      'reason_code', p_reason_code,
      'delta', p_delta,
      'score_after', next_score,
      'source_entity_type', p_source_entity_type
    )
  );
  return next_score;
end;
$$;
revoke all on function public.apply_trust_score_delta(uuid, uuid, smallint, text, text, uuid)
  from public, anon, authenticated;

commit;
