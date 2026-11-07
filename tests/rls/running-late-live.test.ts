/**
 * Task 7.4 live suite: running-late notices and late trust penalties.
 * Authenticated + synthetic JWT; ROLLBACK. Cross-school denials included.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  requester: Member;
  provider: Member;
  parentB: Member;
  moderatorB: Member;
  now: Date;
};
type SwapBits = {
  swapId: string;
  legId: string;
  reverseLegId: string;
  helperInstanceId: string;
  requesterInstanceId: string;
  serviceAt: Date;
  acceptedAt: Date;
};

describe('Task 7.4 live running-late notices and late trust penalties', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Running-late live test connection is not initialised.');
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
    const name = `running_late_denial_${++savepointNumber}`;
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
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [requester, provider, parentB, moderatorB];
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Late School A', 'Australia/Sydney'),
             ($3, $4, 'Late School B', 'Australia/Melbourne')`,
    [schoolA, `late-a-${schoolA}`, schoolB, `late-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'late-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Late Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) as u(id)`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, 'verified'::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '30 days'
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
      values ($1, $2, 1, 'Late A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Late B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    await db().query(`insert into public.child_profiles
      (id, membership_id, parent_id, nickname, year_level)
      values ($1, $2, $3, 'LateKid', 3)`,
    [randomUUID(), requester.membershipId, requester.userId]);
    return {
      schoolA, schoolB, requester, provider, parentB, moderatorB, now: clock[0].now,
    };
  }

  async function createAcceptedSwap(serviceAt: Date): Promise<SwapBits> {
    return privileged('fixture: create accepted reciprocal swap', async () => {
      const acceptedAt = new Date(Math.min(serviceAt.getTime(), fixture.now.getTime()) - DAY_MS);
      const proposedAt = new Date(acceptedAt.getTime() - DAY_MS);
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
          'Carlton', 1,
          ($5::timestamptz at time zone 'Australia/Sydney')::date, $6
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
      return {
        swapId, legId, reverseLegId, serviceAt, acceptedAt,
        helperInstanceId: instanceIds[0], requesterInstanceId: instanceIds[1],
      };
    });
  }

  async function score(userId: string): Promise<number> {
    const rows = await authenticated<{ trust: { trust_score: number } }>(
      userId, 'select public.get_my_trust() as trust',
    );
    return rows[0].trust.trust_score;
  }

  async function lateEvents(userId: string): Promise<Array<{ reason_code: string; delta: number }>> {
    return authenticated(userId,
      `select reason_code, delta from public.trust_score_events
       where subject_user_id = $1
         and reason_code in ('late_with_advance_notice', 'late_without_advance_notice')
       order by created_at, id`, [userId]);
  }

  async function backdatePickupWindow(swap: SwapBits, newServiceAt: Date): Promise<void> {
    await privileged('fixture: backdate pickup window for late confirm', async () => {
      await db().query(`update public.availability_instances inst
        set service_date = ($3::timestamptz at time zone 'Australia/Sydney')::date,
            window_start = ($3::timestamptz at time zone 'Australia/Sydney')::time,
            window_end = (($3::timestamptz at time zone 'Australia/Sydney') + interval '30 minutes')::time
        from public.swap_legs leg
        where leg.id in ($1::uuid, $2::uuid)
          and inst.id in (leg.helper_instance_id, leg.requester_instance_id)`,
      [swap.legId, swap.reverseLegId, newServiceAt]);
      await db().query(`update public.swap_legs
        set service_date = ($3::timestamptz at time zone 'Australia/Sydney')::date
        where id in ($1::uuid, $2::uuid)`,
      [swap.legId, swap.reverseLegId, newServiceAt]);
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for running-late live tests.');
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

  it('postBeforeWindowAndRead: helper posts before window; partner reads; idempotent', async () => {
    const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
    const swap = await createAcceptedSwap(serviceAt);
    const posted = await authenticated<{ notice: {
      id: string; swap_leg_id: string; posted_by: string;
    } }>(
      fixture.provider.userId,
      'select public.post_running_late_notice($1::uuid) as notice',
      [swap.legId],
    );
    expect(posted[0].notice.swap_leg_id).toBe(swap.legId);
    expect(posted[0].notice.posted_by).toBe(fixture.provider.userId);

    const again = await authenticated<{ notice: { id: string } }>(
      fixture.provider.userId,
      'select public.post_running_late_notice($1::uuid) as notice',
      [swap.legId],
    );
    expect(again[0].notice.id).toBe(posted[0].notice.id);

    const partner = await authenticated<{ notice: { id: string } }>(
      fixture.requester.userId,
      'select public.get_running_late_notice($1::uuid) as notice',
      [swap.legId],
    );
    expect(partner[0].notice.id).toBe(posted[0].notice.id);

    const listed = await authenticated<{ notices: Array<{ id: string }> }>(
      fixture.requester.userId,
      'select public.list_my_running_late_notices() as notices',
    );
    expect(listed[0].notices.map((n) => n.id)).toContain(posted[0].notice.id);
  });

  it('rejectAfterWindowStart: helper cannot post once pickup window has started', async () => {
    const serviceAt = new Date(fixture.now.getTime() - 5 * MINUTE_MS);
    const swap = await createAcceptedSwap(serviceAt);
    await denied(
      () => authenticated(fixture.provider.userId,
        'select public.post_running_late_notice($1::uuid)', [swap.legId]),
      ['22023'],
    );
  });

  it('lateWithoutNoticePenalty: 15+ minutes late without prior notice posts -5', async () => {
    const serviceAt = new Date(fixture.now.getTime() - 20 * MINUTE_MS);
    const swap = await createAcceptedSwap(serviceAt);
    const before = await score(fixture.provider.userId);
    await authenticated(
      fixture.provider.userId,
      'select public.confirm_pickup_done($1::uuid)',
      [swap.legId],
    );
    expect(await score(fixture.provider.userId)).toBe(before - 5);
    expect(await lateEvents(fixture.provider.userId)).toEqual([
      { reason_code: 'late_without_advance_notice', delta: -5 },
    ]);
    expect(await lateEvents(fixture.requester.userId)).toEqual([]);
  });

  it('lateWithPriorNoticePenalty: prior notice before window yields -2 on late pickup', async () => {
    const futureAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
    const swap = await createAcceptedSwap(futureAt);
    await authenticated(
      fixture.provider.userId,
      'select public.post_running_late_notice($1::uuid)',
      [swap.legId],
    );
    await backdatePickupWindow(swap, new Date(fixture.now.getTime() - 20 * MINUTE_MS));
    const before = await score(fixture.provider.userId);
    await authenticated(
      fixture.provider.userId,
      'select public.confirm_pickup_done($1::uuid)',
      [swap.legId],
    );
    expect(await score(fixture.provider.userId)).toBe(before - 2);
    expect(await lateEvents(fixture.provider.userId)).toEqual([
      { reason_code: 'late_with_advance_notice', delta: -2 },
    ]);
  });

  it('crossSchoolAndRoleDenials: School B and requester cannot post or read School A notice', async () => {
    const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
    const swap = await createAcceptedSwap(serviceAt);
    await authenticated(
      fixture.provider.userId,
      'select public.post_running_late_notice($1::uuid)',
      [swap.legId],
    );

    await denied(() => authenticated(fixture.requester.userId,
      'select public.post_running_late_notice($1::uuid)', [swap.legId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.post_running_late_notice($1::uuid)', [swap.legId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.post_running_late_notice($1::uuid)', [swap.legId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.get_running_late_notice($1::uuid)', [swap.legId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.get_running_late_notice($1::uuid)', [swap.legId]));

    const foreignList = await authenticated<{ notices: unknown[] }>(
      fixture.parentB.userId,
      'select public.list_my_running_late_notices() as notices',
    );
    expect(foreignList[0].notices).toEqual([]);

    const rows = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.running_late_notices where swap_leg_id = $1',
      [swap.legId],
    );
    expect(rows).toEqual([]);
  });

  it('noClientMutateAndCatalog: direct DML denied; RLS on; no money or location fields', async () => {
    const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
    const swap = await createAcceptedSwap(serviceAt);
    const posted = await authenticated<{ notice: { id: string } }>(
      fixture.provider.userId,
      'select public.post_running_late_notice($1::uuid) as notice',
      [swap.legId],
    );

    await denied(() => authenticated(fixture.provider.userId,
      `insert into public.running_late_notices
        (school_id, swap_id, swap_leg_id, posted_by, posted_by_membership, window_starts_at)
       values ($1,$2,$3,$4,$5, now() + interval '1 hour')`,
      [fixture.schoolA, swap.swapId, swap.reverseLegId, fixture.provider.userId,
        fixture.provider.membershipId]),
    ['42501']);
    await denied(() => authenticated(fixture.provider.userId,
      'delete from public.running_late_notices where id = $1', [posted[0].notice.id]),
    ['42501', '55000']);

    const catalog = await privileged('read-back: running late catalog', async () => {
      const rls = await db().query<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'running_late_notices'`);
      const cols = await db().query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'running_late_notices'`);
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'post_running_late_notice', 'get_running_late_notice',
             'list_my_running_late_notices', 'post_trust_late_arrival',
             'running_late_pickup_window_start', 'guard_running_late_notices'
           )
         order by p.proname`);
      return { rls: rls.rows[0]?.relrowsecurity, cols: cols.rows.map((c) => c.column_name), grants: grants.rows };
    });

    expect(catalog.rls).toBe(true);
    expect(catalog.cols.join(',')).not.toMatch(/amount|price|currency|latitude|longitude|phone|mobile|nickname/i);
    expect(catalog.grants.filter((g) => g.auth_exec).map((g) => g.name).sort()).toEqual([
      'get_running_late_notice', 'list_my_running_late_notices', 'post_running_late_notice',
    ]);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
    }
  });
});
