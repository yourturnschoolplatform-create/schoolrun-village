-- Commit Day 2 enum values before any constraint, index, policy or function uses them.
begin;
alter type public.assignment_role add value if not exists 'parent';
alter type public.school_membership_status add value if not exists 'pending';
commit;
