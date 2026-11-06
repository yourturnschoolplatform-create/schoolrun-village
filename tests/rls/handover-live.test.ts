import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const MINUTE_MS = 60_000;
const confirmationColumns = ['id', 'school_id', 'swap_leg_id', 'member', 'confirmation_kind', 'confirmed_at'];
const reminderColumns = [
  'id', 'school_id', 'swap_leg_id', 'recipient_membership', 'missing_confirmation',
  'expected_arrival_at', 'due_at', 'created_at',
];
const handoverTables = ['swap_leg_confirmations', 'swap_leg_reminders'];
const handoverFunctions = [
  'confirm_pickup_done', 'confirm_child_arrived', 'refresh_my_handover_reminders',
  'enqueue_due_handover_reminders', 'record_leg_confirmation', 'guard_handover_history',
  'maybe_record_handover_reminder',
];
type Kind = 'pickup_done' | 'child_arrived';
type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string; schoolB: string; declarationA: string; declarationB: string;
  requester: Member; provider: Member; unrelated: Member; parentB: Member; moderatorB: Member;
  pending: Member; noMembershipUser: string; userIds: string[]; now: Date;
};
type Swap = {
  swapId: string; legId: string; reverseLegId: string;
  helperInstanceId: string; requesterInstanceId: string;
};
type Receipt = { legId: string; confirmationKind: Kind; confirmedAt: string; completedAt: string | null };
type Facts = {
  confirmations: QueryResultRow[]; reminders: QueryResultRow[]; ledger: QueryResultRow[];
  events: QueryResultRow[]; completed_at: string | null; audit_count: number; profiles: unknown;
};

/**
 * Independent rollback fixture copied minimally from ledger/contact-live.test.ts.
 * Only SUPABASE_RLS_TEST_DATABASE_URL is consumed. Each test owns one transaction,
 * including setup failures, and afterEach unconditionally rolls it back. No global
 * consent document, committed fixture, migration, DEV connection or DDL is changed.
 * Privileged fixture/guard/read-back operations are labelled and are not RLS proof.
 * The error boundary discards driver diagnostics, SQL parameters and auth records;
 * assertions expose only synthetic IDs, timestamps, SQLSTATEs and boolean facts.
 */
describe('Task 5.3 live two-party handover and missing-confirmation reminders', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    if (!client) throw new Error('Handover live test connection is not initialized.');
    try { return await client.query<T>(sql, values); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
      throw Object.assign(new Error(`Handover database operation failed (SQLSTATE ${code}); details suppressed.`), { code });
    }
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^(fixture|read-back): [a-z0-9 ._-]+$/i.test(label)) {
      throw new Error('Privileged operations require a fixture/read-back label.');
    }
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
    const identity = await query(`select current_user::text as role,
      current_setting('row_security') as row_security, r.rolsuper, r.rolbypassrls,
      auth.uid() = $1::uuid as correct_subject
      from pg_catalog.pg_roles r where r.rolname = current_user`, [userId]);
    expect(identity.rows).toEqual([{
      role: 'authenticated', row_security: 'on', rolsuper: false, rolbypassrls: false, correct_subject: true,
    }]);
    return (await query<T>(sql, values)).rows;
  }

  async function anonymous(sql: string, values: unknown[] = []): Promise<QueryResultRow[]> {
    await query('set local role anon; set local row_security = on');
    await query(`select set_config('request.jwt.claims', '{"role":"anon"}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`);
    expect((await query(`select current_user::text as role, current_setting('row_security') as row_security,
      rolsuper, rolbypassrls, auth.uid() is null as no_subject
      from pg_catalog.pg_roles where rolname = current_user`)).rows).toEqual([{
      role: 'anon', row_security: 'on', rolsuper: false, rolbypassrls: false, no_subject: true,
    }]);
    return (await query(sql, values)).rows;
  }

  async function isolated<T>(action: () => Promise<T>): Promise<T> {
    const name = `handover_isolated_${++savepointNumber}`;
    await query(`savepoint ${name}`);
    try { return await action(); }
    finally {
      // An unexpectedly successful mutation is rolled back before failure reporting.
      await query(`rollback to savepoint ${name}; release savepoint ${name}`);
    }
  }

  async function denied(action: () => Promise<unknown>, codes = ['42501']): Promise<void> {
    let code: string | null = null;
    await isolated(async () => {
      try { await action(); }
      catch (error) { code = (error as { code?: string }).code ?? 'non-database-error'; }
    });
    expect(codes).toContain(code);
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({ schoolId, userId: randomUUID(), membershipId: randomUUID() });
    const requester = member(schoolA);
    const provider = member(schoolA);
    const unrelated = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const pending = member(schoolA);
    const noMembershipUser = randomUUID();
    const members = [requester, provider, unrelated, parentB, moderatorB, pending];
    const userIds = [...members.map((m) => m.userId), noMembershipUser];
    const now = (await query<{ now: Date }>('select now() as now')).rows[0].now;
    await query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'yourturn_test_ Handover A', 'Australia/Sydney'),
             ($3, $4, 'yourturn_test_ Handover B', 'Australia/Melbourne')`,
    [schoolA, `handover-a-${schoolA}`, schoolB, `handover-b-${schoolB}`]);
    await query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated', 'handover-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"yourturn_test_ Handover"}'::jsonb, now(), now()
      from unnest($1::uuid[]) u(id)`, [userIds]);
    await query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, status::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[]) m(id, school_id, user_id, status)`, [
      members.map((m) => m.membershipId), members.map((m) => m.schoolId), members.map((m) => m.userId),
      members.map((m) => m === pending ? 'pending_moderator' : 'verified'),
    ]);
    await query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`, [randomUUID(), moderatorB.userId, schoolB]);
    // Global published consent documents are read only, never replaced/deactivated.
    await query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Handover A', 'Synthetic safety declaration A', true, now()),
             ($3, $4, 1, 'Handover B', 'Synthetic safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    const signed = members.filter((m) => m !== pending);
    await query(`insert into public.safety_declarations
      (id, membership_id, parent_id, school_id, declaration_version_id,
       licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      select id, membership_id, parent_id, school_id, declaration_id, true, true, true, true
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
        s(id, membership_id, parent_id, school_id, declaration_id)`, [
      signed.map(() => randomUUID()), signed.map((m) => m.membershipId), signed.map((m) => m.userId),
      signed.map((m) => m.schoolId), signed.map((m) => m.schoolId === schoolA ? declarationA : declarationB),
    ]);
    return {
      schoolA, schoolB, declarationA, declarationB, requester, provider, unrelated,
      parentB, moderatorB, pending, noMembershipUser, userIds, now,
    };
  }

  async function createSwap(options: {
    requester?: Member; provider?: Member; status?: 'accepted' | 'proposed'; expectedAt?: Date;
  } = {}): Promise<Swap> {
    return privileged('fixture: independent reciprocal accepted source legs', async () => {
      const requester = options.requester ?? fixture.requester;
      const provider = options.provider ?? fixture.provider;
      const status = options.status ?? 'accepted';
      const swapId = randomUUID();
      const legId = randomUUID();
      const reverseLegId = randomUUID();
      const patterns = Array.from({ length: 4 }, () => randomUUID());
      const instances = Array.from({ length: 4 }, () => randomUUID());
      const owners = [provider.userId, requester.userId, requester.userId, provider.userId];
      const intents = ['can_help', 'need_help', 'can_help', 'need_help'];
      await query(`insert into public.availability_patterns
        (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
         area_label, capacity, starts_on, created_at)
        select p.id, $2::uuid, p.owner_id, p.intent::public.schedule_intent, 'pickup',
          extract(isodow from (now() at time zone s.timezone))::smallint,
          '15:00'::time, '15:30'::time, 'Carlton', 1, (now() at time zone s.timezone)::date,
          now() - interval '2 days'
        from unnest($1::uuid[], $3::uuid[], $4::text[]) p(id, owner_id, intent)
        cross join public.schools s where s.id = $2`, [patterns, requester.schoolId, owners, intents]);
      await query(`insert into public.availability_instances
        (id, pattern_id, school_id, owner_id, service_date, intent, direction,
         window_start, window_end, area_label, capacity, created_at)
        select i.id, i.pattern_id, $3::uuid, i.owner_id, (now() at time zone s.timezone)::date,
          i.intent::public.schedule_intent, 'pickup', '15:00'::time, '15:30'::time, 'Carlton', 1,
          now() - interval '2 days'
        from unnest($1::uuid[], $2::uuid[], $4::uuid[], $5::text[]) i(id, pattern_id, owner_id, intent)
        cross join public.schools s where s.id = $3`, [instances, patterns, requester.schoolId, owners, intents]);
      // Accepted clock always precedes the actual RPC confirmation clock.
      await query(`insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, accepted_at, expires_at)
        values ($1, $2, $3, $4, $5, now() - interval '2 days',
          case when $5 = 'accepted' then now() - interval '1 day' else null end,
          now() + interval '1 day')`, [swapId, requester.schoolId, requester.userId, provider.userId, status]);
      await query(`insert into public.swap_legs
        (id, swap_id, school_id, helper_instance_id, requester_instance_id,
         helper_id, requester_id, service_date, created_at)
        select leg_id, $3::uuid, $4::uuid, helper_instance_id, requester_instance_id,
          helper_id, requester_id, (now() at time zone s.timezone)::date, now() - interval '2 days'
        from (values ($1::uuid, $5::uuid, $6::uuid, $9::uuid, $10::uuid),
                     ($2::uuid, $7::uuid, $8::uuid, $10::uuid, $9::uuid))
          l(leg_id, helper_instance_id, requester_instance_id, helper_id, requester_id)
        cross join public.schools s where s.id = $4`, [
        legId, reverseLegId, swapId, requester.schoolId, ...instances, provider.userId, requester.userId,
      ]);
      if (options.expectedAt) {
        // Boundary clock fixture only, before either participant confirms.
        await query('update public.swap_legs set expected_arrival_at = $2 where swap_id = $1',
          [swapId, options.expectedAt]);
      }
      return { swapId, legId, reverseLegId, helperInstanceId: instances[0], requesterInstanceId: instances[1] };
    });
  }

  async function confirm(swap: Swap, kind: Kind, actor?: Member, legId = swap.legId): Promise<Receipt> {
    const member = actor ?? (kind === 'pickup_done' ? fixture.provider : fixture.requester);
    const rows = await authenticated<{ receipt: Receipt }>(member.userId,
      `select public.confirm_${kind}($1::uuid) as receipt`, [legId]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].receipt).sort()).toEqual(['legId', 'confirmationKind', 'confirmedAt', 'completedAt'].sort());
    expect(rows[0].receipt).toMatchObject({ legId, confirmationKind: kind });
    expect(Number.isFinite(Date.parse(rows[0].receipt.confirmedAt))).toBe(true);
    return rows[0].receipt;
  }

  async function refresh(actor = fixture.requester): Promise<number> {
    const rows = await authenticated<{ count: number }>(actor.userId,
      'select public.refresh_my_handover_reminders() as count');
    expect(rows).toHaveLength(1);
    expect(Number.isInteger(rows[0].count)).toBe(true);
    return rows[0].count;
  }

  async function visible(actor: Member, table: string, legId: string): Promise<QueryResultRow[]> {
    if (!handoverTables.includes(table)) throw new Error('Unknown handover table.');
    return authenticated(actor.userId, `select * from public.${table} where swap_leg_id = $1 order by id`, [legId]);
  }

  async function facts(swap: Swap, legId = swap.legId): Promise<Facts> {
    return privileged('read-back: handover facts and side effect counts', async () => {
      const rows = await query<Facts>(`select
        (select completed_at::text from public.swap_legs where id = $1) as completed_at,
        coalesce((select jsonb_agg(to_jsonb(c) order by id) from public.swap_leg_confirmations c
          where swap_leg_id = $1), '[]'::jsonb) as confirmations,
        coalesce((select jsonb_agg(to_jsonb(r) order by id) from public.swap_leg_reminders r
          where swap_leg_id = $1), '[]'::jsonb) as reminders,
        coalesce((select jsonb_agg(to_jsonb(l) order by id) from public.swap_ledger_entries l
          where swap_leg_id = $1), '[]'::jsonb) as ledger,
        coalesce((select jsonb_agg(to_jsonb(e) order by actor_id) from public.analytics_events e
          where actor_id = any($2::uuid[]) and event_name = 'first_trip_completed'), '[]'::jsonb) as events,
        (select count(*)::int from public.audit_logs where school_id = any($3::uuid[])) as audit_count,
        (select jsonb_object_agg(id::text, jsonb_build_array(trust_score, updated_at))
          from public.profiles where id = any($2::uuid[])) as profiles`,
      [legId, fixture.userIds, [fixture.schoolA, fixture.schoolB]]);
      return rows.rows[0];
    });
  }

  async function finish(swap: Swap): Promise<void> {
    await confirm(swap, 'pickup_done');
    await confirm(swap, 'child_arrived');
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for handover live tests.');
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
    try { await client.connect(); }
    catch { throw new Error('Unable to connect to the dedicated RLS test database; connection details suppressed.'); }
    await query('begin');
    transactionStarted = true;
    await query(`set local timezone = 'UTC'; set local row_security = on;
      set local statement_timeout = '20s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: independent two-school handover onboarding', seed);
  }, LIVE_TIMEOUT);

  afterEach(async () => {
    try { if (transactionStarted && client) await query('rollback'); }
    finally {
      transactionStarted = false;
      if (client) await client.end();
      client = undefined;
    }
  }, LIVE_TIMEOUT);

  it('defaultExpectedArrival: requester school-local date and window end derive the timestamp with no premature facts', async () => {
    const swap = await createSwap();
    const rows = await authenticated(fixture.requester.userId, `select
      l.expected_arrival_at is not null as populated,
      l.expected_arrival_at = ((i.service_date + i.window_end) at time zone s.timezone) as school_local_default,
      l.completed_at is null as incomplete
      from public.swap_legs l join public.availability_instances i on i.id = l.requester_instance_id
      join public.schools s on s.id = l.school_id where l.id = $1`, [swap.legId]);
    expect(rows).toEqual([{ populated: true, school_local_default: true, incomplete: true }]);
    const state = await facts(swap);
    expect(state.confirmations).toEqual([]);
    expect(state.ledger).toEqual([]);
    expect(state.events).toEqual([]);
    expect(await refresh()).toBe(0);
  });

  it.each(['pickup_done', 'child_arrived'] as const)(
    'bothOrders-%s: either first confirmation leaves incomplete and second posts one recipient-to-provider trip', async (firstKind) => {
      const swap = await createSwap({ expectedAt: new Date(fixture.now.getTime() + 90 * MINUTE_MS) });
      const first = await confirm(swap, firstKind);
      expect(first.completedAt).toBeNull();
      const before = await facts(swap);
      expect(before.completed_at).toBeNull();
      expect(before.confirmations).toHaveLength(1);
      expect(before.ledger).toEqual([]);
      expect(before.events).toEqual([]);
      const second = await confirm(swap, firstKind === 'pickup_done' ? 'child_arrived' : 'pickup_done');
      expect(second.completedAt).not.toBeNull();
      const state = await facts(swap);
      expect(state.confirmations).toHaveLength(2);
      expect(Date.parse(second.completedAt!)).toBe(Math.max(...state.confirmations.map((c) => Date.parse(c.confirmed_at))));
      expect(state.ledger).toHaveLength(1);
      expect(state.ledger[0]).toMatchObject({
        school_id: fixture.schoolA, swap_leg_id: swap.legId, trip_count_delta: 1,
        from_membership: fixture.requester.membershipId, to_membership: fixture.provider.membershipId,
      });
      expect(Date.parse(state.completed_at!)).toBe(Date.parse(second.completedAt!));
      expect(Date.parse(state.ledger[0].created_at)).toBe(Date.parse(second.completedAt!));
      for (const actor of [fixture.requester, fixture.provider]) {
        expect(await visible(actor, 'swap_leg_confirmations', swap.legId)).toHaveLength(2);
        const ledger = await authenticated(actor.userId,
          'select swap_leg_id, trip_count_delta from public.swap_ledger_entries where swap_leg_id = $1', [swap.legId]);
        expect(ledger).toEqual([{ swap_leg_id: swap.legId, trip_count_delta: 1 }]);
      }
    },
  );

  it('duplicateTaps: identical confirmation timestamps and all side-effect counts survive repeats before and after completion', async () => {
    const swap = await createSwap();
    const first = await confirm(swap, 'pickup_done');
    const before = await facts(swap);
    expect(await confirm(swap, 'pickup_done')).toEqual(first);
    expect(await facts(swap)).toEqual(before);
    const arrived = await confirm(swap, 'child_arrived');
    const completed = await facts(swap);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await confirm(swap, 'pickup_done')).toEqual({ ...first, completedAt: arrived.completedAt });
      expect(await confirm(swap, 'child_arrived')).toEqual(arrived);
      expect(await refresh()).toBe(0);
    }
    expect(await facts(swap)).toEqual(completed);
    expect(completed.confirmations).toHaveLength(2);
    expect(completed.ledger).toHaveLength(1);
    expect(completed.events).toHaveLength(2);
  });

  it.each(['unrelated', 'parentB', 'moderatorB', 'pending', 'noMembershipUser'] as const)(
    'wrongCaller-%s: both confirmation RPCs deny School A IDs and refresh cannot reach their facts', async (key) => {
      const swap = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
      await confirm(swap, 'pickup_done');
      const before = await facts(swap);
      const userId = key === 'noMembershipUser' ? fixture.noMembershipUser : fixture[key].userId;
      for (const kind of ['pickup_done', 'child_arrived']) {
        await denied(() => authenticated(userId, `select public.confirm_${kind}($1::uuid)`, [swap.legId]));
      }
      expect(await authenticated(userId, 'select public.refresh_my_handover_reminders() as count')).toEqual([{ count: 0 }]);
      for (const table of handoverTables) {
        expect(await authenticated(userId, `select id from public.${table} where swap_leg_id = $1`, [swap.legId])).toEqual([]);
      }
      expect(await facts(swap)).toEqual(before);
    },
  );

  it('inactiveParticipant: pending suspended stale-safety and stale-consent participants cannot confirm or read', async () => {
    const swap = await createSwap();
    await confirm(swap, 'pickup_done');
    for (const state of ['pending_moderator', 'suspended', 'missingSafety', 'missingConsent']) {
      await isolated(async () => {
        await privileged('fixture: participant no longer fully onboarded', async () => {
          if (state === 'missingSafety') {
            await query('delete from public.safety_declarations where membership_id = $1', [fixture.requester.membershipId]);
          } else if (state === 'missingConsent') {
            await query('delete from public.consent_acceptances where user_id = $1', [fixture.requester.userId]);
          } else {
            await query('update public.school_memberships set status = $2 where id = $1', [fixture.requester.membershipId, state]);
          }
        });
        for (const kind of ['pickup_done', 'child_arrived']) {
          await denied(() => authenticated(fixture.requester.userId, `select public.confirm_${kind}($1::uuid)`, [swap.legId]));
        }
        for (const table of handoverTables) expect(await visible(fixture.requester, table, swap.legId)).toEqual([]);
        expect(await refresh()).toBe(0);
      });
    }
  });

  it('acceptedOnlyAndCorrectRole: wrong participant roles proposed and consent-cancelled legs reject confirmation', async () => {
    const accepted = await createSwap();
    const untouched = await facts(accepted);
    await denied(() => authenticated(fixture.requester.userId, 'select public.confirm_pickup_done($1::uuid)', [accepted.legId]));
    await denied(() => authenticated(fixture.provider.userId, 'select public.confirm_child_arrived($1::uuid)', [accepted.legId]));
    expect(await facts(accepted)).toEqual(untouched);
    await denied(() => authenticated(fixture.provider.userId, 'select public.confirm_pickup_done($1::uuid)', [randomUUID()]));
    await denied(() => authenticated(fixture.requester.userId, 'select public.confirm_child_arrived($1::uuid)', [randomUUID()]));
    const proposed = await createSwap({ status: 'proposed' });
    const cancelled = await createSwap();
    await authenticated(fixture.requester.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text)', [cancelled.swapId, '+61400000101']);
    await authenticated(fixture.requester.userId, 'select public.revoke_contact_sharing($1::uuid)', [cancelled.swapId]);
    for (const swap of [proposed, cancelled]) {
      const before = await facts(swap);
      await denied(() => authenticated(fixture.provider.userId, 'select public.confirm_pickup_done($1::uuid)', [swap.legId]));
      await denied(() => authenticated(fixture.requester.userId, 'select public.confirm_child_arrived($1::uuid)', [swap.legId]));
      expect(await facts(swap)).toEqual(before);
    }
  });

  it('anonymousDenied: actual anon execution denies every new function and both handover tables', async () => {
    const swap = await createSwap();
    const calls: Array<[string, unknown[]]> = [
      ['confirm_pickup_done($1::uuid)', [swap.legId]], ['confirm_child_arrived($1::uuid)', [swap.legId]],
      ['refresh_my_handover_reminders()', []], ['enqueue_due_handover_reminders()', []],
      ["record_leg_confirmation($1::uuid, 'pickup_done'::text)", [swap.legId]], ['guard_handover_history()', []],
      ['maybe_record_handover_reminder($1::uuid)', [swap.legId]],
    ];
    for (const [call, values] of calls) await denied(() => anonymous(`select public.${call}`, values));
    for (const table of handoverTables) await denied(() => anonymous(`select id from public.${table} where swap_leg_id = $1`, [swap.legId]));
  });

  it('readIsolation: School B parent and moderator read only their own leg while unrelated and inactive-school callers see none', async () => {
    const a = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
    const b = await createSwap({ requester: fixture.parentB, provider: fixture.moderatorB,
      expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
    await confirm(a, 'pickup_done');
    await confirm(b, 'pickup_done', fixture.moderatorB);
    expect(await refresh()).toBe(0);
    expect(await refresh(fixture.parentB)).toBe(0);
    for (const actor of [fixture.parentB, fixture.moderatorB]) {
      for (const table of handoverTables) {
        expect(await visible(actor, table, a.legId)).toEqual([]);
        expect(await visible(actor, table, b.legId)).toHaveLength(1);
      }
      await denied(() => authenticated(actor.userId, 'select public.confirm_pickup_done($1::uuid)', [a.legId]));
      await denied(() => authenticated(actor.userId, 'select public.confirm_child_arrived($1::uuid)', [a.legId]));
      expect(await refresh(actor)).toBe(0);
    }
    for (const table of handoverTables) expect(await visible(fixture.unrelated, table, a.legId)).toEqual([]);
    await privileged('fixture: previously participating school membership becomes inactive', async () => {
      await query("update public.school_memberships set status = 'suspended' where id = $1", [fixture.requester.membershipId]);
    });
    for (const table of handoverTables) expect(await visible(fixture.requester, table, a.legId)).toEqual([]);
    expect(await refresh()).toBe(0);
  });

  it('noDirectDML: participants and School B cannot INSERT UPDATE DELETE TRUNCATE either new table or complete a source leg', async () => {
    const swap = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
    await confirm(swap, 'pickup_done');
    await refresh();
    const before = await facts(swap);
    const inserts: Record<string, [string, unknown[]]> = {
      swap_leg_confirmations: [`(id, school_id, swap_leg_id, member, confirmation_kind, confirmed_at)
        values ($1, $2, $3, $4, 'child_arrived', now())`,
      [randomUUID(), fixture.schoolA, swap.legId, fixture.requester.membershipId]],
      swap_leg_reminders: [`(id, school_id, swap_leg_id, recipient_membership,
        missing_confirmation, expected_arrival_at, due_at, created_at)
        values ($1, $2, $3, $4, 'child_arrived', now() - interval '31 minutes', now() - interval '1 minute', now())`,
      [randomUUID(), fixture.schoolA, swap.legId, fixture.requester.membershipId]],
    };
    for (const actor of [fixture.requester, fixture.provider, fixture.parentB, fixture.moderatorB]) {
      for (const table of handoverTables) {
        await denied(() => authenticated(actor.userId, `insert into public.${table} ${inserts[table][0]}`, inserts[table][1]));
        await denied(() => authenticated(actor.userId, `update public.${table} set school_id = school_id where swap_leg_id = $1`, [swap.legId]));
        await denied(() => authenticated(actor.userId, `delete from public.${table} where swap_leg_id = $1`, [swap.legId]));
        await denied(() => authenticated(actor.userId, `truncate public.${table}`));
      }
      await denied(() => authenticated(actor.userId,
        'update public.swap_legs set completed_at = now() where id = $1', [swap.legId]));
    }
    expect(await facts(swap)).toEqual(before);
  });

  it.each(['pickup_done', 'child_arrived'] as const)(
    'reminderBoundary-%s: plus29 yields none plus31 yields one correctly targeted immutable reminder', async (firstKind) => {
      const near = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 29 * MINUTE_MS) });
      await confirm(near, firstKind);
      expect(await refresh()).toBe(0);
      expect((await facts(near)).reminders).toEqual([]);
      const due = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
      await confirm(due, firstKind);
      // The overdue first confirmation already performs the same guarded enqueue.
      expect(await refresh()).toBe(0);
      const before = await facts(due);
      expect(before.reminders).toHaveLength(1);
      const missing = firstKind === 'pickup_done' ? 'child_arrived' : 'pickup_done';
      const target = firstKind === 'pickup_done' ? fixture.requester : fixture.provider;
      expect(before.reminders[0]).toMatchObject({
        school_id: fixture.schoolA, swap_leg_id: due.legId,
        recipient_membership: target.membershipId, missing_confirmation: missing,
      });
      expect(Date.parse(before.reminders[0].due_at) - Date.parse(before.reminders[0].expected_arrival_at)).toBe(30 * MINUTE_MS);
      expect(await refresh(fixture.provider)).toBe(0);
      expect(await refresh()).toBe(0);
      expect(await facts(due)).toEqual(before);
      for (const actor of [fixture.requester, fixture.provider]) {
        expect(await visible(actor, 'swap_leg_reminders', due.legId)).toHaveLength(1);
      }
      await confirm(due, missing);
      expect(await refresh()).toBe(0);
      expect((await facts(due)).reminders).toEqual(before.reminders);
    },
  );

  it('reminderEligibility: zero both cancelled and future arrivals enqueue none and cancellation never deletes an existing reminder', async () => {
    const past = new Date(fixture.now.getTime() - 31 * MINUTE_MS);
    const zero = await createSwap({ expectedAt: past });
    const both = await createSwap({ expectedAt: past });
    await finish(both);
    const cancelled = await createSwap({ expectedAt: past });
    await confirm(cancelled, 'pickup_done');
    await authenticated(fixture.requester.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text)', [cancelled.swapId, '+61400000101']);
    await authenticated(fixture.requester.userId, 'select public.revoke_contact_sharing($1::uuid)', [cancelled.swapId]);
    const future = await createSwap({ expectedAt: new Date(fixture.now.getTime() + 31 * MINUTE_MS) });
    await confirm(future, 'pickup_done');
    const completedReminder = (await facts(both)).reminders;
    const cancelledReminder = (await facts(cancelled)).reminders;
    expect(await refresh()).toBe(0);
    for (const swap of [zero, future]) expect((await facts(swap)).reminders).toEqual([]);
    // Automatic records from the first tap are history, not pending deliveries.
    expect((await facts(both)).reminders).toEqual(completedReminder);
    expect((await facts(cancelled)).reminders).toEqual(cancelledReminder);
    const retained = await createSwap({ expectedAt: past });
    await confirm(retained, 'pickup_done');
    expect(await refresh()).toBe(0);
    const reminder = (await facts(retained)).reminders;
    expect(reminder).toHaveLength(1);
    await authenticated(fixture.requester.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text)', [retained.swapId, '+61400000101']);
    await authenticated(fixture.requester.userId, 'select public.revoke_contact_sharing($1::uuid)', [retained.swapId]);
    expect(await refresh()).toBe(0);
    expect((await facts(retained)).reminders).toEqual(reminder);
  });

  it('serviceSweep: only service may sweep both schools and authenticated School B cannot execute service or internal functions', async () => {
    const expectedAt = new Date(fixture.now.getTime() - 31 * MINUTE_MS);
    const a = await createSwap({ expectedAt });
    const b = await createSwap({ requester: fixture.parentB, provider: fixture.moderatorB, expectedAt });
    // Seed an overdue already-confirmed state without the public first-tap auto
    // enqueue. This is infrastructure only; participant RPC proofs are above.
    await privileged('fixture: overdue confirmation facts for refresh and service sweep', async () => {
      await query(`insert into public.swap_leg_confirmations
        (school_id, swap_leg_id, member, confirmation_kind, confirmed_at)
        values ($1, $2, $3, 'pickup_done', now()), ($4, $5, $6, 'child_arrived', now())`,
      [fixture.schoolA, a.legId, fixture.provider.membershipId,
        fixture.schoolB, b.legId, fixture.parentB.membershipId]);
    });
    for (const actor of [fixture.requester, fixture.parentB, fixture.moderatorB]) {
      await denied(() => authenticated(actor.userId, 'select public.enqueue_due_handover_reminders()'));
      await denied(() => authenticated(actor.userId,
        "select public.record_leg_confirmation($1::uuid, 'pickup_done'::text)", [a.legId]));
      await denied(() => authenticated(actor.userId, 'select public.guard_handover_history()'));
      await denied(() => authenticated(actor.userId,
        'select public.maybe_record_handover_reminder($1::uuid)', [a.legId]));
    }
    await isolated(async () => {
      expect(await refresh(fixture.parentB)).toBe(1);
      expect(await refresh(fixture.moderatorB)).toBe(0);
      expect((await facts(a)).reminders).toEqual([]);
      expect((await facts(b)).reminders).toHaveLength(1);
    });
    await privileged('fixture: service-only global reminder sweep', async () => {
      await query('set local role service_role; set local row_security = on');
      expect((await query('select current_user::text as role')).rows).toEqual([{ role: 'service_role' }]);
      expect((await query('select public.enqueue_due_handover_reminders() as count')).rows).toEqual([{ count: 2 }]);
      expect((await query('select public.enqueue_due_handover_reminders() as count')).rows).toEqual([{ count: 0 }]);
    });
    expect((await facts(a)).reminders[0]).toMatchObject({
      recipient_membership: fixture.requester.membershipId, missing_confirmation: 'child_arrived',
    });
    expect((await facts(b)).reminders[0]).toMatchObject({
      recipient_membership: fixture.moderatorB.membershipId, missing_confirmation: 'pickup_done',
    });
  });

  it('immutableFacts: privileged UPDATE DELETE TRUNCATE of confirmations and reminders raise 55000 without changing facts', async () => {
    const swap = await createSwap({ expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS) });
    await confirm(swap, 'pickup_done');
    await refresh();
    const before = await facts(swap);
    await privileged('fixture: immutable handover guards despite privileged grants', async () => {
      for (const table of handoverTables) {
        expect((await query(`select has_table_privilege(current_user, $1, 'UPDATE,DELETE,TRUNCATE') as granted`,
          [`public.${table}`])).rows).toEqual([{ granted: true }]);
        await denied(() => query(`update public.${table} set school_id = school_id where swap_leg_id = $1`, [swap.legId]), ['55000']);
        await denied(() => query(`delete from public.${table} where swap_leg_id = $1`, [swap.legId]), ['55000']);
        await denied(() => query(`truncate public.${table}`), ['55000']);
      }
    });
    expect(await facts(swap)).toEqual(before);
  });

  it('freezeAfterFirst: expected arrival source identity and first member cannot be rewritten after a single confirmation', async () => {
    const swap = await createSwap();
    const other = await createSwap({ provider: fixture.unrelated });
    await confirm(swap, 'pickup_done');
    const before = await facts(swap);
    await privileged('fixture: first confirmation freezes source identity', async () => {
      const changes: Array<[string, unknown[]]> = [
        ["expected_arrival_at = expected_arrival_at + interval '1 minute'", []],
        ['helper_id = $2', [fixture.unrelated.userId]], ['requester_id = $2', [fixture.unrelated.userId]],
        ['school_id = $2', [fixture.schoolB]], ['swap_id = $2', [other.swapId]],
        ['helper_instance_id = $2', [other.helperInstanceId]], ['requester_instance_id = $2', [other.requesterInstanceId]],
        ['service_date = service_date + 1', []], ['id = $2', [randomUUID()]],
      ];
      for (const [assignment, values] of changes) {
        await denied(() => query(`update public.swap_legs set ${assignment} where id = $1`, [swap.legId, ...values]), ['55000']);
      }
      await denied(() => query('update public.swap_leg_confirmations set member = $2 where swap_leg_id = $1',
        [swap.legId, fixture.unrelated.membershipId]), ['55000']);
    });
    expect(await facts(swap)).toEqual(before);
    await confirm(swap, 'child_arrived');
    expect((await facts(swap)).ledger).toHaveLength(1);
  });

  it('firstTripAnalytics: both immutable confirmation actors and source school emit once across two completed legs with no caller-supplied identity or clock', async () => {
    const swap = await createSwap();
    await finish(swap);
    const before = await facts(swap);
    expect(before.events).toHaveLength(2);
    expect(before.events.map((e) => e.actor_id).sort()).toEqual([fixture.provider.userId, fixture.requester.userId].sort());
    expect(before.events.every((e) => e.school_id === fixture.schoolA && e.event_name === 'first_trip_completed')).toBe(true);
    expect(before.confirmations.map((c) => c.member).sort()).toEqual([
      fixture.provider.membershipId, fixture.requester.membershipId,
    ].sort());
    await privileged('read-back: analytics actors resolve from immutable membership facts', async () => {
      expect((await query(`select count(*)::int as matching from public.analytics_events e
        join public.school_memberships m on m.user_id = e.actor_id
        join public.swap_leg_confirmations c on c.member = m.id
        where c.swap_leg_id = $1 and e.event_name = 'first_trip_completed'
          and e.school_id = c.school_id and e.school_id = $2`, [swap.legId, fixture.schoolA])).rows)
        .toEqual([{ matching: 2 }]);
    });
    await confirm(swap, 'child_arrived', fixture.provider, swap.reverseLegId);
    await confirm(swap, 'pickup_done', fixture.requester, swap.reverseLegId);
    expect((await facts(swap)).events).toEqual(before.events);
    expect((await facts(swap, swap.reverseLegId)).ledger).toHaveLength(1);
    for (const name of ['confirm_pickup_done', 'confirm_child_arrived']) {
      await denied(() => authenticated(fixture.parentB.userId,
        `select public.${name}($1::uuid, $2::uuid, $3::uuid, now())`,
        [swap.legId, fixture.requester.userId, fixture.schoolA]), ['42883']);
    }
  });

  it('completedConsentRevoke: real two-confirmation completion ledger analytics and confirmations survive later consent cancellation', async () => {
    const swap = await createSwap();
    await authenticated(fixture.requester.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text)', [swap.swapId, '+61400000101']);
    await finish(swap);
    const before = await facts(swap);
    const ledgers = [];
    for (const actor of [fixture.requester, fixture.provider]) {
      ledgers.push(await authenticated(actor.userId, 'select public.get_my_ledger() as ledger'));
    }
    await authenticated(fixture.requester.userId, 'select public.revoke_contact_sharing($1::uuid)', [swap.swapId]);
    const after = await facts(swap);
    expect(after.confirmations).toEqual(before.confirmations);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.events).toEqual(before.events);
    expect(after.completed_at).toBe(before.completed_at);
    for (const [index, actor] of [fixture.requester, fixture.provider].entries()) {
      expect(await authenticated(actor.userId, 'select public.get_my_ledger() as ledger')).toEqual(ledgers[index]);
    }
    expect(await refresh()).toBe(0);
  });

  it('catalogTables: exact metadata columns SELECT-only RLS unique leg-kind and no money child or travel tracking fields', async () => {
    const rows = await authenticated(fixture.requester.userId, `select c.relname as name, c.relrowsecurity as rls,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
      has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_write,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
      array(select a.attname::text from pg_catalog.pg_attribute a where a.attrelid = c.oid
        and a.attnum > 0 and not a.attisdropped order by a.attname) as columns,
      exists (select 1 from pg_catalog.pg_index i where i.indrelid = c.oid and i.indisunique
        and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
          join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum)
          = case when c.relname = 'swap_leg_confirmations'
            then array['swap_leg_id', 'confirmation_kind']::text[]
            else array['swap_leg_id', 'missing_confirmation']::text[] end) as unique_leg_kind
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[]) order by c.relname`, [handoverTables]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({
      rls: true, auth_select: true, auth_write: false, anon_access: false, unique_leg_kind: true,
      columns: [...(row.name === 'swap_leg_confirmations' ? confirmationColumns : reminderColumns)].sort(),
    });
    const columns = await authenticated<{ name: string; table_name: string }>(fixture.requester.userId,
      `select a.attname as name, c.relname as table_name from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped`);
    expect(columns.length).toBeGreaterThan(0);
    const monetary = /amount|price|currency|money|monetary|payment|cash|(?:^|_)(?:balances?|cents?|dollars?|fees?)(?:_|$)/i;
    expect(columns.filter((c) => monetary.test(c.name))).toEqual([]);
    expect(columns.filter((c) => [...handoverTables, 'swap_legs'].includes(c.table_name))
      .some((c) => /child|phone|mobile|address|latitude|longitude|location|tracking|route|gps/i.test(c.name))).toBe(false);
    expect(await authenticated(fixture.requester.userId, `select a.atttypid::regtype::text as type
      from pg_catalog.pg_attribute a
      where a.attrelid = 'public.swap_legs'::regclass and a.attname = 'expected_arrival_at'`))
      .toEqual([{ type: 'timestamp with time zone' }]);
    const cron = await authenticated<{ installed: boolean }>(fixture.requester.userId,
      "select exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') as installed");
    if (cron[0].installed) {
      expect(await authenticated(fixture.requester.userId, `select
        has_schema_privilege('authenticated', 'cron', 'USAGE') as auth_usage,
        has_schema_privilege('anon', 'cron', 'USAGE') as anon_usage`))
        .toEqual([{ auth_usage: false, anon_usage: false }]);
      // Vendor table ACLs are not sufficient: exercise effective schema denial.
      // Successful metadata mutations would also be undone by the savepoint.
      for (const table of ['job', 'job_run_details']) {
        await denied(() => authenticated(fixture.requester.userId, `select * from cron.${table} limit 1`));
        await denied(() => anonymous(`select * from cron.${table} limit 1`));
        await denied(() => authenticated(fixture.requester.userId, `insert into cron.${table} default values`));
        await denied(() => anonymous(`insert into cron.${table} default values`));
      }
    }
  });

  it('catalogFunctions: exact signatures explicit role grants allowlist and pg_catalog-only paths expose no identity school or time arguments', async () => {
    const rows = await authenticated(fixture.requester.userId, `select p.proname as name,
      pg_catalog.oidvectortypes(p.proargtypes) as args, p.proargnames as arg_names,
      p.prorettype::regtype::text as result, p.prosecdef as security_definer,
      array(select s from unnest(p.proconfig) s where s like 'search_path=%') as path,
      exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
      exists (select 1 from pg_catalog.aclexplode(p.proacl) a join pg_catalog.pg_roles r on r.oid = a.grantee
        where r.rolname = 'authenticated' and a.privilege_type = 'EXECUTE') as explicit_auth,
      exists (select 1 from pg_catalog.aclexplode(p.proacl) a join pg_catalog.pg_roles r on r.oid = a.grantee
        where r.rolname = 'service_role' and a.privilege_type = 'EXECUTE') as explicit_service
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`, [handoverFunctions]);
    expect(rows).toHaveLength(7);
    const signatures: Record<string, [string, string]> = {
      confirm_pickup_done: ['uuid', 'jsonb'], confirm_child_arrived: ['uuid', 'jsonb'],
      refresh_my_handover_reminders: ['', 'integer'], enqueue_due_handover_reminders: ['', 'integer'],
      record_leg_confirmation: ['uuid, text', 'jsonb'], guard_handover_history: ['', 'trigger'],
      maybe_record_handover_reminder: ['uuid', 'integer'],
    };
    const exposed = ['confirm_pickup_done', 'confirm_child_arrived', 'refresh_my_handover_reminders'];
    for (const row of rows) {
      expect(row).toMatchObject({
        args: signatures[row.name][0], result: signatures[row.name][1], path: ['search_path=pg_catalog'],
        public_execute: false, anon_execute: false,
        auth_execute: exposed.includes(row.name), explicit_auth: exposed.includes(row.name),
      });
      if (exposed.includes(row.name) || row.name === 'enqueue_due_handover_reminders') expect(row.security_definer).toBe(true);
      if (row.name === 'enqueue_due_handover_reminders') {
        expect(row).toMatchObject({ service_execute: true, explicit_service: true });
      }
      if (row.name === 'confirm_pickup_done' || row.name === 'confirm_child_arrived') expect(row.arg_names).toEqual(['p_leg_id']);
    }
    const allowlist = JSON.parse(await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8')) as {
      authenticated: Array<{ name: string }>; internal: Array<{ name: string }>;
    };
    for (const name of handoverFunctions) {
      expect(allowlist.authenticated.some((entry) => entry.name === name)).toBe(exposed.includes(name));
    }
    for (const name of ['record_leg_confirmation', 'guard_handover_history', 'maybe_record_handover_reminder']) {
      expect(allowlist.internal.some((entry) => entry.name === name)).toBe(true);
    }
  });
});
