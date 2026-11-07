/**
 * Task 8.1 live suite: school-scoped community threads, posts, comments, likes.
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

describe('Task 8.1 live school-scoped community discussion', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Community live test connection is not initialised.');
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
    const name = `community_denial_${++savepointNumber}`;
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
      values ($1, $2, 'Community School A', 'Australia/Sydney'),
             ($3, $4, 'Community School B', 'Australia/Melbourne')`,
    [schoolA, `com-a-${schoolA}`, schoolB, `com-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'community-' || id::text || '@example.invalid', now(),
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
      values ($1, $2, 1, 'Community A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Community B', 'Synthetic school safety declaration B', true, now())`,
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
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for community live tests.');
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
    fixture = await privileged('fixture: unique two-school community onboarding', seed);
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

  it('createListCommentLike: same-school parents create thread, post, comment and toggle likes', async () => {
    const created = await authenticated<{ create_community_thread: {
      thread: { id: string; title: string; school_id: string; author_display_name: string };
      post: { id: string; body: string; like_count: number };
    } }>(
      fixture.parentA1.userId,
      `select public.create_community_thread($1::text, $2::text) as create_community_thread`,
      ['School pickup tips for wet weather', 'Share suburb-safe tips for rainy pickups only.'],
    );
    expect(created[0].create_community_thread.thread.school_id).toBe(fixture.schoolA);
    expect(created[0].create_community_thread.thread.title).toContain('wet weather');
    expect(created[0].create_community_thread.post.body).toContain('rainy pickups');
    expect(JSON.stringify(created[0].create_community_thread)).not.toMatch(/nickname|phone|photo|amount|price|currency/i);

    const threadId = created[0].create_community_thread.thread.id;
    const firstPostId = created[0].create_community_thread.post.id;

    const listed = await authenticated<{ list_community_threads: Array<{ id: string }> }>(
      fixture.parentA2.userId,
      'select public.list_community_threads() as list_community_threads',
    );
    expect(listed[0].list_community_threads.map((t) => t.id)).toContain(threadId);

    const reply = await authenticated<{ create_community_post: { id: string; thread_id: string } }>(
      fixture.parentA2.userId,
      'select public.create_community_post($1::uuid, $2::text) as create_community_post',
      [threadId, 'We keep umbrellas in the boot and arrive five minutes early.'],
    );
    expect(reply[0].create_community_post.thread_id).toBe(threadId);

    const comment = await authenticated<{ create_community_comment: { id: string; post_id: string } }>(
      fixture.parentA1.userId,
      'select public.create_community_comment($1::uuid, $2::text) as create_community_comment',
      [reply[0].create_community_post.id, 'Thanks — that helps our organisation of wet-day runs.'],
    );
    expect(comment[0].create_community_comment.post_id).toBe(reply[0].create_community_post.id);

    const liked = await authenticated<{ toggle_community_like: {
      liked: boolean; like_count: number;
    } }>(
      fixture.parentA2.userId,
      `select public.toggle_community_like('post', $1::uuid) as toggle_community_like`,
      [firstPostId],
    );
    expect(liked[0].toggle_community_like).toEqual({ liked: true, like_count: 1, target_kind: 'post', target_id: firstPostId });

    const unliked = await authenticated<{ toggle_community_like: { liked: boolean; like_count: number } }>(
      fixture.parentA2.userId,
      `select public.toggle_community_like('post', $1::uuid) as toggle_community_like`,
      [firstPostId],
    );
    expect(unliked[0].toggle_community_like.liked).toBe(false);
    expect(unliked[0].toggle_community_like.like_count).toBe(0);

    const posts = await authenticated<{ list_community_posts: Array<{ id: string }> }>(
      fixture.parentA1.userId,
      'select public.list_community_posts($1::uuid) as list_community_posts',
      [threadId],
    );
    expect(posts[0].list_community_posts).toHaveLength(2);

    const comments = await authenticated<{ list_community_comments: Array<{ id: string }> }>(
      fixture.parentA2.userId,
      'select public.list_community_comments($1::uuid) as list_community_comments',
      [reply[0].create_community_post.id],
    );
    expect(comments[0].list_community_comments.map((c) => c.id))
      .toContain(comment[0].create_community_comment.id);
  });

  it('privacyTextRejected: phones emails photos and child full-name phrasing are denied', async () => {
    await denied(
      () => authenticated(fixture.parentA1.userId,
        `select public.create_community_thread($1, $2)`,
        ['Help needed', 'Call me on 0412345678 after school']),
      ['22023'],
    );
    await denied(
      () => authenticated(fixture.parentA1.userId,
        `select public.create_community_thread($1, $2)`,
        ['Photo share', 'Here is a photo of my child https://example.invalid/kid.jpg']),
      ['22023'],
    );
    await denied(
      () => authenticated(fixture.parentA1.userId,
        `select public.create_community_thread($1, $2)`,
        ['Names', 'Please reply with your child full name and class']),
      ['22023'],
    );
  });

  it('crossSchoolDenials: School B cannot create list read or like School A community content', async () => {
    const created = await authenticated<{ create_community_thread: {
      thread: { id: string }; post: { id: string };
    } }>(
      fixture.parentA1.userId,
      `select public.create_community_thread($1, $2) as create_community_thread`,
      ['Harbour term planning', 'Looking for Wednesday pickup cover tips only.'],
    );
    const threadId = created[0].create_community_thread.thread.id;
    const postId = created[0].create_community_thread.post.id;

    const foreignList = await authenticated<{ list_community_threads: unknown[] }>(
      fixture.parentB.userId,
      'select public.list_community_threads() as list_community_threads',
    );
    expect(foreignList[0].list_community_threads).toEqual([]);

    await denied(() => authenticated(fixture.parentB.userId,
      'select public.list_community_posts($1::uuid)', [threadId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.create_community_post($1::uuid, $2)',
      [threadId, 'Crossing schools should fail.']));
    await denied(() => authenticated(fixture.parentB.userId,
      `select public.toggle_community_like('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.create_community_comment($1::uuid, $2)',
      [postId, 'Foreign comment should fail.']));

    const rows = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.community_threads where id = $1',
      [threadId],
    );
    expect(rows).toEqual([]);
  });

  it('noDirectDml: clients cannot insert update delete community tables directly', async () => {
    const created = await authenticated<{ create_community_thread: { thread: { id: string } } }>(
      fixture.parentA1.userId,
      `select public.create_community_thread($1, $2) as create_community_thread`,
      ['Direct DML check', 'Only RPCs may write community rows for our school.'],
    );
    await denied(() => authenticated(fixture.parentA1.userId,
      `insert into public.community_threads
        (school_id, author_id, author_membership, title)
       values ($1, $2, $3, 'Bypass title')`,
      [fixture.schoolA, fixture.parentA1.userId, fixture.parentA1.membershipId]));
    await denied(() => authenticated(fixture.parentA1.userId,
      'update public.community_threads set title = $2 where id = $1',
      [created[0].create_community_thread.thread.id, 'Mutated']),
    ['42501', '55000']);
    await denied(() => authenticated(fixture.parentA1.userId,
      'delete from public.community_threads where id = $1',
      [created[0].create_community_thread.thread.id]),
    ['42501', '55000']);
  });

  it('catalogAllowlistAndSearchPath: new tables RLS; RPCs allowlisted; no money or photo fields', async () => {
    const catalog = await privileged('read-back: community catalog', async () => {
      const tables = await db().query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname in (
             'community_threads', 'community_posts',
             'community_comments', 'community_likes'
           )
         order by c.relname`);
      const cols = await db().query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public'
           and table_name like 'community_%'`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'create_community_thread', 'create_community_post',
             'create_community_comment', 'toggle_community_like',
             'list_community_threads', 'list_community_posts',
             'list_community_comments', 'community_caller_membership',
             'guard_community_discussion', 'community_text_is_allowed'
           )
         order by p.proname`);
      return { tables: tables.rows, cols: cols.rows, grants: grants.rows };
    });

    expect(catalog.tables.every((t) => t.relrowsecurity)).toBe(true);
    expect(catalog.cols.map((c) => c.column_name).join(','))
      .not.toMatch(/amount|price|currency|phone|mobile|nickname|photo|latitude|longitude|email/i);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'create_community_comment',
      'create_community_post',
      'create_community_thread',
      'list_community_comments',
      'list_community_posts',
      'list_community_threads',
      'toggle_community_like',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
