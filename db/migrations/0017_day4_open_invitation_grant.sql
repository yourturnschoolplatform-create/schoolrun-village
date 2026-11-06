begin;
revoke all on function public.open_school_invitation(text) from public, anon;
grant execute on function public.open_school_invitation(text) to authenticated;
commit;
