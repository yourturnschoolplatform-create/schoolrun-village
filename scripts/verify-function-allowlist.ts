import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

type FunctionEntry = { name: string; searchPath?: string };
type Allowlist = { authenticated: FunctionEntry[]; internal?: FunctionEntry[] };
type FunctionRow = {
  proname: string;
  security_definer: boolean;
  search_path: string | null;
  anon_exec: boolean;
  authenticated_exec: boolean;
};

const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required.');
const allowlist = JSON.parse(await readFile('db/function_allowlist.json', 'utf8')) as Allowlist;
const allowed = new Set(allowlist.authenticated.map((entry) => entry.name));
const internal = new Set((allowlist.internal ?? []).map((entry) => entry.name));
const declarations = [...allowlist.authenticated, ...(allowlist.internal ?? [])];
if (new Set(declarations.map((entry) => entry.name)).size !== declarations.length) {
  throw new Error('Function allowlist contains duplicate declarations.');
}
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  const { rows } = await client.query<FunctionRow>(`
    select p.proname, p.prosecdef as security_definer,
      (select substr(setting,13) from unnest(p.proconfig) as setting
        where setting like 'search_path=%') as search_path,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
  `);
  const anonExecutable = rows.filter((row) => row.anon_exec).map((row) => row.proname);
  const authenticatedMissing = rows.filter((row) => row.authenticated_exec && !allowed.has(row.proname)).map((row) => row.proname);
  const unfixedSearchPath = rows.filter((row) => row.security_definer && !row.search_path).map((row) => row.proname);
  const internalExecutable = rows.filter((row) => internal.has(row.proname) && row.authenticated_exec).map((row) => row.proname);
  const searchPathMismatch = rows.filter((row) => {
    const declaration = declarations.find((entry) => entry.name === row.proname);
    return declaration?.searchPath !== undefined && row.search_path !== declaration.searchPath;
  }).map((row) => row.proname);
  const missing = declarations.filter((entry) => !rows.some((row) => row.proname === entry.name)).map((entry) => entry.name);
  const problems = [
    anonExecutable.length ? `anon execute: ${anonExecutable.join(', ')}` : '',
    authenticatedMissing.length ? `authenticated executable missing from allowlist: ${authenticatedMissing.join(', ')}` : '',
    unfixedSearchPath.length ? `security definer without fixed search_path: ${unfixedSearchPath.join(', ')}` : '',
    internalExecutable.length ? `internal function executable by authenticated: ${internalExecutable.join(', ')}` : '',
    searchPathMismatch.length ? `search_path mismatch: ${searchPathMismatch.join(', ')}` : '',
    missing.length ? `missing function: ${missing.join(', ')}` : '',
  ].filter(Boolean);
  if (problems.length) throw new Error(`Function privilege allowlist violation: ${problems.join('; ')}`);
  console.log(`Function allowlist verified: ${rows.length} public functions, ${allowed.size} authenticated entries, ${internal.size} internal declarations.`);
} finally {
  await client.end();
}
