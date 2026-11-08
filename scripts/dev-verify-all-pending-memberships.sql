-- LOCAL / manual testing (Supabase SQL Editor).
-- Satisfies school_memberships_verified_credential_check (does not drop it)
-- by filling the required credential columns, then sets status = 'verified'.
-- Also ensures parent role + active consent acceptances.
--
-- Run as-is to verify every non-suspended membership that is not already verified.
-- Optional: uncomment the WHERE filter at the bottom of the UPDATE to target one id.

begin;

update public.school_memberships as membership
set
  status = 'verified',
  verified_email_at = coalesce(membership.verified_email_at, now()),
  invite_code_verified_at = coalesce(membership.invite_code_verified_at, now()),
  approved_by = coalesce(membership.approved_by, membership.user_id),
  approved_at = coalesce(membership.approved_at, now()),
  updated_at = now()
where membership.status is distinct from 'suspended'
  and membership.status is distinct from 'verified';
  -- and membership.id = 'YOUR_MEMBERSHIP_UUID';

insert into public.role_assignments (user_id, school_id, role)
select membership.user_id, membership.school_id, 'parent'::public.assignment_role
from public.school_memberships as membership
where membership.status = 'verified'
on conflict do nothing;

insert into public.consent_acceptances (user_id, document_id)
select membership.user_id, document.id
from public.school_memberships as membership
cross join public.consent_documents as document
where membership.status = 'verified'
  and document.is_active
on conflict (user_id, document_id) do nothing;

select
  membership.id,
  membership.user_id,
  membership.status,
  membership.approved_at is not null as has_approved_at
from public.school_memberships as membership
order by membership.updated_at desc
limit 20;

commit;
