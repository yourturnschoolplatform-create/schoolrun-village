import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const resolutionCodes = new Set(['42883', '3F000', '42P01']);

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  moderatorA: Member;
  parentA: Member;
  parentA2: Member;
  parentB: Member;
  joiner: { userId: string };
  codeJoiner: { userId: string };
  userIds: string[];
};

/**
 * Synthetic invitation fixture. Privileged setup stays inside one transaction
 * and afterAll rolls it back. Every caller assertion uses SET LOCAL ROLE
 * authenticated, row_security on, and synthetic JWT claims. Errors keep only
 * SQLSTATE so tokens and codes never enter the report.
 */
describe('G1 invitation extension qualification', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let fixture: Fixture;
  let caseSavepoint = '';
  let savepointNumber = 0;

  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    if (!client) throw new Error('Invitation live test connection is not initialized.');
    try { return await client.query<T>(sql, values); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
      throw Object.assign(new Error(`Invitation database operation failed (SQLSTATE ${code}); details suppressed.`), { code });
    }
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^fixture: [a-z0-9 ._-]+$/i.test(label)) throw new Error('Privileged operations require a fixture label.');
    await query(`/* privileged ${label} */ reset role`);
    await query(`select set_config('request.jwt.claims', '{}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)`);
    return action();
  }

  async function authenticated<T extends QueryResultRow = QueryResultRow>(
    userId: string, sql: string, values: unknown[] = [],
  ): Promise<T[]> {
    await query('set local role authenticated; set local row_security = on');
    await query(`select set_config('request.jwt.claims', $1, true),
      set_config('request.jwt.claim.sub', $2, true),
      set_config('request.jwt.claim.role', 'authenticated', true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' }), userId]);
    const identity = await query<{
      role: string; row_security: string; rolsuper: boolean; rolbypassrls: boolean; correct_subject: boolean;
    }>(`select current_user::text as role, current_setting('row_security') as row_security,
      r.rolsuper, r.rolbypassrls, auth.uid() = $1::uuid as correct_subject
      from pg_catalog.pg_roles r where r.rolname = current_user`, [userId]);
    expect(identity.rows).toEqual([{
      role: 'authenticated', row_security: 'on', rolsuper: false, rolbypassrls: false, correct_subject: true,
    }]);
    return (await query<T>(sql, values)).rows;
  }

  async function anonymous<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await query('set local role anon; set local row_security = on');
    await query(`select set_config('request.jwt.claims', '{"role":"anon"}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`);
    const identity = await query(`select current_user::text as role, current_setting('row_security') as row_security,
      rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = current_user`);
    expect(identity.rows).toEqual([{ role: 'anon', row_security: 'on', rolsuper: false, rolbypassrls: false }]);
    return (await query<T>(sql, values)).rows;
  }

  async function denied(action: () => Promise<unknown>, codes: string[]): Promise<string> {
    const name = `g1_denied_${++savepointNumber}`;
    await query(`savepoint ${name}`);
    let code: string | null = null;
    try {
      try { await action(); }
      catch (error) { code = (error as { code?: string }).code ?? 'non-database-error'; }
    } finally {
      await query(`rollback to savepoint ${name}`);
      await query(`release savepoint ${name}`);
    }
    expect(code).not.toBeNull();
    expect(resolutionCodes.has(code ?? '')).toBe(false);
    expect(codes).toContain(code);
    return code ?? '';
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({ schoolId, userId: randomUUID(), membershipId: randomUUID() });
    const moderatorA = member(schoolA);
    const parentA = member(schoolA);
    const parentA2 = member(schoolA);
    const parentB = member(schoolB);
    const joiner = { userId: randomUUID() };
    const codeJoiner = { userId: randomUUID() };
    const members = [moderatorA, parentA, parentA2, parentB];
    const userIds = [...members.map((item) => item.userId), joiner.userId, codeJoiner.userId];
    await query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'yourturn_test_ Invite A', 'Australia/Melbourne'),
             ($3, $4, 'yourturn_test_ Invite B', 'Australia/Sydney')`,
    [schoolA, `g1a-${schoolA}`, schoolB, `g1b-${schoolB}`]);
    await query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated', 'g1-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"yourturn_test_ Invite"}'::jsonb, now(), now()
      from unnest($1::uuid[]) u(id)`, [userIds]);
    await query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, 'verified'::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[]) m(id, school_id, user_id)`, [
      members.map((item) => item.membershipId),
      members.map((item) => item.schoolId),
      members.map((item) => item.userId),
    ]);
    await query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`, [randomUUID(), moderatorA.userId, schoolA]);
    await query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Invite A', 'Synthetic safety declaration A', true, now()),
             ($3, $4, 1, 'Invite B', 'Synthetic safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    await query(`insert into public.safety_declarations
      (id, membership_id, parent_id, school_id, declaration_version_id,
       licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      select id, membership_id, parent_id, school_id, declaration_id, true, true, true, true
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
        s(id, membership_id, parent_id, school_id, declaration_id)`, [
      members.map(() => randomUUID()),
      members.map((item) => item.membershipId),
      members.map((item) => item.userId),
      members.map((item) => item.schoolId),
      members.map((item) => item.schoolId === schoolA ? declarationA : declarationB),
    ]);
    return { schoolA, schoolB, moderatorA, parentA, parentA2, parentB, joiner, codeJoiner, userIds };
  }

  async function schoolToken(): Promise<string> {
    const rows = await authenticated<{ invitation_token: string }>(
      fixture.moderatorA.userId,
      'select invitation_token from public.create_school_invitation($1)',
      [fixture.schoolA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].invitation_token).toMatch(/^[a-f0-9]{48}$/);
    return rows[0].invitation_token;
  }

  async function householdToken(): Promise<string> {
    const rows = await authenticated<{ create_household_link_invitation: string }>(
      fixture.parentA.userId,
      'select public.create_household_link_invitation()',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].create_household_link_invitation).toMatch(/^[a-f0-9]{48}$/);
    return rows[0].create_household_link_invitation;
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for invitation live tests.');
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
    try { await client.connect(); }
    catch { throw new Error('Unable to connect to the dedicated RLS test database; connection details suppressed.'); }
    await query('begin');
    await query(`set local timezone = 'UTC'; set local row_security = on;
      set local statement_timeout = '20s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: synthetic two-school invitation principals', seed);
  }, LIVE_TIMEOUT);

  beforeEach(async () => {
    caseSavepoint = `g1_case_${++savepointNumber}`;
    await query(`savepoint ${caseSavepoint}`);
  });

  afterEach(async () => {
    if (caseSavepoint) {
      await query(`rollback to savepoint ${caseSavepoint}`);
      await query(`release savepoint ${caseSavepoint}`);
    }
  });

  afterAll(async () => {
    try { if (client) await client.query('rollback'); }
    finally { if (client) await client.end(); client = undefined; }
  }, LIVE_TIMEOUT);

  it('open valid token returns opened and records opened status', async () => {
    const token = await schoolToken();
    const opened = await authenticated<{ open_school_invitation: string }>(
      fixture.parentB.userId,
      'select public.open_school_invitation($1)',
      [token],
    );
    expect(opened).toEqual([{ open_school_invitation: 'opened' }]);
    const status = await privileged('fixture: read opened invitation status', () => query<{ status: string; opened: boolean }>(
      `select status::text as status, opened_at is not null as opened
       from public.school_invitations where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
      [token],
    ));
    expect(status.rows).toEqual([{ status: 'opened', opened: true }]);
  });

  it('open invalid token returns unavailable without a resolution error', async () => {
    const rows = await authenticated<{ open_school_invitation: string }>(
      fixture.parentB.userId,
      "select public.open_school_invitation(repeat('0', 48))",
    );
    expect(rows).toEqual([{ open_school_invitation: 'unavailable' }]);
  });

  it('open expired token returns unavailable', async () => {
    const token = 'a'.repeat(48);
    await privileged('fixture: expired school invitation', () => query(
      `insert into public.school_invitations (school_id, invited_by, token_hash, status, sent_at, expires_at)
       values ($1, $2, encode(extensions.digest($3, 'sha256'), 'hex'), 'sent', now() - interval '2 days', now() - interval '1 day')`,
      [fixture.schoolA, fixture.moderatorA.userId, token],
    ));
    const rows = await authenticated<{ open_school_invitation: string }>(
      fixture.parentB.userId,
      'select public.open_school_invitation($1)',
      [token],
    );
    expect(rows).toEqual([{ open_school_invitation: 'unavailable' }]);
  });

  it('claim school invitation creates a pending membership for a valid token', async () => {
    const token = await schoolToken();
    const claimed = await authenticated<{ claim_school_invitation: string }>(
      fixture.joiner.userId,
      'select public.claim_school_invitation($1)',
      [token],
    );
    expect(claimed).toEqual([{ claim_school_invitation: 'pending' }]);
    const membership = await privileged('fixture: read claimed school membership', () => query<{ status: string; school_id: string; joined: boolean }>(
      `select m.status::text as status, m.school_id::text as school_id,
        (i.status = 'joined' and i.joined_by = $2) as joined
       from public.school_memberships m
       join public.school_invitations i on i.school_id = m.school_id and i.joined_by = m.user_id
       where m.user_id = $2 and m.school_id = $1`,
      [fixture.schoolA, fixture.joiner.userId],
    ));
    expect(membership.rows).toEqual([{ status: 'pending', school_id: fixture.schoolA, joined: true }]);
  });

  it('claim school invitation rejects an invalid token', async () => {
    const code = await denied(
      () => authenticated(fixture.joiner.userId, "select public.claim_school_invitation(repeat('b', 48))"),
      ['P0002'],
    );
    expect(code).toBe('P0002');
  });

  it('claim school invitation rejects an expired token', async () => {
    const token = 'c'.repeat(48);
    await privileged('fixture: expired claim invitation', () => query(
      `insert into public.school_invitations (school_id, invited_by, token_hash, status, sent_at, expires_at)
       values ($1, $2, encode(extensions.digest($3, 'sha256'), 'hex'), 'sent', now() - interval '2 days', now() - interval '1 day')`,
      [fixture.schoolA, fixture.moderatorA.userId, token],
    ));
    const code = await denied(
      () => authenticated(fixture.joiner.userId, 'select public.claim_school_invitation($1)', [token]),
      ['P0002'],
    );
    expect(code).toBe('P0002');
    const membership = await privileged('fixture: confirm expired claim wrote nothing', () => query(
      'select id from public.school_memberships where user_id = $1 and school_id = $2',
      [fixture.joiner.userId, fixture.schoolA],
    ));
    expect(membership.rows).toEqual([]);
  });

  it('redeem valid invite code creates a pending membership', async () => {
    const label = `g1-${randomUUID()}`;
    await privileged('fixture: active school invite code', () => query(
      `insert into public.school_invite_codes (school_id, code_hash, label, expires_at, max_uses)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now() + interval '7 days', 5)`,
      [fixture.schoolA, 'G1VALIDCODE', label],
    ));
    const redeemed = await authenticated<{ redeem_school_invite_code: string }>(
      fixture.codeJoiner.userId,
      'select public.redeem_school_invite_code($1, $2)',
      [fixture.schoolA, 'G1VALIDCODE'],
    );
    expect(redeemed).toEqual([{ redeem_school_invite_code: 'pending' }]);
    const membership = await privileged('fixture: read redeemed pending membership', () => query<{ status: string; uses: number }>(
      `select m.status::text as status, c.use_count as uses
       from public.school_memberships m
       join public.school_invite_codes c on c.school_id = m.school_id and c.label = $3
       where m.user_id = $1 and m.school_id = $2`,
      [fixture.codeJoiner.userId, fixture.schoolA, label],
    ));
    expect(membership.rows).toEqual([{ status: 'pending', uses: 1 }]);
  });

  it('redeem rejects an invalid code', async () => {
    const redeemed = await authenticated<{ redeem_school_invite_code: string }>(
      fixture.codeJoiner.userId,
      'select public.redeem_school_invite_code($1, $2)',
      [fixture.schoolA, 'NOT-A-REAL-CODE'],
    );
    expect(redeemed).toEqual([{ redeem_school_invite_code: 'invalid' }]);
    const membership = await privileged('fixture: confirm invalid code wrote no membership', () => query(
      'select id from public.school_memberships where user_id = $1 and school_id = $2',
      [fixture.codeJoiner.userId, fixture.schoolA],
    ));
    expect(membership.rows).toEqual([]);
  });

  it('redeem rejects an expired code and creates no membership', async () => {
    const label = `g1-expired-${randomUUID()}`;
    await privileged('fixture: expired school invite code', () => query(
      `insert into public.school_invite_codes (school_id, code_hash, label, created_at, expires_at, max_uses)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now() - interval '2 days', now() - interval '1 day', 5)`,
      [fixture.schoolA, 'G1EXPIREDCODE', label],
    ));
    const redeemed = await authenticated<{ redeem_school_invite_code: string }>(
      fixture.codeJoiner.userId,
      'select public.redeem_school_invite_code($1, $2)',
      [fixture.schoolA, 'G1EXPIREDCODE'],
    );
    expect(redeemed).toEqual([{ redeem_school_invite_code: 'invalid' }]);
    const membership = await privileged('fixture: confirm expired code wrote nothing', () => query(
      'select id from public.school_memberships where user_id = $1 and school_id = $2',
      [fixture.codeJoiner.userId, fixture.schoolA],
    ));
    expect(membership.rows).toEqual([]);
  });

  it('claim household invitation confirms the link for a valid token', async () => {
    const token = await householdToken();
    const claimed = await authenticated<{ claim_household_link_invitation: string }>(
      fixture.parentA2.userId,
      'select public.claim_household_link_invitation($1)',
      [token],
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0].claim_household_link_invitation).toMatch(/^[0-9a-f-]{36}$/);
    const link = await privileged('fixture: read confirmed household link', () => query<{ status: string; claimed: boolean }>(
      `select l.status::text as status, (i.claimed_by = $1::uuid) as claimed
       from public.household_links l
       join public.household_link_invitations i on i.school_id = l.school_id and i.claimed_by = $1::uuid
       where l.id = $2::uuid`,
      [fixture.parentA2.userId, claimed[0].claim_household_link_invitation],
    ));
    expect(link.rows).toEqual([{ status: 'confirmed', claimed: true }]);
  });

  it('claim household invitation rejects an invalid token', async () => {
    const code = await denied(
      () => authenticated(fixture.parentA2.userId, "select public.claim_household_link_invitation(repeat('d', 48))"),
      ['P0002'],
    );
    expect(code).toBe('P0002');
  });

  it('claim household invitation rejects an expired token', async () => {
    const token = 'e'.repeat(48);
    await privileged('fixture: expired household invitation', () => query(
      `insert into public.household_link_invitations (school_id, invited_by, token_hash, created_at, expires_at)
       values ($1, $2, encode(extensions.digest($3, 'sha256'), 'hex'), now() - interval '2 days', now() - interval '1 day')`,
      [fixture.schoolA, fixture.parentA.userId, token],
    ));
    const code = await denied(
      () => authenticated(fixture.parentA2.userId, 'select public.claim_household_link_invitation($1)', [token]),
      ['P0002'],
    );
    expect(code).toBe('P0002');
  });

  it('school B user cannot claim a school A household invitation', async () => {
    const token = await householdToken();
    const code = await denied(
      () => authenticated(fixture.parentB.userId, 'select public.claim_household_link_invitation($1)', [token]),
      ['P0002'],
    );
    expect(code).toBe('P0002');
    const links = await privileged('fixture: confirm cross-school household claim wrote nothing', () => query(
      `select id from public.household_links
       where school_id = $1 and (first_parent_id = $2 or second_parent_id = $2)`,
      [fixture.schoolA, fixture.parentB.userId],
    ));
    expect(links.rows).toEqual([]);
  });

  it('school B user cannot claim a school A invitation already joined by someone else', async () => {
    const token = await schoolToken();
    const claimed = await authenticated<{ claim_school_invitation: string }>(
      fixture.joiner.userId,
      'select public.claim_school_invitation($1)',
      [token],
    );
    expect(claimed).toEqual([{ claim_school_invitation: 'pending' }]);
    const code = await denied(
      () => authenticated(fixture.parentB.userId, 'select public.claim_school_invitation($1)', [token]),
      ['P0002'],
    );
    expect(code).toBe('P0002');
    const membership = await privileged('fixture: confirm school B gained no school A membership', () => query(
      'select id from public.school_memberships where user_id = $1 and school_id = $2',
      [fixture.parentB.userId, fixture.schoolA],
    ));
    expect(membership.rows).toEqual([]);
    const visible = await authenticated(
      fixture.parentB.userId,
      'select id from public.schools where id = $1',
      [fixture.schoolA],
    );
    expect(visible).toEqual([]);
  });

  it('school B user cannot redeem a school A code into school B', async () => {
    const label = `g1-cross-${randomUUID()}`;
    await privileged('fixture: school A code for cross-school redeem', () => query(
      `insert into public.school_invite_codes (school_id, code_hash, label, expires_at, max_uses)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now() + interval '7 days', 5)`,
      [fixture.schoolA, 'G1CROSSCODE', label],
    ));
    const ownSchool = await authenticated<{ status: string }>(
      fixture.parentB.userId,
      'select public.redeem_school_invite_code($1, $2) as status',
      [fixture.schoolB, 'G1CROSSCODE'],
    );
    expect(ownSchool).toEqual([{ status: 'already_verified' }]);
    const wrongSchool = await authenticated<{ status: string }>(
      fixture.codeJoiner.userId,
      'select public.redeem_school_invite_code($1, $2) as status',
      [fixture.schoolB, 'G1CROSSCODE'],
    );
    expect(wrongSchool).toEqual([{ status: 'invalid' }]);
    const membership = await privileged('fixture: confirm cross-school redeem wrote nothing', () => query<{ uses: number; parent_b_at_a: number; joiner_memberships: number }>(
      `select c.use_count as uses,
        (select count(*)::int from public.school_memberships m where m.user_id = $2::uuid and m.school_id = $1::uuid) as parent_b_at_a,
        (select count(*)::int from public.school_memberships m where m.user_id = $4::uuid) as joiner_memberships
       from public.school_invite_codes c where c.label = $3`,
      [fixture.schoolA, fixture.parentB.userId, label, fixture.codeJoiner.userId],
    ));
    expect(membership.rows).toEqual([{ uses: 0, parent_b_at_a: 0, joiner_memberships: 0 }]);
  });

  it('anonymous callers cannot execute the four invitation functions', async () => {
    await denied(() => anonymous("select public.open_school_invitation(repeat('0', 48))"), ['42501']);
    await denied(() => anonymous("select public.claim_school_invitation(repeat('0', 48))"), ['42501']);
    await denied(() => anonymous('select public.redeem_school_invite_code($1, $2)', [fixture.schoolA, 'G1ANONCODE']), ['42501']);
    await denied(() => anonymous("select public.claim_household_link_invitation(repeat('0', 48))"), ['42501']);
  });

  it('catalogue paths grants and unqualified extension query', async () => {
    const functions = await authenticated<{
      name: string; args: string; result: string; path: string[]; anon_execute: boolean; auth_execute: boolean; qualified: boolean;
    }>(fixture.parentA.userId, `select p.proname as name,
      pg_catalog.oidvectortypes(p.proargtypes) as args,
      p.prorettype::regtype::text as result,
      array(select s from unnest(p.proconfig) s where s like 'search_path=%') as path,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
      position('extensions.' in p.prosrc) > 0 as qualified
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[])
      order by p.proname`, [[
      'claim_household_link_invitation', 'claim_school_invitation', 'open_school_invitation', 'redeem_school_invite_code',
    ]]);
    expect(functions).toEqual([
      { name: 'claim_household_link_invitation', args: 'text', result: 'uuid', path: ['search_path=pg_catalog'], anon_execute: false, auth_execute: true, qualified: true },
      { name: 'claim_school_invitation', args: 'text', result: 'text', path: ['search_path=pg_catalog'], anon_execute: false, auth_execute: true, qualified: true },
      { name: 'open_school_invitation', args: 'text', result: 'text', path: ['search_path=pg_catalog'], anon_execute: false, auth_execute: true, qualified: true },
      { name: 'redeem_school_invite_code', args: 'uuid, text', result: 'text', path: ['search_path=pg_catalog'], anon_execute: false, auth_execute: true, qualified: true },
    ]);
    const unqualified = await authenticated<{ proname: string }>(fixture.parentA.userId, `select p.proname
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosrc ~* '(gen_random_bytes|digest\\(|crypt\\(|gen_salt)'
        and p.prosrc !~* 'extensions\\.'`);
    expect(unqualified).toEqual([]);
  });
});
