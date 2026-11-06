begin;
revoke all on function public.propose_reciprocal_swap(uuid,uuid,uuid,uuid,boolean) from public, anon;
grant execute on function public.propose_reciprocal_swap(uuid,uuid,uuid,uuid,boolean) to authenticated;
commit;
