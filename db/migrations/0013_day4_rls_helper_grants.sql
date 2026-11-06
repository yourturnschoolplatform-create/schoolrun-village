begin;
-- These helpers are referenced inside RLS policies; authenticated needs EXECUTE for policy evaluation.
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_moderator(uuid) to authenticated;
grant execute on function public.is_same_household(uuid,uuid) to authenticated;
grant execute on function public.is_approved_school_member(uuid) to authenticated;
grant execute on function public.has_current_onboarding_consents(uuid) to authenticated;
grant execute on function public.is_verified_email_user() to authenticated;
grant execute on function public.school_local_today(uuid) to authenticated;
commit;
