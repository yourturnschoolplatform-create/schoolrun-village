import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

/** Load KEY=VALUE pairs from .env into process.env when missing (never logs values). */
function loadDotEnvIfPresent(): void {
  try {
    const raw = readFileSync(resolve('.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional when the shell already exports the migration URL.
  }
}

loadDotEnvIfPresent();

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
  const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message.replace(/[^\x20-\x7E]/g, '?').slice(0, 240)
    : '';
  const position = typeof error === 'object' && error !== null && 'position' in error
    ? String(error.position)
    : '';
  console.error(
    `Migration failed while processing ${activeMigration} (safe error code: ${code}`
    + (position ? `; position: ${position}` : '')
    + (message ? `; message: ${message}` : '')
    + '). No database URL or key was logged.',
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
