import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

const target = process.argv.find((argument) => argument.startsWith('--target='))?.slice('--target='.length) ?? 'development';
const environmentVariableByTarget: Record<string, string> = {
  development: 'SUPABASE_MIGRATION_DATABASE_URL',
  'rls-test': 'SUPABASE_RLS_TEST_DATABASE_URL',
};
const urlEnvironmentVariable = environmentVariableByTarget[target];

if (!urlEnvironmentVariable) {
  throw new Error('Migration target must be development or rls-test.');
}

const databaseUrl = process.env[urlEnvironmentVariable];
if (!databaseUrl?.trim()) {
  throw new Error(`${urlEnvironmentVariable} is required; its value is never printed.`);
}

const directory = resolve('db/migrations');
const migrationNames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
// Supabase session poolers require TLS. This option is used only by migration
// commands and never by the runtime server or browser bundle.
const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
let activeMigration = 'connection';

try {
  await client.connect();
  await client.query('create schema if not exists yourturn_internal');
  await client.query('revoke all on schema yourturn_internal from public');
  await client.query(`
    create table if not exists yourturn_internal.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const appliedResult = await client.query<{ filename: string }>('select filename from yourturn_internal.schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.filename));

  for (const migrationName of migrationNames) {
    if (applied.has(migrationName)) {
      console.log(`Skipped ${migrationName} (already applied)`);
      continue;
    }
    activeMigration = migrationName;
    const sql = await readFile(resolve(directory, migrationName), 'utf8');
    await client.query(sql);
    await client.query('insert into yourturn_internal.schema_migrations (filename) values ($1)', [migrationName]);
    console.log(`Applied ${migrationName}`);
  }
} catch (error) {
  // Keep all connection credentials and transport details out of terminal logs.
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
  console.error(`Migration failed while processing ${activeMigration} (safe error code: ${code}). No database URL or key was logged.`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
