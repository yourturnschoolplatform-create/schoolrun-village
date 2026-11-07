/**
 * Task 9.2 live suite: listing collected/fulfilled, withdrawal, reporting,
 * auto-hide and own-school moderator review. Authenticated + synthetic JWT;
 * ROLLBACK. Cross-school denials included.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  author: Member;
  parentA2: Member;
  parentA3: Member;
  parentA4: Member;
  moderatorA: Member;
  parentB: Member;
  moderatorB: Member;
};

type Listing = {
  id: string;
  school_id: string;
  status: string;
  title: string;
  display_offer_label: string;
};

describe('Task 9.2 live listing status and moderation', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Listing moderation live test connection is not initialised.');
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
    const name = `listing_mod_denial_${++savepointNumber}`;
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

  async function createListing(author: Member, title: string): Promise<Listing> {
    const rows = await authenticated<{ create_item_listing: Listing }>(
      author.userId,
      `select public.create_item_listing('giveaway', $1, $2, 'clothing', 'Free')
         as create_item_listing`,
      [title, `${title} description for free school giveaway only`],
    );
    return rows[0].create_item_listing;
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({
      schoolId, userId: randomUUID(), membershipId: randomUUID(),
    });
    const author = member(schoolA);
    const parentA2 = member(schoolA);
    const parentA3 = member(schoolA);
    const parentA4 = member(schoolA);
    const moderatorA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [author, parentA2, parentA3, parentA4, moderatorA, parentB, moderatorB];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Listing Mod School A', 'Australia/Sydney'),
             ($3, $4, 'Listing Mod School B', 'Australia/Melbourne')`,
    [schoolA, `lmod-a-${schoolA}`, schoolB, `lmod-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'lmod-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', 'Parent ' || left(id::text, 8)), now(), now()
      from unnest($1::uuid[]) as u(id)`, [members.map((m) => m.userId)]);
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
      values ($1, $2, $3, 'moderator', now(), $2),
             ($4, $5, $6, 'moderator', now(), $5)`,
    [randomUUID(), moderatorA.userId, schoolA, randomUUID(), moderatorB.userId, schoolB]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Listing Mod A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Listing Mod B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, author, parentA2, parentA3, parentA4, moderatorA, parentB, moderatorB,
    };
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for listing moderation live tests.');
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
    fixture = await privileged('fixture: unique two-school listing moderation onboarding', seed);
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

  it('authorCollectedFulfilledWithdraw: author marks collected fulfilled and withdraws; search drops closed listings', async () => {
    const collectedListing = await createListing(fixture.author, 'Collected raincoat spare');
    const fulfilledListing = await createListing(fixture.author, 'Fulfilled school jumper lend');
    const withdrawnListing = await createListing(fixture.author, 'Withdrawn sports shorts');

    const collected = await authenticated<{ mark_item_listing_collected: Listing }>(
      fixture.author.userId,
      'select public.mark_item_listing_collected($1::uuid) as mark_item_listing_collected',
      [collectedListing.id],
    );
    expect(collected[0].mark_item_listing_collected.status).toBe('collected');
    expect(JSON.stringify(collected[0].mark_item_listing_collected))
      .not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);

    const fulfilled = await authenticated<{ mark_item_listing_fulfilled: Listing }>(
      fixture.author.userId,
      'select public.mark_item_listing_fulfilled($1::uuid) as mark_item_listing_fulfilled',
      [fulfilledListing.id],
    );
    expect(fulfilled[0].mark_item_listing_fulfilled.status).toBe('fulfilled');

    const withdrawn = await authenticated<{ withdraw_item_listing: Listing }>(
      fixture.author.userId,
      'select public.withdraw_item_listing($1::uuid) as withdraw_item_listing',
      [withdrawnListing.id],
    );
    expect(withdrawn[0].withdraw_item_listing.status).toBe('withdrawn');

    const searched = await authenticated<{ search_item_listings: Listing[] }>(
      fixture.parentA2.userId,
      `select public.search_item_listings(null, null, null) as search_item_listings`,
    );
    const ids = searched[0].search_item_listings.map((row) => row.id);
    expect(ids).not.toContain(collectedListing.id);
    expect(ids).not.toContain(fulfilledListing.id);
    expect(ids).not.toContain(withdrawnListing.id);

    await denied(() => authenticated(fixture.parentA2.userId,
      'select public.mark_item_listing_collected($1::uuid)', [collectedListing.id]));
    await denied(() => authenticated(fixture.author.userId,
      'select public.withdraw_item_listing($1::uuid)', [collectedListing.id]));
  });

  it('reportAutoHideRestoreRemove: three unique reports auto-hide; moderator restore remove and queue', async () => {
    const listing = await createListing(fixture.author, 'Auto hide school bag');

    const first = await authenticated<{ report_item_listing: {
      outcome: string; report_count: number; status: string;
    } }>(
      fixture.parentA2.userId,
      'select public.report_item_listing($1::uuid, $2::text) as report_item_listing',
      [listing.id, 'Looks like a restricted household item listing'],
    );
    expect(first[0].report_item_listing).toMatchObject({
      outcome: 'reported', report_count: 1, status: 'active',
    });

    const second = await authenticated<{ report_item_listing: { report_count: number } }>(
      fixture.parentA3.userId,
      'select public.report_item_listing($1::uuid, $2::text) as report_item_listing',
      [listing.id, 'Concern about unsafe item wording'],
    );
    expect(second[0].report_item_listing.report_count).toBe(2);

    const third = await authenticated<{ report_item_listing: {
      outcome: string; report_count: number; status: string;
    } }>(
      fixture.parentA4.userId,
      'select public.report_item_listing($1::uuid, $2::text) as report_item_listing',
      [listing.id, 'Third unique report for moderation'],
    );
    expect(third[0].report_item_listing).toMatchObject({
      outcome: 'auto_hidden', report_count: 3, status: 'hidden',
    });

    const queue = await authenticated<{ list_listing_moderation_queue: Array<{ id: string; status: string }> }>(
      fixture.moderatorA.userId,
      'select public.list_listing_moderation_queue() as list_listing_moderation_queue',
    );
    expect(queue[0].list_listing_moderation_queue.map((row) => row.id)).toContain(listing.id);

    const restored = await authenticated<{ restore_item_listing: { outcome: string; status: string } }>(
      fixture.moderatorA.userId,
      'select public.restore_item_listing($1::uuid) as restore_item_listing',
      [listing.id],
    );
    expect(restored[0].restore_item_listing).toMatchObject({ outcome: 'restored', status: 'active' });

    const hidden = await authenticated<{ hide_item_listing: { outcome: string; status: string } }>(
      fixture.moderatorA.userId,
      'select public.hide_item_listing($1::uuid) as hide_item_listing',
      [listing.id],
    );
    expect(hidden[0].hide_item_listing).toMatchObject({ outcome: 'hidden', status: 'hidden' });

    const removed = await authenticated<{ remove_item_listing: { outcome: string; status: string } }>(
      fixture.moderatorA.userId,
      'select public.remove_item_listing($1::uuid) as remove_item_listing',
      [listing.id],
    );
    expect(removed[0].remove_item_listing).toMatchObject({ outcome: 'removed', status: 'withdrawn' });

    await denied(() => authenticated(fixture.parentA2.userId,
      'select public.hide_item_listing($1::uuid)', [listing.id]));
    await denied(() => authenticated(fixture.author.userId,
      'select public.report_item_listing($1::uuid, $2)',
      [listing.id, 'Author cannot report own listing']));
  });

  it('crossSchoolDenials: School B cannot status-change report or moderate School A listings', async () => {
    const listing = await createListing(fixture.author, 'Cross school listing jacket');

    await denied(() => authenticated(fixture.parentB.userId,
      'select public.mark_item_listing_collected($1::uuid)', [listing.id]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.withdraw_item_listing($1::uuid)', [listing.id]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.report_item_listing($1::uuid, $2)',
      [listing.id, 'Foreign school report should fail']));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.hide_item_listing($1::uuid)', [listing.id]));

    const foreignQueue = await authenticated<{ list_listing_moderation_queue: unknown[] }>(
      fixture.moderatorB.userId,
      'select public.list_listing_moderation_queue() as list_listing_moderation_queue',
    );
    expect(foreignQueue[0].list_listing_moderation_queue).toEqual([]);

    const foreignSearch = await authenticated<{ search_item_listings: Listing[] }>(
      fixture.parentB.userId,
      `select public.search_item_listings('jacket', null, null) as search_item_listings`,
    );
    expect(foreignSearch[0].search_item_listings).toEqual([]);
  });

  it('noDirectDmlAndCatalog: clients cannot write report or action tables; RLS and paths hold', async () => {
    const listing = await createListing(fixture.author, 'Direct DML listing scarf');

    await denied(() => authenticated(fixture.parentA2.userId,
      `insert into public.listing_reports
        (school_id, listing_id, reporter_id, reporter_membership, reason)
       values ($1, $2, $3, $4, 'Bypass report')`,
      [fixture.schoolA, listing.id, fixture.parentA2.userId, fixture.parentA2.membershipId]));
    await denied(() => authenticated(fixture.moderatorA.userId,
      `insert into public.listing_moderation_actions
        (school_id, listing_id, action, actor_id, actor_membership)
       values ($1, $2, 'hide', $3, $4)`,
      [fixture.schoolA, listing.id, fixture.moderatorA.userId, fixture.moderatorA.membershipId]));
    await denied(() => authenticated(fixture.author.userId,
      'update public.item_listings set status = $2 where id = $1',
      [listing.id, 'collected']),
    ['42501', '55000']);

    const catalog = await privileged('read-back: listing moderation catalog', async () => {
      const tables = await db().query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname in ('listing_reports', 'listing_moderation_actions')
         order by c.relname`);
      const cols = await db().query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public'
           and table_name in ('listing_reports', 'listing_moderation_actions', 'item_listings')`);
      const status = await db().query<{ check_clause: string }>(
        `select pg_get_constraintdef(c.oid) as check_clause
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'public' and t.relname = 'item_listings'
           and c.conname = 'item_listings_status_check'`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'mark_item_listing_collected', 'mark_item_listing_fulfilled',
             'withdraw_item_listing', 'report_item_listing',
             'hide_item_listing', 'restore_item_listing',
             'remove_item_listing', 'list_listing_moderation_queue',
             'listing_apply_status', 'listing_author_transition',
             'guard_listing_moderation', 'listing_require_moderator_membership'
           )
         order by p.proname`);
      return { tables: tables.rows, cols: cols.rows, status: status.rows, grants: grants.rows };
    });

    expect(catalog.tables.every((t) => t.relrowsecurity)).toBe(true);
    expect(catalog.cols.map((c) => c.column_name).join(','))
      .not.toMatch(/\b(amount|price|currency|payment|phone|mobile|nickname|photo|latitude|longitude|email)\b/i);
    expect(catalog.status[0].check_clause).toMatch(/collected/);
    expect(catalog.status[0].check_clause).toMatch(/fulfilled/);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'hide_item_listing',
      'list_listing_moderation_queue',
      'mark_item_listing_collected',
      'mark_item_listing_fulfilled',
      'remove_item_listing',
      'report_item_listing',
      'restore_item_listing',
      'withdraw_item_listing',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
