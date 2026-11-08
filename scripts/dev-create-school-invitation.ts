/**
 * LOCAL helper: create a claimable school_invitations row for a sample school
 * and print a one-time invite URL token (not a secret of a real family).
 *
 * Usage:
 *   npx tsx scripts/dev-create-school-invitation.ts
 *   npx tsx scripts/dev-create-school-invitation.ts --school-slug sample-harbourview-primary
 *
 * Uses SUPABASE_MIGRATION_DATABASE_URL. Requires at least one profiles row to
 * act as invited_by (any local test user).
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';

const slugFlag = process.argv.indexOf('--school-slug');
const schoolSlug = (slugFlag >= 0 ? process.argv[slugFlag + 1] : null)?.trim()
  || 'sample-harbourview-primary';

const databaseUrl = process.env.SUPABASE_MIGRATION_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error('SUPABASE_MIGRATION_DATABASE_URL is required; its value is never printed.');
  process.exitCode = 1;
  process.exit();
}

const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
const token = randomBytes(24).toString('hex');
const tokenHash = createHash('sha256').update(token).digest('hex');

try {
  await client.connect();
  await client.query('begin');

  const school = await client.query<{ id: string }>(
    `select id from public.schools where slug = $1 limit 1`,
    [schoolSlug],
  );
  if (school.rowCount !== 1) {
    throw new Error('school slug not found (apply sample pilot seed / 0004)');
  }

  const inviter = await client.query<{ id: string }>(
    `select id from public.profiles order by created_at asc nulls last limit 1`,
  );
  if (inviter.rowCount !== 1) {
    throw new Error('no profiles row available for invited_by; sign up once first');
  }

  await client.query(
    `insert into public.school_invitations
      (school_id, invited_by, token_hash, status, expires_at)
     values ($1, $2, $3, 'sent', now() + interval '180 days')`,
    [school.rows[0].id, inviter.rows[0].id, tokenHash],
  );

  await client.query('commit');
  console.log('Created local school invitation.');
  console.log(`Open: http://127.0.0.1:3000/?invite=${token}`);
  console.log('Token is printed once for local testing only.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';
  const message = error instanceof Error ? error.message : 'create invitation failed';
  console.error(`Failed (${code}): ${message}. No database URL was logged.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
