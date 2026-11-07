/**
 * Task 9.3 live suite: global admin restricted-item catalogue create/update/
 * soft-deactivate with enforcement. Authenticated + synthetic JWT; ROLLBACK.
 * Non-admin and cross-school denials included.
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

type RestrictedItem = {
  id: string;
  slug: string;
  label: string;
  match_terms: string[];
  is_active: boolean;
};

describe('Task 9.3 live admin restricted listing catalogue', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Restricted items admin live test connection is not initialised.');
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
    const name = `restricted_admin_denial_${++savepointNumber}`;
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
      values ($1, $2, 'Restricted Admin School A', 'Australia/Sydney'),
             ($3, $4, 'Restricted Admin School B', 'Australia/Melbourne')`,
    [schoolA, `radm-a-${schoolA}`, schoolB, `radm-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'radm-' || id::text || '@example.invalid', now(),
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
      values ($1, $2, 1, 'Restricted A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Restricted B', 'Synthetic school safety declaration B', true, now())`,
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
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for restricted items admin live tests.');
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
    fixture = await privileged('fixture: unique two-school restricted admin onboarding', seed);
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

  it('adminCreateUpdateDeactivate: admin manages catalogue and enforcement follows active terms', async () => {
    const slug = `bean_bag_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const created = await authenticated<{ create_restricted_listing_item: RestrictedItem }>(
      fixture.admin.userId,
      `select public.create_restricted_listing_item($1::text, $2::text, $3::text[])
         as create_restricted_listing_item`,
      [slug, 'Bean bags', ['bean bag', 'bean bags']],
    );
    expect(created[0].create_restricted_listing_item.slug).toBe(slug);
    expect(created[0].create_restricted_listing_item.is_active).toBe(true);
    expect(created[0].create_restricted_listing_item.match_terms).toEqual(
      expect.arrayContaining(['bean bag', 'bean bags']),
    );
    expect(JSON.stringify(created[0].create_restricted_listing_item))
      .not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);

    await denied(
      () => authenticated(fixture.parentA.userId,
        `select public.create_item_listing('giveaway', $1, $2, 'household', 'Free')`,
        ['Bean bag lounge seat', 'Soft bean bag free to a school family']),
      ['22023'],
    );

    const updated = await authenticated<{ update_restricted_listing_item: RestrictedItem }>(
      fixture.admin.userId,
      `select public.update_restricted_listing_item($1::uuid, $2::text, $3::text[], $4::boolean)
         as update_restricted_listing_item`,
      [created[0].create_restricted_listing_item.id, 'Bean bag furniture', ['bean bag lounge'], true],
    );
    expect(updated[0].update_restricted_listing_item.label).toBe('Bean bag furniture');
    expect(updated[0].update_restricted_listing_item.match_terms).toEqual(['bean bag lounge']);

    const deactivated = await authenticated<{ update_restricted_listing_item: RestrictedItem }>(
      fixture.admin.userId,
      `select public.update_restricted_listing_item($1::uuid, $2::text, $3::text[], false)
         as update_restricted_listing_item`,
      [created[0].create_restricted_listing_item.id, 'Bean bag furniture', ['bean bag lounge']],
    );
    expect(deactivated[0].update_restricted_listing_item.is_active).toBe(false);

    const allowed = await authenticated<{ create_item_listing: { id: string; title: string } }>(
      fixture.parentA.userId,
      `select public.create_item_listing('giveaway', $1, $2, 'household', 'Free')
         as create_item_listing`,
      ['Bean bag lounge seat', 'Soft bean bag lounge free after deactivation'],
    );
    expect(allowed[0].create_item_listing.title).toContain('Bean bag');

    const adminList = await authenticated<{ list_all_restricted_listing_items: RestrictedItem[] }>(
      fixture.admin.userId,
      'select public.list_all_restricted_listing_items() as list_all_restricted_listing_items',
    );
    expect(adminList[0].list_all_restricted_listing_items.some(
      (row) => row.id === created[0].create_restricted_listing_item.id && row.is_active === false,
    )).toBe(true);

    const memberList = await authenticated<{ list_restricted_listing_items: Array<{ slug: string }> }>(
      fixture.parentA.userId,
      'select public.list_restricted_listing_items() as list_restricted_listing_items',
    );
    expect(memberList[0].list_restricted_listing_items.map((row) => row.slug)).not.toContain(slug);
  });

  it('nonAdminAndCrossSchoolDenials: parents and school moderators cannot mutate catalogue', async () => {
    await denied(() => authenticated(fixture.parentA.userId,
      `select public.create_restricted_listing_item('parent_block', 'Parent block', array['parent block'])`));
    await denied(() => authenticated(fixture.moderatorA.userId,
      `select public.create_restricted_listing_item('mod_a_block', 'Moderator A block', array['mod a block'])`));
    await denied(() => authenticated(fixture.moderatorB.userId,
      `select public.create_restricted_listing_item('mod_b_block', 'Moderator B block', array['mod b block'])`));
    await denied(() => authenticated(fixture.parentA.userId,
      'select public.list_all_restricted_listing_items()'));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.list_all_restricted_listing_items()'));

    const seeded = await authenticated<{ create_restricted_listing_item: RestrictedItem }>(
      fixture.admin.userId,
      `select public.create_restricted_listing_item($1::text, $2::text, $3::text[])
         as create_restricted_listing_item`,
      [`denial_${randomUUID().replace(/-/g, '').slice(0, 8)}`, 'Denial item', ['denial item']],
    );
    await denied(() => authenticated(fixture.moderatorA.userId,
      `select public.update_restricted_listing_item($1::uuid, $2::text, $3::text[], false)`,
      [seeded[0].create_restricted_listing_item.id, 'Denial item', ['denial item']]));
    await denied(() => authenticated(fixture.parentA.userId,
      `insert into public.listing_restricted_items (slug, label, match_terms)
       values ('client_insert', 'Client insert', array['client insert'])`),
    ['42501', '55000']);
  });

  it('catalogAllowlistAndSearchPath: admin RPCs allowlisted with pg_catalog paths; no money fields', async () => {
    const catalog = await privileged('read-back: restricted admin catalog', async () => {
      const table = await db().query<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'listing_restricted_items'`);
      const cols = await db().query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'listing_restricted_items'`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_restricted_listing_item', 'update_restricted_listing_item',
             'list_all_restricted_listing_items', 'listing_require_admin',
             'listing_normalise_match_terms', 'listing_restricted_item_json',
             'guard_listing_restricted_items'
           )
         order by p.proname`);
      return { table: table.rows[0], cols: cols.rows, grants: grants.rows };
    });

    expect(catalog.table.relrowsecurity).toBe(true);
    expect(catalog.cols.map((c) => c.column_name).join(','))
      .not.toMatch(/\b(amount|price|currency|payment|phone|mobile|nickname|photo|latitude|longitude|email)\b/i);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'create_restricted_listing_item',
      'list_all_restricted_listing_items',
      'update_restricted_listing_item',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
