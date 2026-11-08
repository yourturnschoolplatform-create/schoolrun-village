-- LOCAL ONLY (Supabase SQL Editor).
-- Creates a claimable school invitation with a FIXED token for local dashboard testing.
--
-- After running, open:
--   http://127.0.0.1:3000/?invite=localdev_sample_harbourview_invite_token_v1
--
-- Requires: sample school from 0004, and at least one profiles row (sign up once).
-- Does not drop school_memberships_verified_credential_check.

begin;

with params as (
  select
    'localdev_sample_harbourview_invite_token_v1'::text as invite_token,
    (select id from public.schools where slug = 'sample-harbourview-primary' limit 1) as school_id,
    (select id from public.profiles order by created_at asc nulls last limit 1) as invited_by
),
deleted as (
  -- Replace any prior localdev hash so re-runs stay idempotent for this token.
  delete from public.school_invitations as invitation
  using params
  where invitation.token_hash = encode(extensions.digest(params.invite_token, 'sha256'), 'hex')
  returning invitation.id
),
ins as (
  insert into public.school_invitations (school_id, invited_by, token_hash, status, expires_at)
  select
    params.school_id,
    params.invited_by,
    encode(extensions.digest(params.invite_token, 'sha256'), 'hex'),
    'sent',
    now() + interval '180 days'
  from params
  where params.school_id is not null
    and params.invited_by is not null
  returning id
)
select
  params.invite_token,
  params.school_id is not null as has_school,
  params.invited_by is not null as has_inviter,
  (select count(*)::int from deleted) as replaced,
  (select count(*)::int from ins) as inserted
from params;

commit;
