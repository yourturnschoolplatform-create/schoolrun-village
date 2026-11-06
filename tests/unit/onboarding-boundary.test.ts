import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Day 2 onboarding API security boundary', () => {
  it('uses the signed-in request client for ordinary onboarding routes', async () => {
    const router = await readFile(resolve('server/onboarding-router.ts'), 'utf8');
    expect(router).toContain('createRequestScopedSupabaseClient(request)');
    expect(router).toContain("router.post('/school-membership'");
    expect(router).toContain("router.post('/moderation/memberships/:membershipId/approve'");
    expect(router).toContain("router.get('/moderation/pending-memberships'");
    expect(router).toContain("router.post('/moderation/invitations'");
    expect(router).toContain("router.post('/moderation/memberships/:membershipId/review'");
    expect(router).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('redacts school IDs before approval and handles void consent/profile RPCs without treating null data as an error', async () => {
    const router = await readFile(resolve('server/onboarding-router.ts'), 'utf8');
    expect(router).toContain('function rpcVoid');
    expect(router).toContain("rpcVoid(await context.client.rpc('accept_current_consent'");
    expect(router).toContain("rpcVoid(await context.client.rpc('update_onboarding_parent_profile'");
    expect(router).toContain('membership: membershipResult.data ? {');
    expect(router).toContain('approved_at: membershipResult.data.approved_at');
    expect(router).not.toContain('school_id: membershipResult.data.school_id');
    expect(router).toContain(".from('safety_declaration_versions')");
    expect(router).toContain('school_id.is.null,school_id.eq.');
  });

  it('uses an anonymous client only for generic invitation opening and does not return school data', async () => {
    const router = await readFile(resolve('server/onboarding-router.ts'), 'utf8');
    const publicClient = await readFile(resolve('server/supabase/public-client.ts'), 'utf8');
    expect(publicClient).toContain('opening an opaque invitation');
    expect(router).toContain("router.post('/invitations/open'");
    expect(router).toContain("response.json({ status })");
    expect(router).toContain('no school name, ID, config, roster or inviter data');
  });
});
