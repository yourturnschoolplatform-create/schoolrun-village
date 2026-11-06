-- Day 4 stabilisation: explicit function allowlist, fixed SECURITY DEFINER search paths.
begin;

revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema public from anon;
revoke all on public.school_invite_codes, public.school_invite_attempts, public.household_link_invitations from authenticated;
revoke all on public.audit_logs, public.trust_policy_versions from authenticated;
grant select on public.audit_logs, public.trust_policy_versions to authenticated;

-- Every SECURITY DEFINER function receives a deterministic path; function bodies
-- use public-qualified application objects and pg_catalog built-ins.
do $$ declare f record; begin
  for f in select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef loop
    execute format('alter function %s set search_path = pg_catalog, public', f.signature);
  end loop;
end $$;

-- Authenticated application RPC allowlist. Each is invoked by an Express route
-- carrying the caller JWT; no trigger/helper/admin/bootstrap function is granted.
grant execute on function public.accept_current_consent(text,integer) to authenticated;
grant execute on function public.add_onboarding_child(uuid,text,smallint) to authenticated;
grant execute on function public.approve_school_membership(uuid) to authenticated;
grant execute on function public.block_match_user(uuid) to authenticated;
grant execute on function public.cancel_availability_instance(uuid) to authenticated;
grant execute on function public.cancel_availability_pattern(uuid) to authenticated;
grant execute on function public.claim_household_link_invitation(text) to authenticated;
grant execute on function public.claim_school_invitation(text) to authenticated;
grant execute on function public.confirm_household_link(uuid) to authenticated;
grant execute on function public.create_availability_pattern(uuid,text,text,smallint,time without time zone,time without time zone,text,smallint,date) to authenticated;
grant execute on function public.create_household_link_invitation() to authenticated;
grant execute on function public.create_school_invitation(uuid) to authenticated;
grant execute on function public.expire_my_swap_proposals() to authenticated;
grant execute on function public.get_accepted_swap_children(uuid) to authenticated;
grant execute on function public.get_reciprocal_match_candidates(boolean) to authenticated;
grant execute on function public.list_my_swaps() to authenticated;
grant execute on function public.list_onboarding_school_options() to authenticated;
grant execute on function public.list_pending_school_memberships() to authenticated;
grant execute on function public.record_email_verified_event() to authenticated;
grant execute on function public.record_first_match_viewed() to authenticated;
grant execute on function public.redeem_school_invite_code(uuid,text) to authenticated;
grant execute on function public.refresh_my_availability_instances() to authenticated;
grant execute on function public.request_household_link(uuid) to authenticated;
grant execute on function public.set_school_membership_review_state(uuid,text) to authenticated;
grant execute on function public.sign_onboarding_safety_declaration(uuid,uuid) to authenticated;
grant execute on function public.transition_swap_proposal(uuid,text) to authenticated;
grant execute on function public.update_availability_pattern(uuid,text,text,smallint,time without time zone,time without time zone,text,smallint,date) to authenticated;
grant execute on function public.update_onboarding_parent_profile(text) to authenticated;

commit;
