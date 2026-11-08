/**
 * LOCAL ONLY: drop school_memberships_verified_credential_check so status can be
 * set to 'verified' without email/invite/approval timestamps.
 *
 * Not a numbered migration — never applied by db:migrate / db:migrate:test.
 * Requires an explicit opt-in flag so TEST/RLS DBs are not weakened by accident.
 *
 * Usage:
 *   npx tsx scripts/dev-relax-membership-verified-check.ts --local-only
 *   npx tsx scripts/dev-relax-membership-verified-check.ts --local-only --restore
 *
 * Uses SUPABASE_MIGRATION_DATABASE_URL. Never logs the URL.
 */
import { Client } from 'pg';

const localOnly = process.argv.includes('--local-only');
const restore = process.argv.includes('--restore');

if (!localOnly) {
  console.error('Refusing to change constraints without --local-only.');
  console.error('Usage: npx tsx scripts/dev-relax-membership-verified-check.ts --local-only [--restore]');
  process.exitCode = 1;
  process.exit();
}

const databaseUrl = process.env.SUPABASE_MIGRATION_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('SUPABASE_MIGRATION_DATABASE_URL is required; its value is never printed.');
  process.exitCode = 1;
  process.exit();
}

const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

const strictCheckSql = `
alter table public.school_memberships
  drop constraint if exists school_memberships_verified_credential_check;
alter table public.school_memberships
  add constraint school_memberships_verified_credential_check check (
    status <> 'verified'
    or (
      verified_email_at is not null
      and invite_code_verified_at is not null
      and approved_by is not null
      and approved_at is not null
    )
  );
`;

const relaxSql = `
alter table public.school_memberships
  drop constraint if exists school_memberships_verified_credential_check;
`;

try {
  await client.connect();
  await client.query('begin');
  await client.query(restore ? strictCheckSql : relaxSql);
  await client.query('commit');
  console.log(restore
    ? 'Restored school_memberships_verified_credential_check (strict).'
    : 'Dropped school_memberships_verified_credential_check (local-only relax).');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';
  const message = error instanceof Error ? error.message : 'constraint change failed';
  console.error(`Failed (${code}): ${message}. No database URL was logged.`);
  if (restore) {
    console.error('Restore fails if any verified row is missing credential columns; fix those rows first.');
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
