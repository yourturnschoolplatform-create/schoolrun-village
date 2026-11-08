-- LOCAL ONLY (Supabase SQL Editor): create one claimable invitation for the
-- sample Harbourview school. Replaces the invite token each run.
--
-- After running, copy invite_token from the final SELECT into:
--   http://127.0.0.1:3000/?invite=<invite_token>
--
-- Prefer: npm run db:create-school-invitation

begin;

with params as (
  select
    encode(extensions.gen_random_bytes(24), 'hex') as invite_token,
    (select id from public.schools where slug = 'sample-harbourview-primary' limit 1) as school_id,
    (select id from public.profiles order by created_at asc nulls last limit 1) as invited_by
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
  (select count(*) from ins) as inserted
from params;

commit;
