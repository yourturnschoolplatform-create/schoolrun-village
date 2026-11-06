-- Failed invite-code checks must keep the attempt row. Raising after the insert
-- rolled the attempt back, so the five-attempt limit never accumulated.
begin;
set local search_path = pg_catalog;

create or replace function public.redeem_school_invite_code(p_school_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  matching_code_id uuid;
  existing_status public.school_membership_status;
begin
  if auth.uid() is null or not public.is_verified_email_user() then
    raise exception 'verified email required' using errcode = '42501';
  end if;
  if not public.has_current_onboarding_consents(auth.uid()) then
    raise exception 'current Terms, Privacy and Community Safety consent required' using errcode = '42501';
  end if;
  if char_length(trim(p_code)) < 6 or char_length(trim(p_code)) > 128 then
    raise exception 'invalid invite code' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  select status into existing_status from public.school_memberships
  where school_id = p_school_id and user_id = auth.uid() for update;
  if existing_status = 'verified' then return 'already_verified'; end if;
  if existing_status = 'suspended' then raise exception 'membership is suspended' using errcode = '42501'; end if;

  if (select count(*) from public.school_invite_attempts where user_id = auth.uid() and attempted_at > now() - interval '15 minutes') >= 5 then
    raise exception 'invite attempts rate limited' using errcode = 'P0001';
  end if;
  insert into public.school_invite_attempts (user_id) values (auth.uid());
  select code.id into matching_code_id
  from public.school_invite_codes code
  where code.school_id = p_school_id
    and code.is_active
    and code.expires_at > now()
    and code.use_count < code.max_uses
    and extensions.crypt(trim(p_code), code.code_hash) = code.code_hash
  for update;
  if matching_code_id is null then return 'invalid'; end if;

  update public.school_invite_codes set use_count = use_count + 1 where id = matching_code_id;
  insert into public.school_memberships (school_id, user_id, status, verified_email_at, invite_code_verified_at)
  values (p_school_id, auth.uid(), 'pending', now(), now())
  on conflict (school_id, user_id) do update
  set status = 'pending', verified_email_at = now(), invite_code_verified_at = now(), updated_at = now();
  insert into public.analytics_events (actor_id, school_id, event_name) values (auth.uid(), p_school_id, 'school_joined');
  insert into public.audit_logs (actor_id, school_id, action, entity_type, payload)
  values (auth.uid(), p_school_id, 'membership.invite_code_redeemed', 'school_membership', jsonb_build_object('source', 'invite_code', 'outcome', 'pending'));
  return 'pending';
end;
$$;

revoke all on function public.redeem_school_invite_code(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_school_invite_code(uuid, text) to authenticated;

commit;
