-- LOCAL ONLY (Supabase SQL editor). Not part of db/migrations.
-- Drops school_memberships_verified_credential_check so you can:
--   update public.school_memberships set status = 'verified' where id = '...';
--
-- Prefer the gated TS helper:
--   npm run db:relax-membership-verified-check -- --local-only
-- Restore:
--   npm run db:relax-membership-verified-check -- --local-only --restore

alter table public.school_memberships
  drop constraint if exists school_memberships_verified_credential_check;
