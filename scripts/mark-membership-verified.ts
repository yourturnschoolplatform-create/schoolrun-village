/**
 * Dev helper: set school_memberships to verified while satisfying
 * school_memberships_verified_credential_check (fills credential columns;
 * does not drop the constraint).
 *
 * Usage:
 *   npx tsx scripts/mark-membership-verified.ts <membership-uuid>
 *   npx tsx scripts/mark-membership-verified.ts --all-pending
 *   npx tsx scripts/mark-membership-verified.ts --email you@example.com
 *
 * Uses SUPABASE_MIGRATION_DATABASE_URL. Never logs the URL or email.
 */
import { Client } from 'pg';

const args = process.argv.slice(2);
const allPending = args.includes('--all-pending');
const emailFlagIndex = args.indexOf('--email');
const email = emailFlagIndex >= 0 ? args[emailFlagIndex + 1]?.trim() : undefined;
const membershipId = args.find((arg) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg));

if (!allPending && !email && !membershipId) {
  console.error('Usage:');
  console.error('  npx tsx scripts/mark-membership-verified.ts <membership-uuid>');
  console.error('  npx tsx scripts/mark-membership-verified.ts --all-pending');
  console.error('  npx tsx scripts/mark-membership-verified.ts --email <address>');
  process.exitCode = 1;
  process.exit();
}

if (emailFlagIndex >= 0 && !email) {
  console.error('--email requires an address argument.');
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

try {
  await client.connect();
  await client.query('begin');

  let ids: string[] = [];
  if (membershipId) {
    ids = [membershipId];
  } else if (email) {
    const found = await client.query<{ id: string }>(
      `select membership.id
       from public.school_memberships as membership
       join auth.users as auth_user on auth_user.id = membership.user_id
       where lower(auth_user.email) = lower($1)
         and membership.status is distinct from 'suspended'`,
      [email],
    );
    ids = found.rows.map((row) => row.id);
  } else {
    const found = await client.query<{ id: string }>(
      `select membership.id
       from public.school_memberships as membership
       where membership.status is distinct from 'suspended'
         and membership.status is distinct from 'verified'`,
    );
    ids = found.rows.map((row) => row.id);
  }

  if (ids.length === 0) {
    throw new Error('no matching memberships to verify');
  }

  const updated = await client.query<{ id: string }>(
    `update public.school_memberships as membership
     set
       status = 'verified',
       verified_email_at = coalesce(membership.verified_email_at, now()),
       invite_code_verified_at = coalesce(membership.invite_code_verified_at, now()),
       approved_by = coalesce(membership.approved_by, membership.user_id),
       approved_at = coalesce(membership.approved_at, now()),
       updated_at = now()
     where membership.id = any($1::uuid[])
       and membership.status is distinct from 'suspended'
     returning membership.id`,
    [ids],
  );

  await client.query(
    `insert into public.role_assignments (user_id, school_id, role)
     select membership.user_id, membership.school_id, 'parent'::public.assignment_role
     from public.school_memberships as membership
     where membership.id = any($1::uuid[])
     on conflict do nothing`,
    [ids],
  );

  await client.query(
    `insert into public.consent_acceptances (user_id, document_id)
     select membership.user_id, document.id
     from public.school_memberships as membership
     cross join public.consent_documents as document
     where membership.id = any($1::uuid[])
       and document.is_active
     on conflict (user_id, document_id) do nothing`,
    [ids],
  );

  await client.query('commit');
  console.log(`Marked verified: ${updated.rowCount} membership(s). IDs not printed.`);
  console.log('Consents ensured. Sign the safety declaration in the UI if the dashboard still waits on it.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';
  const message = error instanceof Error ? error.message : 'mark-membership-verified failed';
  console.error(`Failed (${code}): ${message}. No database URL or email was logged.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
