-- Task 7.2 remediation: revoke default PUBLIC execute on policy validator.
begin;
set local search_path = pg_catalog;

revoke all on function public.email_relay_policy_definition_is_valid(jsonb)
  from public, anon, authenticated;

commit;
