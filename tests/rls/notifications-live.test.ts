/**
 * Task 10.1 live suite: owner notifications SELECT/UPDATE(read), system enqueue,
 * blocked client INSERT/DELETE, cross-school isolation.
 * Authenticated + synthetic JWT; ROLLBACK.
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
};

type Notification = {
  id: string;
  user_id: string;
  school_id: string;
  kind: string;
  title: string;
  body: string;
  is_read: boolean;
  metadata: Record<string, string>;
};

describe('Task 10.1 live user notifications', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Notifications live test connection is not initialised.');
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
    const name = `notifications_denial_${++savepointNumber}`;
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

  async function enqueue(
    userId: string, schoolId: string, title: string, kind = 'system',
  ): Promise<Notification> {
    return privileged('fixture: enqueue notification', async () => {
      const { rows } = await db().query<{ enqueue_user_notification: Notification }>(
        `select public.enqueue_user_notification(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
           jsonb_build_object('entity_type', 'system', 'reason_code', 'test_seed')
         ) as enqueue_user_notification`,
        [userId, schoolId, kind, title, `${title} body without contact details`],
      );
      return rows[0].enqueue_user_notification;
    });
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
    const members = [parentA1, parentA2, parentB];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Notify School A', 'Australia/Sydney'),
             ($3, $4, 'Notify School B', 'Australia/Melbourne')`,
    [schoolA, `ntf-a-${schoolA}`, schoolB, `ntf-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'ntf-' || id::text || '@example.invalid', now(),
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
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Notify A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Notify B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return { schoolA, schoolB, parentA1, parentA2, parentB };
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for notifications live tests.');
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
    fixture = await privileged('fixture: unique two-school notifications onboarding', seed);
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

  it('listAndMarkRead: owner lists unread and marks one then all as read', async () => {
    const first = await enqueue(fixture.parentA1.userId, fixture.schoolA, 'First school notice');
    const second = await enqueue(fixture.parentA1.userId, fixture.schoolA, 'Second school notice');
    expect(first.is_read).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);

    const listed = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentA1.userId,
      'select public.list_my_notifications(false) as list_my_notifications',
    );
    expect(listed[0].list_my_notifications.map((row) => row.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );

    const unread = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentA1.userId,
      'select public.list_my_notifications(true) as list_my_notifications',
    );
    expect(unread[0].list_my_notifications).toHaveLength(2);

    const marked = await authenticated<{ mark_notification_read: Notification }>(
      fixture.parentA1.userId,
      'select public.mark_notification_read($1::uuid) as mark_notification_read',
      [first.id],
    );
    expect(marked[0].mark_notification_read.is_read).toBe(true);

    const afterOne = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentA1.userId,
      'select public.list_my_notifications(true) as list_my_notifications',
    );
    expect(afterOne[0].list_my_notifications.map((row) => row.id)).toEqual([second.id]);

    const all = await authenticated<{ mark_all_notifications_read: {
      outcome: string; marked_count: number;
    } }>(
      fixture.parentA1.userId,
      'select public.mark_all_notifications_read() as mark_all_notifications_read',
    );
    expect(all[0].mark_all_notifications_read).toEqual({
      outcome: 'marked_read', marked_count: 1,
    });

    const noneUnread = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentA1.userId,
      'select public.list_my_notifications(true) as list_my_notifications',
    );
    expect(noneUnread[0].list_my_notifications).toEqual([]);
  });

  it('crossSchoolAndPeerDenials: School B and peers cannot read or mark School A notifications', async () => {
    const note = await enqueue(fixture.parentA1.userId, fixture.schoolA, 'Private handover reminder');

    const peerList = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentA2.userId,
      'select public.list_my_notifications(false) as list_my_notifications',
    );
    expect(peerList[0].list_my_notifications).toEqual([]);

    const foreignList = await authenticated<{ list_my_notifications: Notification[] }>(
      fixture.parentB.userId,
      'select public.list_my_notifications(false) as list_my_notifications',
    );
    expect(foreignList[0].list_my_notifications).toEqual([]);

    await denied(() => authenticated(fixture.parentA2.userId,
      'select public.mark_notification_read($1::uuid)', [note.id]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.mark_notification_read($1::uuid)', [note.id]));

    const peerSelect = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.notifications where id = $1',
      [note.id],
    );
    expect(peerSelect).toEqual([]);
  });

  it('noDirectInsertDelete: clients cannot insert delete truncate; authenticated cannot enqueue', async () => {
    const note = await enqueue(fixture.parentA1.userId, fixture.schoolA, 'Guard check notice');

    await denied(() => authenticated(fixture.parentA1.userId,
      `insert into public.notifications (user_id, school_id, kind, title, body)
       values ($1, $2, 'system', 'Bypass title', 'Bypass body')`,
      [fixture.parentA1.userId, fixture.schoolA]),
    ['42501', '55000']);
    await denied(() => authenticated(fixture.parentA1.userId,
      'delete from public.notifications where id = $1', [note.id]),
    ['42501', '55000']);
    await denied(() => authenticated(fixture.parentA1.userId,
      `select public.enqueue_user_notification($1::uuid, $2::uuid, 'system', 'Title', 'Body', '{}'::jsonb)`,
      [fixture.parentA1.userId, fixture.schoolA]));
    await denied(() => authenticated(fixture.parentA1.userId,
      `update public.notifications set title = 'Mutated' where id = $1`, [note.id]),
    ['42501', '55000']);
  });

  it('catalogAllowlistAndSearchPath: RLS grants paths and no money fields', async () => {
    const catalog = await privileged('read-back: notifications catalog', async () => {
      const table = await db().query<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'notifications'`);
      const cols = await db().query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'notifications'`);
      const tableGrants = await db().query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'notifications'
           and grantee = 'authenticated'`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'list_my_notifications', 'mark_notification_read',
             'mark_all_notifications_read', 'enqueue_user_notification',
             'guard_notifications', 'notification_metadata_is_safe',
             'notification_json'
           )
         order by p.proname`);
      return {
        table: table.rows[0], cols: cols.rows,
        tableGrants: tableGrants.rows.map((r) => r.privilege_type).sort(),
        grants: grants.rows,
      };
    });

    expect(catalog.table.relrowsecurity).toBe(true);
    expect(catalog.cols.map((c) => c.column_name).join(','))
      .not.toMatch(/\b(amount|price|currency|payment|phone|mobile|nickname|photo|latitude|longitude|email)\b/i);
    expect(catalog.tableGrants).toEqual(['SELECT', 'UPDATE']);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'list_my_notifications',
      'mark_all_notifications_read',
      'mark_notification_read',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
