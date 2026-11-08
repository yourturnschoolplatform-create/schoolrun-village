-- Local/manual helper: mark one school_membership as verified without dropping
-- school_memberships_verified_credential_check.
--
-- Required for status = 'verified':
--   verified_email_at, invite_code_verified_at, approved_by, approved_at
--
-- Prefer the TS helper:
--   npm run db:mark-membership-verified -- <membership-uuid>
--
-- Or paste into the Supabase SQL editor after replacing the uuid in set_config.

begin;

select set_config(
  'yourturn.dev_membership_id',
  '00000000-0000-4000-8000-000000000000', -- <<< replace with membership id
  true
);

update public.school_memberships as membership
set
  status = 'verified',
  verified_email_at = coalesce(membership.verified_email_at, now()),
  invite_code_verified_at = coalesce(membership.invite_code_verified_at, now()),
  approved_by = coalesce(membership.approved_by, membership.user_id),
  approved_at = coalesce(membership.approved_at, now()),
  updated_at = now()
where membership.id = nullif(current_setting('yourturn.dev_membership_id', true), '')::uuid
  and membership.status is distinct from 'suspended';

insert into public.role_assignments (user_id, school_id, role)
select membership.user_id, membership.school_id, 'parent'::public.assignment_role
from public.school_memberships as membership
where membership.id = nullif(current_setting('yourturn.dev_membership_id', true), '')::uuid
  and membership.status = 'verified'
on conflict do nothing;

-- Needed for public.is_member / school-scoped RPCs (not for the check alone).
insert into public.consent_acceptances (user_id, document_id)
select membership.user_id, document.id
from public.school_memberships as membership
cross join public.consent_documents as document
where membership.id = nullif(current_setting('yourturn.dev_membership_id', true), '')::uuid
  and document.is_active
on conflict (user_id, document_id) do nothing;

select
  membership.id,
  membership.status,
  membership.verified_email_at is not null as has_email_proof,
  membership.invite_code_verified_at is not null as has_invite_proof,
  membership.approved_by is not null as has_approver,
  membership.approved_at is not null as has_approved_at
from public.school_memberships as membership
where membership.id = nullif(current_setting('yourturn.dev_membership_id', true), '')::uuid;

commit;
