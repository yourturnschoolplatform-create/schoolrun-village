import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';

// Explicit TEST-only installer. No runtime server or development URL import.
const value = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
if (!value) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required.');
const client = new Client({ connectionString: value, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
let stage = 'connect';
try {
  await client.connect();
  await client.query('begin');
  stage = 'create native extension';
  await client.query('create extension if not exists pg_cron');
  stage = 'restrict scheduler schema';
  await client.query('revoke all on schema cron from public,anon,authenticated');
  // Supabase owns cron metadata. Do not change vendor ownership or policies.
  // Native job/log tables contain only this fixed phone-free SQL command.
  const tables = await client.query<{ relname: string; anon_privileges: boolean; authenticated_privileges: boolean }>(`select c.relname,
      (has_schema_privilege('anon','cron','USAGE') and has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) as anon_privileges,
      (has_schema_privilege('authenticated','cron','USAGE') and has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) as authenticated_privileges
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='cron' and c.relkind in ('r','p')`);
  for (const table of tables.rows) {
    stage = 'validate private native metadata';
    if (table.anon_privileges || table.authenticated_privileges) {
      throw Object.assign(new Error('Browser-accessible native metadata is not allowed.'), { code: '42501' });
    }
  }
  stage = 'register record creation job';
  await client.query(`select cron.schedule('yourturn-handover-reminder-records','* * * * *',
    'select public.enqueue_due_handover_reminders();')`);
  await client.query('commit');
  const jobs = await client.query(`select jobname,schedule,command,active from cron.job
    where jobname='yourturn-handover-reminder-records'`);
  const metadata = await client.query(`select c.relname as table_name,c.relrowsecurity as rls,
    has_schema_privilege('anon','cron','USAGE') as anon_schema_usage,
    has_schema_privilege('authenticated','cron','USAGE') as authenticated_schema_usage,
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anon_table_acl,
    has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as authenticated_table_acl
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='cron' and c.relkind in ('r','p') order by c.relname`);
  const result = { target: 'TEST only', jobs: jobs.rows, schedulerTables: metadata.rows,
    deliveryImplemented: false };
  await mkdir('docs/evidence', { recursive: true });
  await writeFile('docs/evidence/TASK_5_3_CRON_INSTALL_RAW.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch (error) {
  await client.query('rollback').catch(() => {});
  const raw = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN_ERROR';
  const code = /^[A-Z0-9_]+$/.test(raw) ? raw : 'UNKNOWN_ERROR';
  console.error(`TEST reminder schedule installation failed (${code}) at ${stage}; no connection value logged.`);
  process.exitCode = 1;
} finally { await client.end().catch(() => {}); }
