/**
 * Task 7.1 live suite: phone-free school notices, moderation queue/withdraw,
 * cross-school denials, RLS, grants, allowlist and search_path. Authenticated +
 * synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  requester: Member;
  provider: Member;
  stranger: Member;
  moderatorA: Member;
  parentB: Member;
  moderatorB: Member;
  now: Date;
};

type NoticePayload = {
  id: string;
  school_id: string;
  swap_leg_id: string;
  service_date: string;
  year_levels: number[];
  collector_display_name: string;
  notice_body: string;
  status: string;
};

describe('Task 7.1 live school notices and moderation', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('School notice live test connection is not initialised.');
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
    const name = `school_notice_denial_${++savepointNumber}`;
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
    const requester = member(schoolA);
    const provider = member(schoolA);
    const stranger = member(schoolA);
    const moderatorA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [requester, provider, stranger, moderatorA, parentB, moderatorB];
    const userIds = members.map((m) => m.userId);
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Notice School A', 'Australia/Sydney'),
             ($3, $4, 'Notice School B', 'Australia/Melbourne')`,
    [schoolA, `notice-a-${schoolA}`, schoolB, `notice-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'notice-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', 'Collector ' || left(id::text, 8)),
        now(), now()
      from unnest($1::uuid[]) as u(id)`, [userIds]);
    await db().query(`update public.profiles
      set display_name = 'Collector ' || left(id::text, 8)
      where id = any($1::uuid[])`, [userIds]);
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
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Notice A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Notice B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    await db().query(`insert into public.child_profiles
      (id, membership_id, parent_id, nickname, year_level)
      values ($1, $2, $3, 'Kiddo', 3), ($4, $2, $3, 'Sibling', 5)`,
    [randomUUID(), requester.membershipId, requester.userId, randomUUID()]);
    return {
      schoolA, schoolB, requester, provider, stranger, moderatorA, parentB, moderatorB,
      now: clock[0].now,
    };
  }

  async function createAcceptedLeg(): Promise<{ swapId: string; legId: string; serviceDate: string }> {
    return privileged('fixture: accepted swap leg for school notice', async () => {
      const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
      const proposedAt = new Date(fixture.now.getTime() - DAY_MS);
      const acceptedAt = fixture.now;
      const swapId = randomUUID();
      const legId = randomUUID();
      const reverseLegId = randomUUID();
      const patternIds = Array.from({ length: 4 }, () => randomUUID());
      const instanceIds = Array.from({ length: 4 }, () => randomUUID());
      const owners = [
        fixture.provider.userId, fixture.requester.userId,
        fixture.requester.userId, fixture.provider.userId,
      ];
      const intents = ['can_help', 'need_help', 'can_help', 'need_help'];
      await db().query(`insert into public.availability_patterns
        (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
         area_label, capacity, starts_on, created_at)
        select id, $2::uuid, owner_id, intent::public.schedule_intent, 'pickup',
          extract(isodow from ($5::timestamptz at time zone 'Australia/Sydney'))::smallint,
          ($5::timestamptz at time zone 'Australia/Sydney')::time,
          (($5::timestamptz at time zone 'Australia/Sydney') + interval '30 minutes')::time,
          'Carlton', 1, ($5::timestamptz at time zone 'Australia/Sydney')::date, $6
        from unnest($1::uuid[], $3::uuid[], $4::text[]) as p(id, owner_id, intent)`,
      [patternIds, fixture.schoolA, owners, intents, serviceAt, proposedAt]);
      await db().query(`insert into public.availability_instances
        (id, pattern_id, school_id, owner_id, service_date, intent, direction,
         window_start, window_end, area_label, capacity, created_at, status)
        select id, pattern_id, $3::uuid, owner_id,
          ($6::timestamptz at time zone 'Australia/Sydney')::date,
          intent::public.schedule_intent, 'pickup',
          ($6::timestamptz at time zone 'Australia/Sydney')::time,
          (($6::timestamptz at time zone 'Australia/Sydney') + interval '30 minutes')::time,
          'Carlton', 1, $7, 'open'
        from unnest($1::uuid[], $2::uuid[], $4::uuid[], $5::text[])
          as i(id, pattern_id, owner_id, intent)`,
      [instanceIds, patternIds, fixture.schoolA, owners, intents, serviceAt, proposedAt]);
      await db().query(`insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, accepted_at, expires_at)
        values ($1, $2, $3, $4, 'accepted', $5, $6, $7)`, [
        swapId, fixture.schoolA, fixture.requester.userId, fixture.provider.userId,
        proposedAt, acceptedAt, new Date(acceptedAt.getTime() + 2 * DAY_MS),
      ]);
      const { rows: dates } = await db().query<{ service_date: string }>(
        `select ($1::timestamptz at time zone 'Australia/Sydney')::date::text as service_date`,
        [serviceAt],
      );
      await db().query(`insert into public.swap_legs
        (id, swap_id, school_id, helper_instance_id, requester_instance_id,
         helper_id, requester_id, service_date, created_at)
        values ($1, $3, $4, $5, $6, $9, $10,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12),
               ($2, $3, $4, $7, $8, $10, $9,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12)`, [
        legId, reverseLegId, swapId, fixture.schoolA, ...instanceIds,
        fixture.provider.userId, fixture.requester.userId, serviceAt, proposedAt,
      ]);
      return { swapId, legId, serviceDate: dates[0].service_date };
    });
  }

  function assertPhoneFree(notice: NoticePayload): void {
    expect(notice.notice_body).toMatch(/Collection notice —/);
    expect(notice.notice_body).toMatch(/Year level:/);
    expect(notice.notice_body).toMatch(/Collector:/);
    expect(notice.notice_body).not.toMatch(/Kiddo|Sibling|nickname|phone|mobile|@|AUD|price|amount|currency|trust|score/i);
    expect(JSON.stringify(notice)).not.toMatch(/Kiddo|Sibling|phone|mobile|\+61|AUD|price|amount|currency/i);
    expect(notice.year_levels).toEqual([3, 5]);
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for school notice live tests.');
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
      set local statement_timeout = '15s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: unique two-school onboarding', seed);
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

  it('generatePhoneFreeNotice: accepted participant creates year-date-collector copy without nickname or contact', async () => {
    const { legId, serviceDate } = await createAcceptedLeg();
    const rows = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.requester.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    const notice = rows[0].generate_school_notice;
    expect(notice.status).toBe('active');
    expect(notice.service_date).toBe(serviceDate);
    expect(notice.collector_display_name).toBe(`Collector ${fixture.provider.userId.slice(0, 8)}`);
    assertPhoneFree(notice);
    const again = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.provider.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    expect(again[0].generate_school_notice.id).toBe(notice.id);
    const logs = await authenticated<{ action: string }>(
      fixture.requester.userId,
      `select action from public.school_notice_access_logs
       where notice_id = $1 order by action`,
      [notice.id],
    );
    expect(logs.map((row) => row.action)).toEqual(['generated', 'viewed']);
  });

  it('moderationQueueAndWithdraw: school moderator lists and withdraws; generator cannot revive by regenerate until after withdraw', async () => {
    const { legId } = await createAcceptedLeg();
    const created = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.provider.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    const noticeId = created[0].generate_school_notice.id;
    const queue = await authenticated<{ list_school_notice_moderation_queue: {
      school_id: string; notices: NoticePayload[];
    } }>(
      fixture.moderatorA.userId,
      'select public.list_school_notice_moderation_queue() as list_school_notice_moderation_queue',
    );
    expect(queue[0].list_school_notice_moderation_queue.school_id).toBe(fixture.schoolA);
    expect(queue[0].list_school_notice_moderation_queue.notices.some((n) => n.id === noticeId)).toBe(true);
    const withdrawn = await authenticated<{ withdraw_school_notice: string }>(
      fixture.moderatorA.userId,
      'select public.withdraw_school_notice($1::uuid) as withdraw_school_notice', [noticeId],
    );
    expect(withdrawn[0].withdraw_school_notice).toBe('withdrawn');
    const emptyQueue = await authenticated<{ list_school_notice_moderation_queue: {
      notices: NoticePayload[];
    } }>(
      fixture.moderatorA.userId,
      'select public.list_school_notice_moderation_queue() as list_school_notice_moderation_queue',
    );
    expect(emptyQueue[0].list_school_notice_moderation_queue.notices.some((n) => n.id === noticeId)).toBe(false);
    const regenerated = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.requester.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    expect(regenerated[0].generate_school_notice.id).not.toBe(noticeId);
    expect(regenerated[0].generate_school_notice.status).toBe('active');
  });

  it('crossSchoolAndRoleDenials: stranger School B parent/moderator and anon cannot generate read or moderate School A notices', async () => {
    const { legId } = await createAcceptedLeg();
    const created = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.requester.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    const noticeId = created[0].generate_school_notice.id;

    await denied(() => authenticated(fixture.stranger.userId,
      'select public.generate_school_notice($1::uuid)', [legId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.generate_school_notice($1::uuid)', [legId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.generate_school_notice($1::uuid)', [legId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.get_school_notice($1::uuid)', [noticeId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.get_school_notice($1::uuid)', [noticeId]));
    await denied(() => authenticated(fixture.stranger.userId,
      'select public.get_school_notice($1::uuid)', [noticeId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.withdraw_school_notice($1::uuid)', [noticeId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.withdraw_school_notice($1::uuid)', [noticeId]));
    await denied(() => authenticated(fixture.requester.userId,
      'select public.list_school_notice_moderation_queue()'));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.list_school_notice_moderation_queue()'));

    const foreignQueue = await authenticated<{ list_school_notice_moderation_queue: {
      school_id: string; notices: NoticePayload[];
    } }>(
      fixture.moderatorB.userId,
      'select public.list_school_notice_moderation_queue() as list_school_notice_moderation_queue',
    );
    expect(foreignQueue[0].list_school_notice_moderation_queue.school_id).toBe(fixture.schoolB);
    expect(foreignQueue[0].list_school_notice_moderation_queue.notices).toEqual([]);

    const direct = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.school_notices where id = $1', [noticeId],
    );
    expect(direct).toEqual([]);

    await db().query('set local role authenticated; set local row_security = on');
    await db().query(`select set_config('request.jwt.claims', '{}', true),
      set_config('request.jwt.claim.sub', '', true),
      set_config('request.jwt.claim.role', 'anon', true)`);
    await db().query('set local role anon');
    await denied(async () => {
      await db().query('select public.generate_school_notice($1::uuid)', [legId]);
    }, ['42501']);
  });

  it('noDirectDmlAndImmutable: clients cannot insert update delete truncate notices or access logs', async () => {
    const { legId } = await createAcceptedLeg();
    const created = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.requester.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    const noticeId = created[0].generate_school_notice.id;
    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.school_notices
       (school_id, swap_id, swap_leg_id, generated_by, service_date, year_levels,
        collector_display_name, notice_body, status)
       select school_id, swap_id, swap_leg_id, generated_by, service_date, year_levels,
         collector_display_name, notice_body, status from public.school_notices where id = $1`,
      [noticeId]));
    await denied(() => authenticated(fixture.requester.userId,
      `update public.school_notices set collector_display_name = 'Hacked' where id = $1`, [noticeId]));
    await denied(() => authenticated(fixture.requester.userId,
      `delete from public.school_notices where id = $1`, [noticeId]));
    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.school_notice_access_logs (school_id, notice_id, actor_user_id, action)
       values ($1, $2, $3, 'viewed')`,
      [fixture.schoolA, noticeId, fixture.requester.userId]));
    await denied(() => authenticated(fixture.requester.userId,
      `delete from public.school_notice_access_logs where notice_id = $1`, [noticeId]));

    await privileged('read-back: privileged notice mutation still blocked by guard', async () => {
      await denied(async () => {
        await db().query(`update public.school_notices set notice_body = 'rewrite' where id = $1`, [noticeId]);
      }, ['55000']);
      await denied(async () => {
        await db().query(`delete from public.school_notice_access_logs where notice_id = $1`, [noticeId]);
      }, ['55000']);
    });
  });

  it('listMineAndGet: participants list and get own notice; payload stays phone-free', async () => {
    const { legId } = await createAcceptedLeg();
    const created = await authenticated<{ generate_school_notice: NoticePayload }>(
      fixture.requester.userId,
      'select public.generate_school_notice($1::uuid) as generate_school_notice', [legId],
    );
    const noticeId = created[0].generate_school_notice.id;
    const listed = await authenticated<{ list_my_school_notices: NoticePayload[] }>(
      fixture.provider.userId,
      'select public.list_my_school_notices() as list_my_school_notices',
    );
    expect(listed[0].list_my_school_notices.some((n) => n.id === noticeId)).toBe(true);
    const got = await authenticated<{ get_school_notice: NoticePayload }>(
      fixture.provider.userId,
      'select public.get_school_notice($1::uuid) as get_school_notice', [noticeId],
    );
    assertPhoneFree(got[0].get_school_notice);
    const strangerList = await authenticated<{ list_my_school_notices: NoticePayload[] }>(
      fixture.stranger.userId,
      'select public.list_my_school_notices() as list_my_school_notices',
    );
    expect(strangerList[0].list_my_school_notices.some((n) => n.id === noticeId)).toBe(false);
  });

  it('catalogAllowlistAndSearchPath: new tables RLS SELECT-only; RPCs allowlisted with pg_catalog paths; no money fields', async () => {
    const catalog = await privileged('read-back: school notice catalogue', async () => {
      const { rows } = await db().query<{
        relname: string; relrowsecurity: boolean; insert_priv: boolean; select_priv: boolean;
      }>(`
        select c.relname, c.relrowsecurity,
          has_table_privilege('authenticated', c.oid, 'INSERT') as insert_priv,
          has_table_privilege('authenticated', c.oid, 'SELECT') as select_priv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('school_notices', 'school_notice_access_logs')
        order by c.relname`);
      return rows;
    });
    expect(catalog).toEqual([
      expect.objectContaining({
        relname: 'school_notice_access_logs', relrowsecurity: true,
        insert_priv: false, select_priv: true,
      }),
      expect.objectContaining({
        relname: 'school_notices', relrowsecurity: true,
        insert_priv: false, select_priv: true,
      }),
    ]);

    const money = await privileged('read-back: school notice monetary columns', async () => {
      const { rows } = await db().query<{ count: string }>(`
        select count(*)::text as count from information_schema.columns
        where table_schema = 'public'
          and table_name in ('school_notices', 'school_notice_access_logs')
          and column_name ~* '(amount|price|currency|money|fee|payment|phone|mobile|email|nickname|address)'`);
      return rows[0].count;
    });
    expect(money).toBe('0');

    const paths = await privileged('read-back: school notice function search paths', async () => {
      const { rows } = await db().query<{
        proname: string; search_path: string | null; auth_exec: boolean; anon_exec: boolean;
      }>(`
        select p.proname,
          (select substr(setting, 13) from unnest(p.proconfig) setting
            where setting like 'search_path=%') as search_path,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'generate_school_notice', 'get_school_notice', 'list_my_school_notices',
          'list_school_notice_moderation_queue', 'withdraw_school_notice',
          'guard_school_notice_history', 'school_notice_year_label',
          'school_notice_build_body', 'school_notice_json', 'log_school_notice_access'
        )
        order by p.proname`);
      return rows;
    });
    for (const row of paths) {
      expect(row.search_path).toBe('pg_catalog');
      expect(row.anon_exec).toBe(false);
    }
    const authNames = paths.filter((row) => row.auth_exec).map((row) => row.proname).sort();
    expect(authNames).toEqual([
      'generate_school_notice', 'get_school_notice', 'list_my_school_notices',
      'list_school_notice_moderation_queue', 'withdraw_school_notice',
    ]);
  });
});
