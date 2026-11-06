import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Day 3 schedule API security boundary', () => {
  it('uses a request-scoped user JWT client and never a service role', async () => {
    const router = await readFile(resolve('server/schedules-router.ts'), 'utf8');
    expect(router).toContain('createRequestScopedSupabaseClient(request)');
    expect(router).toContain("router.post('/patterns'");
    expect(router).toContain("router.post('/instances/:instanceId/cancel'");
    expect(router).toContain("router.post('/patterns/:patternId/cancel'");
    expect(router).toContain("rpc('refresh_my_availability_instances')");
    expect(router).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(router).not.toContain('createServiceRoleClient');
  });

  it('exports only confirmed personal instances and does not serialize an address or location field', async () => {
    const router = await readFile(resolve('server/schedules-router.ts'), 'utf8');
    const ics = await readFile(resolve('shared/ics.ts'), 'utf8');
    expect(router).toContain(".eq('status', 'confirmed')");
    expect(router).toContain(".eq('school_id', schoolId)");
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toMatch(/\baddress\b/i);
    expect(router).toContain('isSuburbAreaLabel');
  });
});
