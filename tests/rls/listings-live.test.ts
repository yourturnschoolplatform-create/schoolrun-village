/**
 * Task 9.1 live suite: school-scoped free giveaway/lending listings,
 * restricted-item enforcement, search/filter, and enquiries.
 * Authenticated + synthetic JWT; ROLLBACK. Cross-school denials included.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  parentA1: Member;
  parentA2: Member;
  parentB: Member;
  moderatorB: Member;
};

type Listing = {
  id: string;
  school_id: string;
  listing_kind: string;
  title: string;
  category: string;
  display_offer_label: string;
  status: string;
};

describe('Task 9.1 live school-scoped free item listings', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Listings live test connection is not initialised.');
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
    const name = `listings_denial_${++savepointNumber}`;
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
    const parentA1 = member(schoolA);
    const parentA2 = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [parentA1, parentA2, parentB, moderatorB];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Listings School A', 'Australia/Sydney'),
             ($3, $4, 'Listings School B', 'Australia/Melbourne')`,
    [schoolA, `list-a-${schoolA}`, schoolB, `list-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'listings-' || id::text || '@example.invalid', now(),
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
      values ($1, $2, $3, 'moderator', now(), $2)`,
    [randomUUID(), moderatorB.userId, schoolB]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Listings A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Listings B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return { schoolA, schoolB, parentA1, parentA2, parentB, moderatorB };
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for listings live tests.');
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
    fixture = await privileged('fixture: unique two-school listings onboarding', seed);
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

  it('createSearchFilterEnquiry: same-school create search filter get and enquiry flow', async () => {
    const created = await authenticated<{ create_item_listing: Listing }>(
      fixture.parentA1.userId,
      `select public.create_item_listing($1::text, $2::text, $3::text, $4::text, $5::text)
         as create_item_listing`,
      ['giveaway', 'Spare school jumper size eight',
        'Gently used navy jumper free to a family at our school.',
        'clothing', 'Free'],
    );
    expect(created[0].create_item_listing.school_id).toBe(fixture.schoolA);
    expect(created[0].create_item_listing.listing_kind).toBe('giveaway');
    expect(created[0].create_item_listing.display_offer_label).toBe('Free');
    expect(JSON.stringify(created[0].create_item_listing))
      .not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);

    const lending = await authenticated<{ create_item_listing: Listing }>(
      fixture.parentA1.userId,
      `select public.create_item_listing($1::text, $2::text, $3::text, $4::text, $5::text)
         as create_item_listing`,
      ['lending', 'Board game weekend lend',
        'Happy to lend our family board game for one weekend.',
        'toys', 'Lending only'],
    );
    expect(lending[0].create_item_listing.listing_kind).toBe('lending');
    expect(lending[0].create_item_listing.display_offer_label).toBe('Lending only');

    const searched = await authenticated<{ search_item_listings: Listing[] }>(
      fixture.parentA2.userId,
      `select public.search_item_listings($1::text, $2::text, $3::text) as search_item_listings`,
      ['jumper', 'giveaway', 'clothing'],
    );
    expect(searched[0].search_item_listings.map((row) => row.id))
      .toContain(created[0].create_item_listing.id);
    expect(searched[0].search_item_listings.every((row) => row.listing_kind === 'giveaway')).toBe(true);
    expect(searched[0].search_item_listings.every((row) => row.category.toLowerCase() === 'clothing')).toBe(true);

    const filteredKind = await authenticated<{ search_item_listings: Listing[] }>(
      fixture.parentA2.userId,
      `select public.search_item_listings($1::text, $2::text, $3::text) as search_item_listings`,
      [null, 'lending', null],
    );
    expect(filteredKind[0].search_item_listings.map((row) => row.id))
      .toContain(lending[0].create_item_listing.id);
    expect(filteredKind[0].search_item_listings.map((row) => row.id))
      .not.toContain(created[0].create_item_listing.id);

    const got = await authenticated<{ get_item_listing: Listing }>(
      fixture.parentA2.userId,
      'select public.get_item_listing($1::uuid) as get_item_listing',
      [created[0].create_item_listing.id],
    );
    expect(got[0].get_item_listing.id).toBe(created[0].create_item_listing.id);

    const enquiry = await authenticated<{ create_listing_enquiry: {
      id: string; listing_id: string; body: string;
    } }>(
      fixture.parentA2.userId,
      'select public.create_listing_enquiry($1::uuid, $2::text) as create_listing_enquiry',
      [created[0].create_item_listing.id, 'Happy to collect after Friday pickup.'],
    );
    expect(enquiry[0].create_listing_enquiry.listing_id).toBe(created[0].create_item_listing.id);

    const ownerList = await authenticated<{ list_listing_enquiries: Array<{ id: string }> }>(
      fixture.parentA1.userId,
      'select public.list_listing_enquiries($1::uuid) as list_listing_enquiries',
      [created[0].create_item_listing.id],
    );
    expect(ownerList[0].list_listing_enquiries.map((row) => row.id))
      .toContain(enquiry[0].create_listing_enquiry.id);

    const restricted = await authenticated<{ list_restricted_listing_items: Array<{ slug: string }> }>(
      fixture.parentA1.userId,
      'select public.list_restricted_listing_items() as list_restricted_listing_items',
    );
    const slugs = restricted[0].list_restricted_listing_items.map((row) => row.slug).sort();
    expect(slugs).toEqual(expect.arrayContaining([
      'baby_walker', 'bassinet', 'bunk_bed', 'car_seat', 'cot', 'recalled_item',
    ]));
  });

  it('restrictedItemsRejected: car seats cots bassinets bunk beds walkers and recalls denied', async () => {
    const samples: Array<[string, string]> = [
      ['Car seat free', 'Unused infant car seat for a sibling family'],
      ['Baby cot giveaway', 'Timber baby cot no longer needed'],
      ['Bassinet lend', 'Compact bassinet for overnight visitors'],
      ['Bunk beds free', 'Pair of bunk beds after renovation'],
      ['Baby walker', 'Classic baby walker sitting unused'],
      ['Recalled item', 'This toy is under a product recall notice'],
    ];
    for (const [title, description] of samples) {
      await denied(
        () => authenticated(fixture.parentA1.userId,
          `select public.create_item_listing('giveaway', $1, $2, 'household', 'Free')`,
          [title, description]),
        ['22023'],
      );
    }
  });

  it('privacyAndOfferLabel: phones money labels and author self-enquiry denied', async () => {
    await denied(
      () => authenticated(fixture.parentA1.userId,
        `select public.create_item_listing('giveaway', $1, $2, 'clothing', 'Free')`,
        ['School hat', 'Call me on 0412345678 after school']),
      ['22023'],
    );
    await denied(
      () => authenticated(fixture.parentA1.userId,
        `select public.create_item_listing('giveaway', $1, $2, 'clothing', $3)`,
        ['School hat', 'Plain school hat free to collect', '$5']),
      ['22023'],
    );
    const created = await authenticated<{ create_item_listing: Listing }>(
      fixture.parentA1.userId,
      `select public.create_item_listing('giveaway', $1, $2, 'books', 'Free to collect')
         as create_item_listing`,
      ['Picture books bundle', 'Soft-cover picture books free to collect'],
    );
    await denied(
      () => authenticated(fixture.parentA1.userId,
        'select public.create_listing_enquiry($1::uuid, $2)',
        [created[0].create_item_listing.id, 'Checking my own listing']),
      ['22023'],
    );
  });

  it('crossSchoolDenials: School B cannot create search get enquire or read School A listings', async () => {
    const created = await authenticated<{ create_item_listing: Listing }>(
      fixture.parentA1.userId,
      `select public.create_item_listing('giveaway', $1, $2, 'clothing', 'Free')
         as create_item_listing`,
      ['Raincoat spare', 'Child raincoat free for wet term days'],
    );
    const listingId = created[0].create_item_listing.id;

    const foreignSearch = await authenticated<{ search_item_listings: Listing[] }>(
      fixture.parentB.userId,
      `select public.search_item_listings('raincoat', null, null) as search_item_listings`,
    );
    expect(foreignSearch[0].search_item_listings).toEqual([]);

    await denied(() => authenticated(fixture.parentB.userId,
      'select public.get_item_listing($1::uuid)', [listingId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.create_listing_enquiry($1::uuid, $2)',
      [listingId, 'Crossing schools should fail.']));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.list_listing_enquiries($1::uuid)', [listingId]));

    const rows = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.item_listings where id = $1',
      [listingId],
    );
    expect(rows).toEqual([]);
  });

  it('noDirectDmlAndCatalog: clients cannot write tables; RLS and free-only columns hold', async () => {
    const created = await authenticated<{ create_item_listing: Listing }>(
      fixture.parentA1.userId,
      `select public.create_item_listing('giveaway', $1, $2, 'clothing', 'Free')
         as create_item_listing`,
      ['Direct DML check jacket', 'Only RPCs may write free listings for our school'],
    );

    await denied(() => authenticated(fixture.parentA1.userId,
      `insert into public.item_listings
        (school_id, author_id, author_membership, listing_kind, title, description, category, display_offer_label)
       values ($1, $2, $3, 'giveaway', 'Bypass title', 'Bypass description', 'clothing', 'Free')`,
      [fixture.schoolA, fixture.parentA1.userId, fixture.parentA1.membershipId]));
    await denied(() => authenticated(fixture.parentA1.userId,
      'update public.item_listings set title = $2 where id = $1',
      [created[0].create_item_listing.id, 'Mutated']),
    ['42501', '55000']);
    await denied(() => authenticated(fixture.parentA1.userId,
      'delete from public.item_listings where id = $1',
      [created[0].create_item_listing.id]),
    ['42501', '55000']);
    await denied(() => authenticated(fixture.parentA1.userId,
      `insert into public.listing_restricted_items (slug, label, match_terms)
       values ('client_block', 'Client block', array['client block'])`),
    ['42501', '55000']);

    const catalog = await privileged('read-back: listings catalog', async () => {
      const tables = await db().query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname in (
             'listing_restricted_items', 'item_listings', 'listing_enquiries'
           )
         order by c.relname`);
      const cols = await db().query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = 'public'
           and table_name in (
             'listing_restricted_items', 'item_listings', 'listing_enquiries'
           )`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_item_listing', 'search_item_listings', 'get_item_listing',
             'create_listing_enquiry', 'list_listing_enquiries',
             'list_restricted_listing_items', 'listing_caller_membership',
             'guard_item_listings', 'listing_contains_restricted_item',
             'listing_text_is_allowed'
           )
         order by p.proname`);
      return { tables: tables.rows, cols: cols.rows, grants: grants.rows };
    });

    expect(catalog.tables.every((t) => t.relrowsecurity)).toBe(true);
    expect(catalog.cols.map((c) => c.column_name).join(','))
      .not.toMatch(/\b(amount|price|currency|payment|phone|mobile|nickname|photo|latitude|longitude|email)\b/i);
    expect(catalog.cols.some((c) => c.column_name === 'display_offer_label' && c.data_type === 'text')).toBe(true);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'create_item_listing',
      'create_listing_enquiry',
      'get_item_listing',
      'list_listing_enquiries',
      'list_restricted_listing_items',
      'search_item_listings',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
