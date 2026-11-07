/**
 * Task 8.2 live suite: community reporting, auto-hide after 3 unique reports,
 * moderator hide/restore/remove, queue, cross-school denials. Authenticated +
 * synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  authorA: Member;
  reporterA1: Member;
  reporterA2: Member;
  reporterA3: Member;
  parentA: Member;
  moderatorA: Member;
  parentB: Member;
  moderatorB: Member;
};

describe('Task 8.2 live community moderation', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Community moderation live test connection is not initialised.');
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
    const name = `community_mod_denial_${++savepointNumber}`;
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
    const authorA = member(schoolA);
    const reporterA1 = member(schoolA);
    const reporterA2 = member(schoolA);
    const reporterA3 = member(schoolA);
    const parentA = member(schoolA);
    const moderatorA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [
      authorA, reporterA1, reporterA2, reporterA3, parentA, moderatorA, parentB, moderatorB,
    ];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Community Mod School A', 'Australia/Sydney'),
             ($3, $4, 'Community Mod School B', 'Australia/Melbourne')`,
    [schoolA, `cmod-a-${schoolA}`, schoolB, `cmod-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'cmod-' || id::text || '@example.invalid', now(),
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
    [randomUUID(), moderatorA.userId, schoolA,
      randomUUID(), moderatorB.userId, schoolB]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Mod A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Mod B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, authorA, reporterA1, reporterA2, reporterA3,
      parentA, moderatorA, parentB, moderatorB,
    };
  }

  async function createThread(author: Member, title: string, body: string): Promise<{
    threadId: string; postId: string;
  }> {
    const rows = await authenticated<{ create_community_thread: {
      thread: { id: string }; post: { id: string };
    } }>(author.userId,
      `select public.create_community_thread($1::text, $2::text) as create_community_thread`,
      [title, body]);
    return {
      threadId: rows[0].create_community_thread.thread.id,
      postId: rows[0].create_community_thread.post.id,
    };
  }

  beforeEach(async () => {
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required.');
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query('begin');
    transactionStarted = true;
    fixture = await privileged('fixture: community moderation seed', seed);
  });

  afterEach(async () => {
    if (client && transactionStarted) {
      await client.query('rollback');
      transactionStarted = false;
    }
    if (client) {
      await client.end();
      client = undefined;
    }
  });

  it('reportAutoHideRestoreRemove: three unique reports auto-hide; moderator restore then remove', async () => {
    const { postId } = await createThread(
      fixture.authorA,
      'Wet weather carpool tips',
      'Share organisation tips for rainy afternoon pickups.',
    );

    const first = await authenticated<{ report_community_content: {
      outcome: string; report_count: number; status: string;
    } }>(fixture.reporterA1.userId,
      `select public.report_community_content('post', $1::uuid, $2::text) as report_community_content`,
      [postId, 'This post looks off-topic for our school.']);
    expect(first[0].report_community_content).toMatchObject({
      outcome: 'reported', report_count: 1, status: 'active',
    });

    const second = await authenticated<{ report_community_content: {
      outcome: string; report_count: number; status: string;
    } }>(fixture.reporterA2.userId,
      `select public.report_community_content('post', $1::uuid, $2::text) as report_community_content`,
      [postId, 'Please review this discussion for tone.']);
    expect(second[0].report_community_content).toMatchObject({
      outcome: 'reported', report_count: 2, status: 'active',
    });

    const third = await authenticated<{ report_community_content: {
      outcome: string; report_count: number; status: string;
    } }>(fixture.reporterA3.userId,
      `select public.report_community_content('post', $1::uuid, $2::text) as report_community_content`,
      [postId, 'Third unique report for review.']);
    expect(third[0].report_community_content).toMatchObject({
      outcome: 'auto_hidden', report_count: 3, status: 'hidden',
    });

    const open = await createThread(
      fixture.authorA,
      'Open discussion',
      'A separate active thread stays visible.',
    );

    const originalThread = await privileged('read-back: post school thread', async () => {
      const { rows } = await db().query<{ thread_id: string }>(
        'select thread_id from public.community_posts where id = $1', [postId]);
      return rows[0].thread_id;
    });
    const activePosts = await authenticated<{ list_community_posts: Array<{ id: string }> }>(
      fixture.parentA.userId,
      'select public.list_community_posts($1::uuid) as list_community_posts',
      [originalThread],
    );
    expect(activePosts[0].list_community_posts.map((p) => p.id)).not.toContain(postId);

    const queue = await authenticated<{ list_community_moderation_queue: Array<{
      target_id: string; status: string; report_count: number;
    }> }>(fixture.moderatorA.userId,
      'select public.list_community_moderation_queue() as list_community_moderation_queue');
    expect(queue[0].list_community_moderation_queue.some(
      (item) => item.target_id === postId && item.status === 'hidden' && item.report_count === 3,
    )).toBe(true);

    const restored = await authenticated<{ restore_community_content: {
      outcome: string; status: string;
    } }>(fixture.moderatorA.userId,
      `select public.restore_community_content('post', $1::uuid) as restore_community_content`,
      [postId]);
    expect(restored[0].restore_community_content).toMatchObject({
      outcome: 'restored', status: 'active',
    });

    const removed = await authenticated<{ remove_community_content: {
      outcome: string; status: string;
    } }>(fixture.moderatorA.userId,
      `select public.remove_community_content('post', $1::uuid) as remove_community_content`,
      [postId]);
    expect(removed[0].remove_community_content).toMatchObject({
      outcome: 'removed', status: 'withdrawn',
    });

    const actions = await privileged('read-back: moderation actions', async () => {
      const { rows } = await db().query<{ action: string }>(
        `select action from public.community_moderation_actions
         where target_id = $1
         order by created_at,
           case action
             when 'report_received' then 1
             when 'auto_hide' then 2
             when 'hide' then 3
             when 'restore' then 4
             when 'remove' then 5
             else 9
           end,
           id`, [postId]);
      return rows.map((r) => r.action);
    });
    expect(actions).toEqual([
      'report_received', 'report_received', 'report_received',
      'auto_hide', 'restore', 'remove',
    ]);

    const openList = await authenticated<{ list_community_threads: Array<{ id: string }> }>(
      fixture.parentA.userId,
      'select public.list_community_threads() as list_community_threads');
    expect(openList[0].list_community_threads.map((t) => t.id)).toContain(open.threadId);
  });

  it('moderatorHideAndParticipantCannotForge: moderator hide works; parents denied hide restore remove', async () => {
    const { postId } = await createThread(
      fixture.authorA,
      'Programme day reminders',
      'Please keep replies about school pickup timing only.',
    );

    await denied(() => authenticated(fixture.parentA.userId,
      `select public.hide_community_content('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.parentA.userId,
      `select public.restore_community_content('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.parentA.userId,
      `select public.remove_community_content('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.parentA.userId,
      'select public.list_community_moderation_queue()'));

    const hidden = await authenticated<{ hide_community_content: {
      outcome: string; status: string;
    } }>(fixture.moderatorA.userId,
      `select public.hide_community_content('post', $1::uuid) as hide_community_content`,
      [postId]);
    expect(hidden[0].hide_community_content).toMatchObject({
      outcome: 'hidden', status: 'hidden',
    });

    await denied(() => authenticated(fixture.authorA.userId,
      `select public.report_community_content('post', $1::uuid, $2::text)`,
      [postId, 'Self report should be denied.']),
    ['42501']);
  });

  it('crossSchoolDenials: School B cannot report hide restore remove or queue School A content', async () => {
    const { postId, threadId } = await createThread(
      fixture.authorA,
      'Same-school only board',
      'Discussion stays inside our organisation.',
    );

    await denied(() => authenticated(fixture.parentB.userId,
      `select public.report_community_content('post', $1::uuid, $2::text)`,
      [postId, 'Foreign school report attempt.']));
    await denied(() => authenticated(fixture.moderatorB.userId,
      `select public.hide_community_content('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      `select public.restore_community_content('post', $1::uuid)`, [postId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      `select public.remove_community_content('post', $1::uuid)`, [postId]));

    const foreignQueue = await authenticated<{ list_community_moderation_queue: unknown[] }>(
      fixture.moderatorB.userId,
      'select public.list_community_moderation_queue() as list_community_moderation_queue');
    expect(foreignQueue[0].list_community_moderation_queue).toEqual([]);

    const foreignSelect = await authenticated<{ id: string }>(
      fixture.moderatorB.userId,
      'select id from public.community_posts where id = $1', [postId]);
    expect(foreignSelect).toEqual([]);

    const foreignThread = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.community_threads where id = $1', [threadId]);
    expect(foreignThread).toEqual([]);
  });

  it('noDirectDml: clients cannot insert update delete reports or moderation actions', async () => {
    const { postId } = await createThread(
      fixture.authorA,
      'Direct DML guard topic',
      'Body used only for moderation table denial checks.',
    );

    await denied(() => authenticated(fixture.reporterA1.userId,
      `insert into public.community_reports
        (school_id, target_kind, target_id, reporter_id, reporter_membership, reason)
       values ($1, 'post', $2, $3, $4, 'Direct insert denied')`,
      [fixture.schoolA, postId, fixture.reporterA1.userId, fixture.reporterA1.membershipId]),
    ['42501', '55000']);

    await denied(() => authenticated(fixture.moderatorA.userId,
      `insert into public.community_moderation_actions
        (school_id, target_kind, target_id, action, actor_id, actor_membership, report_count)
       values ($1, 'post', $2, 'hide', $3, $4, 0)`,
      [fixture.schoolA, postId, fixture.moderatorA.userId, fixture.moderatorA.membershipId]),
    ['42501', '55000']);

    await denied(() => authenticated(fixture.moderatorA.userId,
      `update public.community_posts set status = 'hidden' where id = $1`, [postId]),
    ['55000', '42501']);

    await denied(() => authenticated(fixture.moderatorA.userId,
      'delete from public.community_reports'),
    ['55000', '42501']);
  });

  it('catalogAllowlistAndSearchPath: new tables RLS; RPCs allowlisted; no money or photo fields', async () => {
    const tables = await privileged('read-back: moderation tables', async () => {
      const { rows } = await db().query<{
        table_name: string; rls: boolean; insert_priv: boolean;
      }>(`select c.relname as table_name, c.relrowsecurity as rls,
             has_table_privilege('authenticated', c.oid, 'INSERT') as insert_priv
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname in ('community_reports', 'community_moderation_actions')`);
      return rows;
    });
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.rls).toBe(true);
      expect(table.insert_priv).toBe(false);
    }

    const moneyCols = await privileged('read-back: money columns', async () => {
      const { rows } = await db().query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public'
           and table_name in ('community_reports', 'community_moderation_actions')
           and column_name ~* '(amount|price|currency|money|photo|nickname|latitude|longitude)'`);
      return rows;
    });
    expect(moneyCols).toEqual([]);

    const fns = await privileged('read-back: moderation functions', async () => {
      const { rows } = await db().query<{
        proname: string; search_path: string | null; exec_auth: boolean;
      }>(`select p.proname,
             (select trim(both '"' from unnest) from pg_catalog.unnest(
                coalesce(p.proconfig, array[]::text[])) unnest
              where unnest like 'search_path=%' limit 1) as search_path,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as exec_auth
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in (
               'report_community_content', 'hide_community_content',
               'restore_community_content', 'remove_community_content',
               'list_community_moderation_queue', 'community_apply_status',
               'community_require_moderator_membership', 'guard_community_moderation'
             )`);
      return rows;
    });
    const byName = Object.fromEntries(fns.map((f) => [f.proname, f]));
    for (const name of [
      'report_community_content', 'hide_community_content',
      'restore_community_content', 'remove_community_content',
      'list_community_moderation_queue',
    ]) {
      expect(byName[name].search_path).toBe('search_path=pg_catalog');
      expect(byName[name].exec_auth).toBe(true);
    }
    for (const name of [
      'community_apply_status', 'community_require_moderator_membership',
      'guard_community_moderation',
    ]) {
      expect(byName[name].search_path).toBe('search_path=pg_catalog');
      expect(byName[name].exec_auth).toBe(false);
    }
  });
});
