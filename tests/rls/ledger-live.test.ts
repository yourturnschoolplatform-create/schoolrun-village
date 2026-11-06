import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const ledgerColumns = [
  'id', 'school_id', 'from_membership', 'to_membership', 'swap_leg_id',
  'trip_count_delta', 'created_at', 'expires_at', 'reminder_due_at',
];

type Member = { userId: string; membershipId: string; schoolId: string };
type SwapFixture = {
  swapId: string;
  legId: string;
  reverseLegId: string;
  helperInstanceId: string;
  requesterInstanceId: string;
  completedAt: Date;
};
type LedgerEntry = {
  id: string;
  school_id: string;
  from_membership: string;
  to_membership: string;
  swap_leg_id: string;
  trip_count_delta: number;
  created_at: string;
  expires_at: string;
  reminder_due_at: string;
  is_expired: boolean;
};
type Partner = { partner_membership: string; trips_i_owe: number; trips_owed_to_me: number };
type Ledger = { entries: LedgerEntry[]; partners: Partner[] };
type Fixture = {
  schoolA: string;
  schoolB: string;
  declarationA: string;
  declarationB: string;
  requester: Member;
  provider: Member;
  thirdParty: Member;
  parentB: Member;
  moderatorB: Member;
  pending: Member;
  noMembershipUser: string;
  userIds: string[];
  now: Date;
};

/**
 * Independent of two-school.sql and its committed legacy IDs. Every connection
 * uses only SUPABASE_RLS_TEST_DATABASE_URL; no development URL or commit-capable
 * fixture helper is used. Fixture creation, assertions and expected failures all
 * live in one transaction per test. ROLLBACK is the only cleanup mechanism,
 * including when beforeEach fails partway through fixture setup.
 *
 * Completion below is explicitly a privileged fixture action, not a browser RPC
 * or an implementation of the later handover workflow. No credentials, claims,
 * connection strings, or auth records are logged or included in assertion diffs.
 */
describe('Task 5.1 live immutable membership-pair ledger', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Ledger live test connection is not initialized.');
    return client;
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^(fixture|read-back): [a-z0-9 ._-]+$/i.test(label)) {
      throw new Error('Privileged actions require a synthetic fixture/read-back label.');
    }
    // RESET ROLE is restricted to these explicitly labelled privileged actions.
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
    const name = `ledger_denial_${++savepointNumber}`;
    await db().query(`savepoint ${name}`);
    let code: string | null = null;
    try {
      await action();
    } catch (error) {
      // Compare SQLSTATE only: never report raw driver messages/details or SQL parameters.
      code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
    } finally {
      // Also rolls back an unexpectedly successful mutation before asserting failure.
      await db().query(`rollback to savepoint ${name}`);
      await db().query(`release savepoint ${name}`);
    }
    expect(expectedCodes).toContain(code);
  }

  async function ledger(userId: string): Promise<Ledger> {
    const rows = await authenticated<{ ledger: Ledger }>(userId,
      'select public.get_my_ledger() as ledger');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].ledger).sort()).toEqual(['entries', 'partners']);
    expect(Array.isArray(rows[0].ledger.entries)).toBe(true);
    expect(Array.isArray(rows[0].ledger.partners)).toBe(true);
    for (const partner of rows[0].ledger.partners) {
      expect(Object.keys(partner).sort()).toEqual([
        'partner_membership', 'trips_i_owe', 'trips_owed_to_me',
      ]);
      expect(Number.isInteger(partner.trips_i_owe)).toBe(true);
      expect(Number.isInteger(partner.trips_owed_to_me)).toBe(true);
      expect(partner.trips_i_owe).toBeGreaterThanOrEqual(0);
      expect(partner.trips_owed_to_me).toBeGreaterThanOrEqual(0);
    }
    return rows[0].ledger;
  }

  async function visibleLegIds(userId: string): Promise<string[]> {
    const rows = await authenticated<{ swap_leg_id: string }>(userId,
      'select swap_leg_id from public.swap_ledger_entries order by swap_leg_id');
    return rows.map((row) => row.swap_leg_id);
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
    const thirdParty = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const pending = member(schoolA);
    const noMembershipUser = randomUUID();
    const members = [requester, provider, thirdParty, parentB, moderatorB, pending];
    const userIds = [...members.map((m) => m.userId), noMembershipUser];
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Ledger School A', 'Australia/Sydney'),
             ($3, $4, 'Ledger School B', 'Australia/Melbourne')`,
    [schoolA, `ledger-a-${schoolA}`, schoolB, `ledger-b-${schoolB}`]);
    // Auth trigger creates synthetic profiles. No password/token is supplied.
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'ledger-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Ledger Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) as u(id)`, [userIds]);
    await db().query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, status::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
        as m(id, school_id, user_id, status)`, [
      members.map((m) => m.membershipId), members.map((m) => m.schoolId),
      members.map((m) => m.userId), members.map((m) => m === pending ? 'pending_moderator' : 'verified'),
    ]);
    await db().query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`,
    [randomUUID(), moderatorB.userId, schoolB]);
    // Existing global consent documents are READ ONLY; accept every active one
    // for our unique users. Do not publish/deactivate/update global documents.
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Ledger declaration A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Ledger declaration B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members.filter((m) => m !== pending)) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, declarationA, declarationB, requester, provider,
      thirdParty, parentB, moderatorB, pending, noMembershipUser, userIds, now: clock[0].now,
    };
  }

  async function createSwap(
    requester = fixture.requester,
    provider = fixture.provider,
    options: { completedAt?: Date; status?: 'accepted' | 'proposed' | 'declined' } = {},
  ): Promise<SwapFixture> {
    return privileged('fixture: create reciprocal source swap', async () => {
      const completedAt = options.completedAt ?? new Date(fixture.now.getTime() - 60 * 60 * 1_000);
      const proposedAt = new Date(completedAt.getTime() - 2 * DAY_MS);
      const acceptedAt = new Date(completedAt.getTime() - DAY_MS);
      const status = options.status ?? 'accepted';
      const swapId = randomUUID();
      const legId = randomUUID();
      const reverseLegId = randomUUID();
      const patternIds = Array.from({ length: 4 }, () => randomUUID());
      const instanceIds = Array.from({ length: 4 }, () => randomUUID());
      const owners = [provider.userId, requester.userId, requester.userId, provider.userId];
      const intents = ['can_help', 'need_help', 'can_help', 'need_help'];
      await db().query(`insert into public.availability_patterns
        (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
         area_label, capacity, starts_on, created_at)
        select id, $2::uuid, owner_id, intent::public.schedule_intent, 'pickup',
          extract(isodow from ($5::timestamptz at time zone 'Australia/Sydney'))::smallint,
          '15:00'::time, '15:30'::time, 'Carlton', 1,
          ($5::timestamptz at time zone 'Australia/Sydney')::date, $6
        from unnest($1::uuid[], $3::uuid[], $4::text[]) as p(id, owner_id, intent)`,
      [patternIds, requester.schoolId, owners, intents, completedAt, proposedAt]);
      await db().query(`insert into public.availability_instances
        (id, pattern_id, school_id, owner_id, service_date, intent, direction,
         window_start, window_end, area_label, capacity, created_at)
        select id, pattern_id, $3::uuid, owner_id,
          ($6::timestamptz at time zone 'Australia/Sydney')::date,
          intent::public.schedule_intent, 'pickup', '15:00'::time, '15:30'::time,
          'Carlton', 1, $7
        from unnest($1::uuid[], $2::uuid[], $4::uuid[], $5::text[])
          as i(id, pattern_id, owner_id, intent)`,
      [instanceIds, patternIds, requester.schoolId, owners, intents, completedAt, proposedAt]);
      await db().query(`insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, accepted_at, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        swapId, requester.schoolId, requester.userId, provider.userId, status,
        proposedAt, status === 'accepted' ? acceptedAt : null, completedAt,
      ]);
      await db().query(`insert into public.swap_legs
        (id, swap_id, school_id, helper_instance_id, requester_instance_id,
         helper_id, requester_id, service_date, created_at)
        values ($1, $3, $4, $5, $6, $9, $10,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12),
               ($2, $3, $4, $7, $8, $10, $9,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12)`, [
        legId, reverseLegId, swapId, requester.schoolId, ...instanceIds,
        provider.userId, requester.userId, completedAt, proposedAt,
      ]);
      return {
        swapId, legId, reverseLegId, completedAt,
        helperInstanceId: instanceIds[0], requesterInstanceId: instanceIds[1],
      };
    });
  }

  async function complete(swap: SwapFixture, legId = swap.legId): Promise<void> {
    await privileged('fixture: trusted completion outside handover scope', async () => {
      const result = await db().query(`update public.swap_legs set completed_at = $2
        where id = $1 returning id`, [legId, swap.completedAt]);
      expect(result.rowCount).toBe(1);
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for ledger live tests.');
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

  it('accepted legs without completed_at create no ledger entries', async () => {
    await createSwap();
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
    expect(await ledger(fixture.requester.userId)).toEqual({ entries: [], partners: [] });
    await privileged('read-back: no ledger posting before completion', async () => {
      const { rows } = await db().query(`select count(*)::int as count
        from public.swap_ledger_entries where school_id = $1`, [fixture.schoolA]);
      expect(rows).toEqual([{ count: 0 }]);
    });
  });

  it('trusted completion posts exactly once even after an unchanged completion update', async () => {
    const swap = await createSwap();
    await complete(swap);
    await complete(swap);
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([swap.legId]);
    await privileged('read-back: exactly one posting per completed leg', async () => {
      const { rows } = await db().query(`select count(*)::int as count
        from public.swap_ledger_entries where swap_leg_id = $1`, [swap.legId]);
      expect(rows).toEqual([{ count: 1 }]);
    });
  });

  it('records recipient membership as debtor and helper membership as provider for both participants', async () => {
    const swap = await createSwap();
    await complete(swap);
    for (const actor of [fixture.requester, fixture.provider]) {
      const result = await ledger(actor.userId);
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(Object.keys(entry).sort()).toEqual([...ledgerColumns, 'is_expired'].sort());
      expect(entry).toMatchObject({
        school_id: fixture.schoolA, from_membership: fixture.requester.membershipId,
        to_membership: fixture.provider.membershipId, swap_leg_id: swap.legId,
        trip_count_delta: 1, is_expired: false,
      });
      expect(new Date(entry.created_at).getTime()).toBe(swap.completedAt.getTime());
    }
    expect((await ledger(fixture.requester.userId)).partners).toEqual([{
      partner_membership: fixture.provider.membershipId, trips_i_owe: 1, trips_owed_to_me: 0,
    }]);
    expect((await ledger(fixture.provider.userId)).partners).toEqual([{
      partner_membership: fixture.requester.membershipId, trips_i_owe: 0, trips_owed_to_me: 1,
    }]);
  });

  it('denies participant UPDATE and DELETE and leaves the owned ledger entry unchanged', async () => {
    const swap = await createSwap();
    await complete(swap);
    for (const actor of [fixture.requester, fixture.provider]) {
      await denied(() => authenticated(actor.userId, `update public.swap_ledger_entries
        set trip_count_delta = 2 where swap_leg_id = $1 returning id`, [swap.legId]));
      await denied(() => authenticated(actor.userId, `delete from public.swap_ledger_entries
        where swap_leg_id = $1 returning id`, [swap.legId]));
    }
    await privileged('read-back: participant mutations made no change', async () => {
      const { rows } = await db().query(`select trip_count_delta from public.swap_ledger_entries
        where swap_leg_id = $1`, [swap.legId]);
      expect(rows).toEqual([{ trip_count_delta: 1 }]);
    });
  });

  it('denies authenticated INSERT and TRUNCATE rather than exposing raw ledger writes', async () => {
    const swap = await createSwap();
    await denied(() => authenticated(fixture.requester.userId, `insert into public.swap_ledger_entries
      (id, school_id, from_membership, to_membership, swap_leg_id,
       trip_count_delta, created_at, expires_at, reminder_due_at)
      values ($1, $2, $3, $4, $5, 1, $6, $6::timestamptz + interval '56 days',
        $6::timestamptz + interval '42 days')`, [
      randomUUID(), fixture.schoolA, fixture.requester.membershipId,
      fixture.provider.membershipId, swap.legId, swap.completedAt,
    ]));
    await denied(() => authenticated(fixture.requester.userId, 'truncate public.swap_ledger_entries'));
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
  });

  it('blocks a verified same-school third party from another membership pair directly and through the RPC', async () => {
    const swap = await createSwap();
    await complete(swap);
    expect(await visibleLegIds(fixture.thirdParty.userId)).toEqual([]);
    expect(await ledger(fixture.thirdParty.userId)).toEqual({ entries: [], partners: [] });
  });

  it.each(['parentB', 'moderatorB'] as const)(
    'blocks School B %s from School A rows and RPC data while allowing their own pair', async (key) => {
      const swapA = await createSwap();
      const swapB = await createSwap(fixture.parentB, fixture.moderatorB);
      await complete(swapA);
      await complete(swapB);
      const actor = fixture[key];
      expect(await visibleLegIds(actor.userId)).toEqual([swapB.legId]);
      const result = await ledger(actor.userId);
      expect(result.entries.map((e) => e.swap_leg_id)).toEqual([swapB.legId]);
      expect(result.entries.every((e) => e.school_id === fixture.schoolB)).toBe(true);
      expect(result.partners).toHaveLength(1);
      expect(result.partners[0].partner_membership).toBe(
        key === 'parentB' ? fixture.moderatorB.membershipId : fixture.parentB.membershipId,
      );
    },
  );

  it('blocks a pending nonparticipant and returns empty arrays for a caller with no membership', async () => {
    const swap = await createSwap();
    await complete(swap);
    for (const userId of [fixture.pending.userId, fixture.noMembershipUser]) {
      expect(await visibleLegIds(userId)).toEqual([]);
      expect(await ledger(userId)).toEqual({ entries: [], partners: [] });
    }
  });

  it.each(['pending_moderator', 'rejected', 'suspended'])(
    'hides an existing participant ledger when their membership becomes %s', async (status) => {
      const swap = await createSwap();
      await complete(swap);
      await privileged('fixture: revoke participant verified status', async () => {
        await db().query('update public.school_memberships set status = $2 where id = $1',
          [fixture.requester.membershipId, status]);
      });
      expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
      expect(await ledger(fixture.requester.userId)).toEqual({ entries: [], partners: [] });
    },
  );

  it('returns no ledger for a verified participant without current safety onboarding', async () => {
    const swap = await createSwap();
    await complete(swap);
    await privileged('fixture: make current safety onboarding incomplete', async () => {
      await db().query('delete from public.safety_declarations where membership_id = $1',
        [fixture.requester.membershipId]);
    });
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
    expect(await ledger(fixture.requester.userId)).toEqual({ entries: [], partners: [] });
  });

  it('retains nine-week history with dynamic is_expired but excludes it from active partner counts', async () => {
    const old = await createSwap(fixture.requester, fixture.provider, {
      completedAt: new Date(fixture.now.getTime() - 63 * DAY_MS),
    });
    const recent = await createSwap();
    await complete(old);
    await complete(recent);
    const result = await ledger(fixture.requester.userId);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((e) => e.swap_leg_id === old.legId)?.is_expired).toBe(true);
    expect(result.entries.find((e) => e.swap_leg_id === recent.legId)?.is_expired).toBe(false);
    expect(result.partners).toEqual([{
      partner_membership: fixture.provider.membershipId, trips_i_owe: 1, trips_owed_to_me: 0,
    }]);
  });

  it('uses exactly 42 and 56 elapsed UTC days for reminder and expiry in a non-UTC session', async () => {
    const swap = await createSwap(fixture.requester, fixture.provider, {
      // A fixed historical completion crosses Sydney daylight-saving onset.
      completedAt: new Date('2025-09-01T12:00:00.000Z'),
    });
    await privileged('fixture: non-utc completion session', async () => {
      await db().query("set local timezone = 'Australia/Sydney'");
    });
    await complete(swap);
    const result = await ledger(fixture.requester.userId);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(new Date(entry.created_at).getTime()).toBe(swap.completedAt.getTime());
    expect(new Date(entry.reminder_due_at).getTime()).toBe(swap.completedAt.getTime() + 42 * DAY_MS);
    expect(new Date(entry.expires_at).getTime()).toBe(swap.completedAt.getTime() + 56 * DAY_MS);
  });

  it('nets reverse trips only within the same pair without affecting a different partner', async () => {
    const pair = await createSwap();
    const otherPair = await createSwap(fixture.requester, fixture.thirdParty);
    await complete(pair);
    await complete(pair, pair.reverseLegId);
    await complete(otherPair);
    const result = await ledger(fixture.requester.userId);
    expect(result.entries).toHaveLength(3);
    const offset = result.partners.find((p) => p.partner_membership === fixture.provider.membershipId);
    if (offset) expect(offset).toEqual({
      partner_membership: fixture.provider.membershipId, trips_i_owe: 0, trips_owed_to_me: 0,
    });
    expect(result.partners.filter((p) => p.partner_membership !== fixture.provider.membershipId)).toEqual([{
      partner_membership: fixture.thirdParty.membershipId, trips_i_owe: 1, trips_owed_to_me: 0,
    }]);
    const provider = await ledger(fixture.provider.userId);
    expect(provider.entries).toHaveLength(2);
    expect(provider.partners.every((p) => p.partner_membership === fixture.requester.membershipId
      && p.trips_i_owe === 0 && p.trips_owed_to_me === 0)).toBe(true);
    expect((await ledger(fixture.thirdParty.userId)).partners).toEqual([{
      partner_membership: fixture.requester.membershipId, trips_i_owe: 0, trips_owed_to_me: 1,
    }]);
  });

  it('silently expires history without deleting or mutating rows, issuing audits, or changing scores', async () => {
    const swap = await createSwap(fixture.requester, fixture.provider, {
      completedAt: new Date(fixture.now.getTime() - 63 * DAY_MS),
    });
    await complete(swap);
    const snapshot = () => privileged('read-back: expiry side effect snapshot', async () => {
      const { rows } = await db().query(`select
        (select count(*)::int from public.audit_logs where school_id = any($1::uuid[])
          or actor_id = any($2::uuid[])) as audit_count,
        (select jsonb_object_agg(id::text, jsonb_build_array(trust_score, updated_at))
          from public.profiles where id = any($2::uuid[])) as scores,
        (select to_jsonb(l) from public.swap_ledger_entries l where swap_leg_id = $3) as entry`,
      [[fixture.schoolA, fixture.schoolB], fixture.userIds, swap.legId]);
      return rows[0];
    });
    const before = await snapshot();
    expect(before.entry).not.toBeNull();
    for (const actor of [fixture.requester, fixture.provider, fixture.requester]) {
      const result = await ledger(actor.userId);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].is_expired).toBe(true);
      expect(result.partners).toEqual([]);
    }
    const after = await snapshot();
    expect(after.audit_count).toBe(before.audit_count);
    expect(after.scores).toEqual(before.scores);
    expect(after.entry).toEqual(before.entry);
  });

  it('selects the oldest fully onboarded verified school and skips an older ineligible school', async () => {
    const secondMembership: Member = {
      userId: fixture.requester.userId, membershipId: randomUUID(), schoolId: fixture.schoolB,
    };
    await privileged('fixture: second verified onboarded school membership', async () => {
      await db().query(`insert into public.school_memberships
        (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
         self_declaration_accepted_at, approved_by, approved_at, created_at)
        values ($1, $2, $3, 'verified', now(), now(), now(), $3, now(), now() - interval '5 days')`,
      [secondMembership.membershipId, secondMembership.schoolId, secondMembership.userId]);
      await signMembership(secondMembership, fixture.declarationB);
    });
    const first = await createSwap();
    const second = await createSwap(secondMembership, fixture.parentB);
    await complete(first);
    await complete(second);
    expect((await ledger(fixture.requester.userId)).entries.map((e) => e.swap_leg_id)).toEqual([first.legId]);
    await privileged('fixture: older school onboarding no longer complete', async () => {
      await db().query('delete from public.safety_declarations where membership_id = $1',
        [fixture.requester.membershipId]);
    });
    expect((await ledger(fixture.requester.userId)).entries.map((e) => e.swap_leg_id)).toEqual([second.legId]);
  });

  it('guard rejects privileged UPDATE DELETE and TRUNCATE with 55000 despite existing grants', async () => {
    const swap = await createSwap();
    await complete(swap);
    await privileged('read-back: append-only guard with privileged grants intact', async () => {
      const { rows } = await db().query(`select
        has_table_privilege(current_user, 'public.swap_ledger_entries', 'UPDATE') as can_update,
        has_table_privilege(current_user, 'public.swap_ledger_entries', 'DELETE') as can_delete,
        has_table_privilege(current_user, 'public.swap_ledger_entries', 'TRUNCATE') as can_truncate`);
      expect(rows).toEqual([{ can_update: true, can_delete: true, can_truncate: true }]);
      await denied(() => db().query(`update public.swap_ledger_entries set trip_count_delta = 1
        where swap_leg_id = $1`, [swap.legId]), ['55000']);
      await denied(() => db().query('delete from public.swap_ledger_entries where swap_leg_id = $1',
        [swap.legId]), ['55000']);
      await denied(() => db().query('truncate public.swap_ledger_entries'), ['55000']);
      const remaining = await db().query(`select count(*)::int as count from public.swap_ledger_entries
        where swap_leg_id = $1`, [swap.legId]);
      expect(remaining.rows).toEqual([{ count: 1 }]);
    });
  });

  it('rejects a malformed cross-school or unrelated membership pair before uniqueness can mask validation', async () => {
    const swap = await createSwap();
    await complete(swap);
    await privileged('fixture: rejected malformed ledger inserts', async () => {
      for (const [from, to] of [
        [fixture.parentB.membershipId, fixture.provider.membershipId],
        [fixture.requester.membershipId, fixture.moderatorB.membershipId],
        [fixture.requester.membershipId, fixture.thirdParty.membershipId],
        [fixture.provider.membershipId, fixture.requester.membershipId],
      ]) {
        // The existing swap_leg_id would give 23505 if the BEFORE INSERT guard
        // merely trusted arbitrary membership IDs. Require validation instead.
        await denied(() => db().query(`insert into public.swap_ledger_entries
          (id, school_id, from_membership, to_membership, swap_leg_id,
           trip_count_delta, created_at, expires_at, reminder_due_at)
          values ($1, $2, $3, $4, $5, 1, $6,
            $6::timestamptz + interval '56 days', $6::timestamptz + interval '42 days')`, [
          randomUUID(), fixture.schoolA, from, to, swap.legId, swap.completedAt,
        ]), ['55000', '23514']);
      }
    });
  });

  it.each(['proposed', 'declined'] as const)(
    'does not allow a completion to post a ledger entry from a %s proposal', async (status) => {
      const swap = await createSwap(fixture.requester, fixture.provider, { status });
      await privileged('fixture: rejected completion of non-accepted proposal', async () => {
        await denied(() => db().query('update public.swap_legs set completed_at = $2 where id = $1',
          [swap.legId, swap.completedAt]), ['55000', '23514', '42501']);
      });
      expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
    },
  );

  it('preserves completed source completion and identity even against privileged SQL', async () => {
    const swap = await createSwap();
    const other = await createSwap(fixture.requester, fixture.thirdParty);
    await complete(swap);
    const changes: Array<[string, unknown[], string[]?]> = [
      ['completed_at = null', []],
      ["completed_at = completed_at + interval '1 second'", []],
      // Referenced keys may hit the nondeferrable ledger FK before the AFTER
      // completion trigger. Either rejection preserves source identity.
      ['id = $2', [randomUUID()], ['55000', '23503']],
      ['swap_id = $2', [other.swapId]],
      ['school_id = $2', [fixture.schoolB], ['55000', '23503']],
      ['helper_id = $2', [fixture.thirdParty.userId]],
      ['requester_id = $2', [fixture.thirdParty.userId]],
      ['helper_instance_id = $2', [other.helperInstanceId]],
      ['requester_instance_id = $2', [other.requesterInstanceId]],
      ['service_date = service_date + 1', []],
    ];
    await privileged('fixture: rejected completed source rewrites', async () => {
      for (const [assignment, values, codes] of changes) {
        await denied(() => db().query(`update public.swap_legs set ${assignment} where id = $1`,
          [swap.legId, ...values]), codes ?? ['55000']);
      }
    });
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([swap.legId]);
  });

  it('denies participant and cross-school client completion writes and authenticated trigger calls', async () => {
    const swap = await createSwap();
    for (const actor of [fixture.requester, fixture.provider, fixture.parentB, fixture.moderatorB]) {
      await denied(() => authenticated(actor.userId,
        'update public.swap_legs set completed_at = $2 where id = $1 returning id',
        [swap.legId, swap.completedAt]));
    }
    for (const name of ['record_completed_swap_leg', 'guard_swap_ledger_entry']) {
      await denied(() => authenticated(fixture.requester.userId, `select public.${name}()`));
    }
    expect(await visibleLegIds(fixture.requester.userId)).toEqual([]);
    await privileged('read-back: browser never set trusted completion', async () => {
      const { rows } = await db().query('select completed_at is null as untouched from public.swap_legs where id = $1',
        [swap.legId]);
      expect(rows).toEqual([{ untouched: true }]);
    });
  });

  it('catalogue confirms SELECT-only RLS, one entry per leg, +1 counts and no monetary public columns', async () => {
    // pg_catalog rather than information_schema: inspect ALL public columns,
    // including tables the authenticated role cannot read.
    const columns = await authenticated<{ table_name: string; column_name: string }>(fixture.requester.userId,
      `select c.relname as table_name, a.attname as column_name
       from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and a.attnum > 0 and not a.attisdropped order by c.relname, a.attname`);
    expect(columns.length).toBeGreaterThan(0);
    const monetary = /(?:amount|price|currency|money|monetary|payment|cash|(?:^|_)(?:balances?|cents?|dollars?|fees?)(?:_|$))/i;
    expect(columns.filter((c) => monetary.test(c.column_name))).toEqual([]);
    expect(columns.filter((c) => c.table_name === 'swap_ledger_entries').map((c) => c.column_name).sort())
      .toEqual([...ledgerColumns].sort());
    const rows = await authenticated(fixture.requester.userId, `select c.relrowsecurity as rls,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
      has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_write,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
      exists (select 1 from pg_catalog.pg_constraint x where x.conrelid = c.oid and x.contype = 'u'
        and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(x.conkey) with ordinality k(attnum, ordinality)
          join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum)
          = array['swap_leg_id']::text[]) as unique_leg,
      exists (select 1 from pg_catalog.pg_constraint x where x.conrelid = c.oid and x.contype = 'c'
        and pg_catalog.pg_get_constraintdef(x.oid) ~ 'trip_count_delta[[:space:]]*=[[:space:]]*1') as only_plus_one
      from pg_catalog.pg_class c where c.oid = 'public.swap_ledger_entries'::regclass`);
    expect(rows).toEqual([{
      rls: true, auth_select: true, auth_write: false, anon_access: false, unique_leg: true, only_plus_one: true,
    }]);
  });

  it('restricts RPC execution to its allowlist and all three function search paths to pg_catalog only', async () => {
    const rows = await authenticated<{
      name: string; arguments: number; result: string; path: string[];
      public_execute: boolean; anon_execute: boolean; auth_execute: boolean;
    }>(fixture.requester.userId, `select p.proname as name, p.pronargs as arguments,
      p.prorettype::regtype::text as result,
      array(select s from unnest(p.proconfig) s where s like 'search_path=%') as path,
      exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`,
    [['get_my_ledger', 'guard_swap_ledger_entry', 'record_completed_swap_leg']]);
    expect(rows).toEqual([
      { name: 'get_my_ledger', arguments: 0, result: 'jsonb', path: ['search_path=pg_catalog'],
        public_execute: false, anon_execute: false, auth_execute: true },
      { name: 'guard_swap_ledger_entry', arguments: 0, result: 'trigger', path: ['search_path=pg_catalog'],
        public_execute: false, anon_execute: false, auth_execute: false },
      { name: 'record_completed_swap_leg', arguments: 0, result: 'trigger', path: ['search_path=pg_catalog'],
        public_execute: false, anon_execute: false, auth_execute: false },
    ]);
    const allowlist = JSON.parse(
      await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8'),
    ) as { authenticated: Array<{ name: string }> };
    expect(allowlist.authenticated.some((entry) => entry.name === 'get_my_ledger')).toBe(true);
    expect(allowlist.authenticated.some((entry) => ['record_completed_swap_leg', 'guard_swap_ledger_entry'].includes(entry.name)))
      .toBe(false);
    const completionRPCs = await authenticated<{ proname: string; body: string; arguments: number; path: string[] }>(fixture.requester.userId, `select p.proname,p.prosrc as body,p.pronargs as arguments,
        array(select s from unnest(p.proconfig) s where s like 'search_path=%') as path
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname ~ '(complet|handover)'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by p.proname`);
    // Task 5.3 authorises reminder-only refresh, not a raw completion command.
    // Keep the exact allowlist, zero-argument/path checks and no-completion-DML
    // assertion instead of silently dropping this foundation protection.
    expect(completionRPCs.map((row) => row.proname)).toEqual(['refresh_my_handover_reminders']);
    expect(completionRPCs[0].arguments).toBe(0);
    expect(completionRPCs[0].path).toEqual(['search_path=pg_catalog']);
    expect(completionRPCs[0].body).not.toMatch(/(?:update|insert\s+into|delete\s+from)\s+public\.swap_legs/i);
    expect(allowlist.authenticated.some((entry) => entry.name === 'refresh_my_handover_reminders')).toBe(true);
    await denied(() => authenticated(fixture.requester.userId,
      'select public.get_my_ledger($1::uuid)', [fixture.parentB.userId]), ['42883']);
  });

  it('denies actual anon execution of the ledger RPC and both trigger functions', async () => {
    await db().query('set local role anon; set local row_security = on');
    await db().query(`select set_config('request.jwt.claims', '{"role":"anon"}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`);
    const identity = await db().query(`select current_user::text as role,
      current_setting('row_security') as row_security, rolsuper, rolbypassrls
      from pg_catalog.pg_roles where rolname = current_user`);
    expect(identity.rows).toEqual([{ role: 'anon', row_security: 'on', rolsuper: false, rolbypassrls: false }]);
    for (const name of ['get_my_ledger', 'record_completed_swap_leg', 'guard_swap_ledger_entry']) {
      await denied(() => db().query(`select public.${name}()`));
    }
  });
});
