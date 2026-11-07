/**
 * Task 6.3 live suite: no-show/false-report, safety holds, appeals, moderator
 * resolution, cross-school denials. Authenticated + synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  moderatorA: Member;
  parentB: Member;
  moderatorB: Member;
  now: Date;
};

describe('Task 6.3 live trust holds appeals and reports', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Trust holds live test connection is not initialised.');
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
    const name = `trust_hold_denial_${++savepointNumber}`;
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
    const moderatorA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [requester, provider, moderatorA, parentB, moderatorB];
    const userIds = members.map((m) => m.userId);
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Trust Hold School A', 'Australia/Sydney'),
             ($3, $4, 'Trust Hold School B', 'Australia/Melbourne')`,
    [schoolA, `trust-h-a-${schoolA}`, schoolB, `trust-h-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'trust-hold-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Trust Hold Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) as u(id)`, [userIds]);
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
      values ($1, $2, 1, 'Trust hold A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Trust hold B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, requester, provider, moderatorA, parentB, moderatorB, now: clock[0].now,
    };
  }

  async function createAcceptedLeg(): Promise<{ swapId: string; legId: string }> {
    return privileged('fixture: accepted swap leg for trust cases', async () => {
      const serviceAt = new Date(fixture.now.getTime() - HOUR_MS);
      const proposedAt = new Date(serviceAt.getTime() - DAY_MS);
      const acceptedAt = new Date(serviceAt.getTime() - 12 * HOUR_MS);
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
      return { swapId, legId };
    });
  }

  async function score(userId: string): Promise<number> {
    const rows = await authenticated<{ trust: { trust_score: number } }>(
      userId, 'select public.get_my_trust() as trust',
    );
    return rows[0].trust.trust_score;
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for trust holds live tests.');
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

  it('noShowConfirmPostsPenaltyAndTripsOwed: moderator confirm applies policy delta and two trip obligations', async () => {
    const { legId } = await createAcceptedLeg();
    const before = await score(fixture.provider.userId);
    const reportRows = await authenticated<{ report_no_show: string }>(
      fixture.requester.userId,
      'select public.report_no_show($1::uuid, false) as report_no_show', [legId],
    );
    const reportId = reportRows[0].report_no_show;
    const resolved = await authenticated<{ resolve_trust_report: string }>(
      fixture.moderatorA.userId,
      'select public.resolve_trust_report($1::uuid, $2::text) as resolve_trust_report',
      [reportId, 'confirm'],
    );
    expect(resolved[0].resolve_trust_report).toBe('confirmed');
    expect(await score(fixture.provider.userId)).toBe(before - 20);
    const events = await authenticated<{ reason_code: string; delta: number }>(
      fixture.provider.userId,
      `select reason_code, delta from public.trust_score_events
       where subject_user_id = $1 and source_entity_id = $2`,
      [fixture.provider.userId, reportId],
    );
    expect(events).toEqual([expect.objectContaining({ reason_code: 'confirmed_no_show', delta: -20 })]);
    const penalties = await authenticated<{ sequence_no: number }>(
      fixture.provider.userId,
      `select sequence_no from public.trust_trip_penalties where report_id = $1 order by sequence_no`,
      [reportId],
    );
    expect(penalties.map((row) => row.sequence_no)).toEqual([1, 2]);
    const ledger = await authenticated<{ ledger: { partners: Array<{ trips_i_owe: number }> } }>(
      fixture.provider.userId, 'select public.get_my_ledger() as ledger',
    );
    expect(ledger[0].ledger.partners.some((partner) => partner.trips_i_owe >= 2)).toBe(true);
  });

  it('disputeAndFalseReport: subject dispute blocks auto path; false-report confirm penalises original reporter', async () => {
    const { legId } = await createAcceptedLeg();
    const noShow = await authenticated<{ report_no_show: string }>(
      fixture.requester.userId,
      'select public.report_no_show($1::uuid, true) as report_no_show', [legId],
    );
    const disputed = await authenticated<{ dispute_trust_report: string }>(
      fixture.provider.userId,
      'select public.dispute_trust_report($1::uuid) as dispute_trust_report',
      [noShow[0].report_no_show],
    );
    expect(disputed[0].dispute_trust_report).toBe('disputed');
    const beforeReporter = await score(fixture.requester.userId);
    const falseReport = await authenticated<{ report_false_report: string }>(
      fixture.provider.userId,
      'select public.report_false_report($1::uuid) as report_false_report',
      [noShow[0].report_no_show],
    );
    await authenticated(fixture.moderatorA.userId,
      'select public.resolve_trust_report($1::uuid, $2::text)',
      [falseReport[0].report_false_report, 'confirm']);
    expect(await score(fixture.requester.userId)).toBe(beforeReporter - 15);
  });

  it('safetyHoldDisablesSwapsAndIsAppealable: hold blocks transition; appeal uplift lifts hold', async () => {
    const hold = await authenticated<{ place_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.place_safety_hold($1::uuid) as place_safety_hold',
      [fixture.provider.userId],
    );
    const held = await authenticated<{ held: boolean }>(
      fixture.requester.userId,
      'select public.user_has_active_safety_hold($1::uuid, $2::uuid) as held',
      [fixture.provider.userId, fixture.schoolA],
    );
    expect(held[0].held).toBe(true);
    const { swapId } = await createAcceptedLeg();
    // Force a proposed swap involving held provider as recipient.
    const proposed = await privileged('fixture: proposed swap with held recipient', async () => {
      const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
      const proposedAt = fixture.now;
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
        (id, school_id, proposer_id, recipient_id, status, proposed_at, expires_at)
        values ($1, $2, $3, $4, 'proposed', $5, $6)`, [
        swapId, fixture.schoolA, fixture.requester.userId, fixture.provider.userId,
        proposedAt, new Date(proposedAt.getTime() + 2 * DAY_MS),
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
      return swapId;
    });
    await denied(() => authenticated(fixture.provider.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text)', [proposed, 'accept']));
    void swapId;
    const appeal = await authenticated<{ file_trust_appeal: string }>(
      fixture.provider.userId,
      'select public.file_trust_appeal($1::text, $2::uuid) as file_trust_appeal',
      ['safety_hold', hold[0].place_safety_hold],
    );
    const uplift = await authenticated<{ resolve_trust_appeal: string }>(
      fixture.moderatorA.userId,
      'select public.resolve_trust_appeal($1::uuid, $2::text) as resolve_trust_appeal',
      [appeal[0].file_trust_appeal, 'uphold'],
    );
    expect(uplift[0].resolve_trust_appeal).toBe('upheld');
    const after = await authenticated<{ held: boolean }>(
      fixture.requester.userId,
      'select public.user_has_active_safety_hold($1::uuid, $2::uuid) as held',
      [fixture.provider.userId, fixture.schoolA],
    );
    expect(after[0].held).toBe(false);
  });

  it('holdUpholdAppliesSafetyViolation: upheld hold posts reviewed_safety_violation', async () => {
    const before = await score(fixture.provider.userId);
    const hold = await authenticated<{ place_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.place_safety_hold($1::uuid) as place_safety_hold',
      [fixture.provider.userId],
    );
    const resolved = await authenticated<{ resolve_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.resolve_safety_hold($1::uuid, $2::text) as resolve_safety_hold',
      [hold[0].place_safety_hold, 'uphold'],
    );
    expect(resolved[0].resolve_safety_hold).toBe('upheld');
    expect(await score(fixture.provider.userId)).toBe(before - 25);
  });

  it('crossSchoolAndRoleDenials: School B cannot resolve School A cases or read foreign rows', async () => {
    const { legId } = await createAcceptedLeg();
    const report = await authenticated<{ report_no_show: string }>(
      fixture.requester.userId,
      'select public.report_no_show($1::uuid, false) as report_no_show', [legId],
    );
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.resolve_trust_report($1::uuid, $2::text)',
      [report[0].report_no_show, 'confirm']));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.place_safety_hold($1::uuid)', [fixture.provider.userId]));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.list_school_trust_queue()'));
    const foreign = await authenticated<{ id: string }>(fixture.parentB.userId,
      `select id from public.trust_incident_reports where id = $1`,
      [report[0].report_no_show]);
    expect(foreign).toEqual([]);
    const hold = await authenticated<{ place_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.place_safety_hold($1::uuid) as place_safety_hold',
      [fixture.provider.userId],
    );
    const foreignHold = await authenticated<{ id: string }>(fixture.moderatorB.userId,
      `select id from public.trust_safety_holds where id = $1`,
      [hold[0].place_safety_hold]);
    expect(foreignHold).toEqual([]);
  });

  it('allowlistAndSearchPath: Task 6.3 RPCs are allowlisted with pg_catalog paths', async () => {
    const allowlist = JSON.parse(
      await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8'),
    ) as { authenticated: Array<{ name: string }>; internal: Array<{ name: string }> };
    const authNames = allowlist.authenticated.map((entry) => entry.name);
    const internalNames = allowlist.internal.map((entry) => entry.name);
    for (const name of [
      'report_no_show', 'dispute_trust_report', 'report_false_report', 'resolve_trust_report',
      'place_safety_hold', 'resolve_safety_hold', 'file_trust_appeal', 'resolve_trust_appeal',
      'list_my_trust_cases', 'list_school_trust_queue', 'user_has_active_safety_hold',
    ]) {
      expect(authNames).toContain(name);
    }
    for (const name of [
      'guard_trust_trip_penalties', 'apply_confirmed_no_show_effects',
      'apply_confirmed_false_report_effects', 'sweep_provisional_trust_reports',
    ]) {
      expect(internalNames).toContain(name);
      expect(authNames).not.toContain(name);
    }
    const rows = await privileged('read-back: trust hold function paths', async () => {
      return (await db().query<{ proname: string; search_path: string | null }>(`
        select p.proname,
          (select substr(setting, 13) from pg_catalog.unnest(p.proconfig) setting
           where setting like 'search_path=%' limit 1) as search_path
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'report_no_show', 'resolve_trust_report', 'place_safety_hold',
          'file_trust_appeal', 'sweep_provisional_trust_reports', 'user_has_active_safety_hold'
        )
      `)).rows;
    });
    expect(rows.length).toBe(6);
    for (const row of rows) expect(row.search_path).toBe('pg_catalog');
  });
});
