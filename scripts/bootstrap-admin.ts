import { readPublicSupabaseConfig } from '../server/config.js';
import { bootstrapFirstAdmin } from '../server/admin/bootstrap.js';
import { createServerOnlyAdminClient } from '../server/admin/service-role.js';

try {
  if (process.argv.includes('--check-only')) {
    readPublicSupabaseConfig();
    createServerOnlyAdminClient();
    console.log('Supabase key-format boundary: PASS (public anon/publishable and server-only service-role formats accepted).');
    process.exit(0);
  }

  const result = await bootstrapFirstAdmin();
  console.log(`Admin bootstrap: ${result.outcome}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown admin bootstrap error.';
  console.error(`Admin bootstrap failed: ${message}`);
  process.exitCode = 1;
}
