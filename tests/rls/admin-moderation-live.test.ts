/**
 * Task 10.3 live suite: global-admin suspend / safety-hold resolve / read models.
 * School moderators and parents denied. Authenticated + synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  admin: { userId: string };
  parentA: Member;
  moderatorA: Member;
  moderatorB: Member;
};

describe('Task 10.3 live admin moderation console', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Admin moderation live test connection is not initialised.');
    return client;
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^(fixture|read-back): [a-z0-9 ._-]+$/i.test(label)) {
      throw new Error('Privileged actions require a synthetic fixture/read-back label.');
    }
    await db().query(`/* privileged ${label} */ reset role`);
    await db().query(`select set_config('request.jwt.claims', '{}', true),
      set_config('request.jwt.claim.sub', '', true),
      set_config('request.jwt.claim.role', '', true)`);
    return action();
  }

  async function authenticated<T extends QueryResultRow>(
    userId: string, sql: string, values: unknown[] = [],
  ): Promise<T[]> {
    await db().query('set local role authenticated; set local row_security = on');
    await db().query(`select set_config('request.jwt.claims', $1, true),
      set_config('request.jwt.claim.sub', $2, true),
      set_config('request.jwt.claim.role', 'authenticated', true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' }), userId]);
    const { rows } = await db().query(`select current_user::text as role,
      current_setting('row_security') as row_security,
      r.rolsuper, r.rolbypassrls, auth.uid() = $1::uuid as correct_subject
      from pg_catalog.pg_roles r where r.rolname = current_user`, [userId]);
    expect(rows).toEqual([{
      role: 'authenticated', row_security: 'on', rolsuper: false,
      rolbypassrls: false, correct_subject: true,
    }]);
    return (await db().query<T>(sql, values)).rows;
  }

  async function denied(action: () => Promise<unknown>, expectedCodes = ['42501']): Promise<void> {
    const name = `admin_moderation_denial_${++savepointNumber}`;
    await db().query(`savepoint ${name}`);
    let code: string | null = null;
    try {
      await action();
    } catch (error) {
      code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
    } finally {
      await db().query(`rollback to savepoint ${name}`);
      await db().query(`release savepoint ${name}`);
    }
    expect(expectedCodes).toContain(code);
  }

  async function signMembership(member: Member, declarationId: string): Promise<void> {
    await db().query(`insert into public.safety_declarations
      (id, membership_id, parent_id, school_id, declaration_version_id,
       licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      values ($1, $2, $3, $4, $5, true, true, true, true)`,
    [randomUUID(), member.membershipId, member.userId, member.schoolId, declarationId]);
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({
      schoolId, userId: randomUUID(), membershipId: randomUUID(),
    });
    const admin = { userId: randomUUID() };
    const parentA = member(schoolA);
    const moderatorA = member(schoolA);
    const moderatorB = member(schoolB);
    const members = [parentA, moderatorA, moderatorB];
    const allUsers = [admin.userId, ...members.map((m) => m.userId)];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Admin Mod School A', 'Australia/Sydney'),
             ($3, $4, 'Admin Mod School B', 'Australia/Melbourne')`,
    [schoolA, `adm-a-${schoolA}`, schoolB, `adm-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'adm-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', 'User ' || left(id::text, 8)), now(), now()
      from unnest($1::uuid[]) as u(id)`, [allUsers]);
    await db().query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, 'verified'::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as m(id, school_id, user_id)`, [
      members.map((m) => m.membershipId), members.map((m) => m.schoolId),
      members.map((m) => m.userId),
    ]);
    await db().query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, null, 'admin', null, $2),
             ($3, $4, $5, 'moderator', now(), $4),
             ($6, $7, $8, 'moderator', now(), $7)`,
    [
      randomUUID(), admin.userId,
      randomUUID(), moderatorA.userId, schoolA,
      randomUUID(), moderatorB.userId, schoolB,
    ]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [allUsers]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Admin Mod A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Admin Mod B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return { schoolA, schoolB, admin, parentA, moderatorA, moderatorB };
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for admin moderation live tests.');
    client = new Client({
      connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
    } catch {
      throw new Error('Unable to connect to the dedicated RLS test database; connection details suppressed.');
    }
    await db().query('begin');
    transactionStarted = true;
    await db().query(`set local timezone = 'UTC'; set local row_security = on;
      set local statement_timeout = '20s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: unique admin moderation onboarding', seed);
  }, LIVE_TIMEOUT);

  afterEach(async () => {
    try {
      if (transactionStarted && client) await client.query('rollback');
    } finally {
      transactionStarted = false;
      if (client) await client.end();
      client = undefined;
    }
  }, LIVE_TIMEOUT);

  it('adminSuspendUnsuspend: global admin toggles platform suspend with audit; moderators denied', async () => {
    const suspended = await authenticated<{ admin_suspend_user: {
      user_id: string; admin_suspended: boolean; outcome: string;
    } }>(
      fixture.admin.userId,
      'select public.admin_suspend_user($1::uuid, $2::text) as admin_suspend_user',
      [fixture.parentA.userId, 'policy_breach'],
    );
    expect(suspended[0].admin_suspend_user).toEqual({
      user_id: fixture.parentA.userId,
      admin_suspended: true,
      outcome: 'suspended',
    });

    const listed = await authenticated<{ list_admin_suspended_users: Array<{
      user_id: string; admin_suspended: boolean;
    }> }>(
      fixture.admin.userId,
      'select public.list_admin_suspended_users() as list_admin_suspended_users',
    );
    expect(listed[0].list_admin_suspended_users.some(
      (row) => row.user_id === fixture.parentA.userId && row.admin_suspended,
    )).toBe(true);
    expect(JSON.stringify(listed[0].list_admin_suspended_users))
      .not.toMatch(/\b(amount|currency|payment|phone|photo|nickname|email|display_name)\b/i);

    const audits = await authenticated<{ list_admin_audit_actions: Array<{
      action: string; entity_id: string; payload: Record<string, string>;
    }> }>(
      fixture.admin.userId,
      'select public.list_admin_audit_actions(20) as list_admin_audit_actions',
    );
    expect(audits[0].list_admin_audit_actions.some(
      (row) => row.action === 'admin.user_suspended'
        && row.entity_id === fixture.parentA.userId
        && row.payload.reason_code === 'policy_breach',
    )).toBe(true);

    const cleared = await authenticated<{ admin_unsuspend_user: {
      user_id: string; outcome: string; admin_suspended: boolean;
    } }>(
      fixture.admin.userId,
      'select public.admin_unsuspend_user($1::uuid, $2::text) as admin_unsuspend_user',
      [fixture.parentA.userId, 'appeal_upheld'],
    );
    expect(cleared[0].admin_unsuspend_user).toEqual({
      user_id: fixture.parentA.userId,
      outcome: 'unsuspended',
      admin_suspended: false,
    });

    await denied(() => authenticated(fixture.moderatorA.userId,
      'select public.admin_suspend_user($1::uuid, $2::text)',
      [fixture.parentA.userId, 'moderator_forge']));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.list_admin_suspended_users()'));
    await denied(() => authenticated(fixture.parentA.userId,
      'select public.admin_unsuspend_user($1::uuid, $2::text)',
      [fixture.parentA.userId, 'self_unsuspend']));
  });

  it('adminResolveSafetyHold: admin lifts by subject; school moderator cannot call admin RPC', async () => {
    const hold = await authenticated<{ place_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.place_safety_hold($1::uuid) as place_safety_hold',
      [fixture.parentA.userId],
    );

    const holds = await authenticated<{ list_admin_safety_holds: Array<{
      id: string; subject_user_id: string; status: string;
    }> }>(
      fixture.admin.userId,
      'select public.list_admin_safety_holds() as list_admin_safety_holds',
    );
    expect(holds[0].list_admin_safety_holds.some(
      (row) => row.id === hold[0].place_safety_hold
        && row.subject_user_id === fixture.parentA.userId
        && row.status === 'active',
    )).toBe(true);
    expect(JSON.stringify(holds[0].list_admin_safety_holds))
      .not.toMatch(/\b(amount|currency|payment|phone|photo|nickname|email)\b/i);

    await denied(() => authenticated(fixture.moderatorA.userId,
      'select public.admin_resolve_safety_hold($1::uuid, $2::text, $3::text)',
      [fixture.parentA.userId, 'lift', 'moderator_forge']));

    const resolved = await authenticated<{ admin_resolve_safety_hold: {
      hold_id: string; subject_user_id: string; school_id: string; outcome: string;
    } }>(
      fixture.admin.userId,
      'select public.admin_resolve_safety_hold($1::uuid, $2::text, $3::text) as admin_resolve_safety_hold',
      [fixture.parentA.userId, 'lift', 'admin_review'],
    );
    expect(resolved[0].admin_resolve_safety_hold).toEqual({
      hold_id: hold[0].place_safety_hold,
      outcome: 'lifted',
      school_id: expect.any(String),
      subject_user_id: fixture.parentA.userId,
    });

    const after = await authenticated<{ list_admin_safety_holds: unknown[] }>(
      fixture.admin.userId,
      'select public.list_admin_safety_holds() as list_admin_safety_holds',
    );
    expect(after[0].list_admin_safety_holds).toEqual([]);
  });

  it('catalogAdminOnly: helpers internal; grants and search_path locked', async () => {
    const catalog = await privileged('read-back: admin moderation catalog', async () => {
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'admin_require', 'admin_reason_code_is_valid',
             'admin_suspend_user', 'admin_unsuspend_user', 'admin_resolve_safety_hold',
             'list_admin_safety_holds', 'list_admin_suspended_users', 'list_admin_audit_actions'
           )
         order by p.proname`);
      return grants.rows;
    });

    expect(catalog.filter((g) => !g.auth_exec).map((g) => g.name).sort()).toEqual([
      'admin_reason_code_is_valid',
      'admin_require',
    ]);
    expect(catalog.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'admin_resolve_safety_hold',
      'admin_suspend_user',
      'admin_unsuspend_user',
      'list_admin_audit_actions',
      'list_admin_safety_holds',
      'list_admin_suspended_users',
    ]);
    for (const row of catalog) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
      expect(row.path).not.toMatch(/search_path=pg_catalog, public/);
    }
  });
});
