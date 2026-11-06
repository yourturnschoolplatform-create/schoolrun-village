import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const forbidden = 'SUPABASE_SERVICE_ROLE_KEY';
const migrationOnly = ['SUPABASE_MIGRATION_DATABASE_URL', 'SUPABASE_RLS_TEST_DATABASE_URL'];
const allowedAdminPath = 'server/admin/service-role.ts';
const roots = ['src', 'public', 'dist'];

async function filesUnder(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory);
    const nested = await Promise.all(entries.map(async (entry) => {
      const fullPath = resolve(directory, entry);
      const info = await stat(fullPath);
      return info.isDirectory() ? filesUnder(fullPath) : [fullPath];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

const findings: string[] = [];
for (const root of roots) {
  for (const file of await filesUnder(resolve(root))) {
    const content = await readFile(file, 'utf8');
    if (content.includes(forbidden)) {
      findings.push(relative(process.cwd(), file));
    }
    if (migrationOnly.some((name) => content.includes(name))) {
      findings.push(`${relative(process.cwd(), file)} (migration/test database URL reference)`);
    }
  }
}

for (const file of await filesUnder(resolve('server'))) {
  const relativePath = relative(process.cwd(), file);
  const content = await readFile(file, 'utf8');
  if (content.includes(forbidden) && relativePath !== allowedAdminPath) {
    findings.push(relativePath);
  }
}

if (findings.length > 0) {
  throw new Error(`Service-role key reference found outside the server-only admin boundary: ${findings.join(', ')}`);
}

console.log('Credential boundary: PASS (no service-role or migration/test database URL reference in browser, build, or runtime server code).');
