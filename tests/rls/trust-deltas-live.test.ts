/**
 * Task 6.2 live suite: policy-driven trust deltas from completion, cancellations,
 * and urgent cover. Authenticated role + synthetic JWT; ROLLBACK cleanup.
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
  declarationA: string;
  declarationB: string;
  requester: Member;
  provider: Member;
  parentB: Member;
  moderatorB: Member;
  pendingA: Member;
  noMembershipUser: string;
  now: Date;
};

describe('Task 6.2 live trust policy deltas', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Trust deltas live test connection is not initialised.');
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
    const name = `trust_delta_denial_${++savepointNumber}`;
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
    const pendingA = member(schoolA);
    const noMembershipUser = randomUUID();
    const members = [requester, provider, parentB, moderatorB, pendingA];
    const userIds = [...members.map((m) => m.userId), noMembershipUser];
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Trust Delta School A', 'Australia/Sydney'),
             ($3, $4, 'Trust Delta School B', 'Australia/Melbourne')`,
    [schoolA, `trust-d-a-${schoolA}`, schoolB, `trust-d-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'trust-delta-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Trust Delta Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) as u(id)`, [userIds]);
    await db().query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, status::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
        as m(id, school_id, user_id, status)`, [
      members.map((m) => m.membershipId), members.map((m) => m.schoolId),
      members.map((m) => m.userId),
      members.map((m) => m === pendingA ? 'pending_moderator' : 'verified'),
    ]);
    await db().query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`,
    [randomUUID(), moderatorB.userId, schoolB]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Trust delta A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Trust delta B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members.filter((row) => row !== pendingA)) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, declarationA, declarationB, requester, provider, parentB,
      moderatorB, pendingA, noMembershipUser, now: clock[0].now,
    };
  }

  async function score(userId: string): Promise<number> {
    const rows = await authenticated<{ trust: { trust_score: number } }>(
      userId, 'select public.get_my_trust() as trust',
    );
    return rows[0].trust.trust_score;
  }

  async function events(userId: string): Promise<Array<{
    reason_code: string; delta: number; source_entity_type: string;
  }>> {
    return authenticated(userId,
      `select reason_code, delta, source_entity_type from public.trust_score_events
       where subject_user_id = $1 order by created_at, id`, [userId]);
  }

  type SwapBits = {
    swapId: string; legId: string; reverseLegId: string;
    helperInstanceId: string; requesterInstanceId: string;
    serviceAt: Date; acceptedAt: Date;
  };

  async function createAcceptedSwap(options: {
    serviceAt: Date; acceptedAt: Date;
  }): Promise<SwapBits> {
    return privileged('fixture: create accepted reciprocal swap', async () => {
      const { serviceAt, acceptedAt } = options;
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

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for trust delta live tests.');
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

  it('completedTripPostsOnce: trusted completion applies published +1 to helper only and is idempotent', async () => {
    const beforeProvider = await score(fixture.provider.userId);
    const beforeRequester = await score(fixture.requester.userId);
    const serviceAt = new Date(fixture.now.getTime() - HOUR_MS);
    const swap = await createAcceptedSwap({
      serviceAt, acceptedAt: new Date(serviceAt.getTime() - DAY_MS),
    });
    await privileged('fixture: complete accepted swap leg', async () => {
      const result = await db().query(
        `update public.swap_legs set completed_at = $2 where id = $1 returning id`,
        [swap.legId, serviceAt],
      );
      expect(result.rowCount).toBe(1);
      const again = await db().query(
        `update public.swap_legs set completed_at = $2 where id = $1 returning id`,
        [swap.legId, serviceAt],
      );
      expect(again.rowCount).toBe(1);
    });
    expect(await score(fixture.provider.userId)).toBe(beforeProvider + 1);
    expect(await score(fixture.requester.userId)).toBe(beforeRequester);
    const mine = await events(fixture.provider.userId);
    expect(mine.filter((row) => row.reason_code === 'completed_trip')).toHaveLength(1);
    expect(mine.find((row) => row.reason_code === 'completed_trip')).toMatchObject({
      delta: 1, source_entity_type: 'swap_leg',
    });
  });

  it('scheduleCancelUnderWindows: under 2h and under 24h post policy deltas; far cancels do not', async () => {
    const under2h = new Date(fixture.now.getTime() + 90 * 60 * 1000);
    const under24h = new Date(fixture.now.getTime() + 6 * HOUR_MS);
    const far = new Date(fixture.now.getTime() + 3 * DAY_MS);
    const before = await score(fixture.requester.userId);

    async function cancelOpen(serviceAt: Date): Promise<string> {
      return privileged('fixture: open instance then cancel', async () => {
        const patternId = randomUUID();
        const instanceId = randomUUID();
        await db().query(`insert into public.availability_patterns
          (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
           area_label, capacity, starts_on)
          values ($1, $2, $3, 'can_help', 'pickup',
            extract(isodow from ($4::timestamptz at time zone 'Australia/Sydney'))::smallint,
            ($4::timestamptz at time zone 'Australia/Sydney')::time,
            (($4::timestamptz at time zone 'Australia/Sydney') + interval '30 minutes')::time,
            'Carlton', 1,
            ($4::timestamptz at time zone 'Australia/Sydney')::date)`,
        [patternId, fixture.schoolA, fixture.requester.userId, serviceAt]);
        await db().query(`insert into public.availability_instances
          (id, pattern_id, school_id, owner_id, service_date, intent, direction,
           window_start, window_end, area_label, capacity, status)
          values ($1, $2, $3, $4,
            ($5::timestamptz at time zone 'Australia/Sydney')::date,
            'can_help', 'pickup',
            ($5::timestamptz at time zone 'Australia/Sydney')::time,
            (($5::timestamptz at time zone 'Australia/Sydney') + interval '30 minutes')::time,
            'Carlton', 1, 'open')`,
        [instanceId, patternId, fixture.schoolA, fixture.requester.userId, serviceAt]);
        return instanceId;
      });
    }

    const id2 = await cancelOpen(under2h);
    const id24 = await cancelOpen(under24h);
    const idFar = await cancelOpen(far);

    await authenticated(fixture.requester.userId,
      'select public.cancel_availability_instance($1::uuid)', [id2]);
    await authenticated(fixture.requester.userId,
      'select public.cancel_availability_instance($1::uuid)', [id24]);
    await authenticated(fixture.requester.userId,
      'select public.cancel_availability_instance($1::uuid)', [idFar]);

    expect(await score(fixture.requester.userId)).toBe(before - 8 - 3);
    const mine = await events(fixture.requester.userId);
    expect(mine.map((row) => row.reason_code).sort()).toEqual([
      'cancel_under_24h', 'cancel_under_2h',
    ]);
    expect(mine.every((row) => row.source_entity_type === 'schedule_cancellation_event')).toBe(true);
  });

  it('urgentCoverOnAccept: posts +3 within four hours and skips confirmed household pairs', async () => {
    const before = await score(fixture.provider.userId);
    const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
    const swap = await privileged('fixture: proposed urgent reciprocal swap', async () => {
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
      return { swapId, legId, reverseLegId };
    });

    const status = await authenticated<{ transition_swap_proposal: string }>(
      fixture.provider.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text) as transition_swap_proposal',
      [swap.swapId, 'accept'],
    );
    expect(status[0].transition_swap_proposal).toBe('accepted');
    expect(await score(fixture.provider.userId)).toBeGreaterThanOrEqual(before + 3);
    const providerEvents = await events(fixture.provider.userId);
    expect(providerEvents.some((row) => row.reason_code === 'urgent_cover' && row.delta === 3)).toBe(true);

    await privileged('fixture: confirm household link', async () => {
      await db().query(`insert into public.household_links
        (id, school_id, first_parent_id, second_parent_id, requested_by,
         requester_confirmed_at, other_parent_confirmed_at, status)
        values ($1, $2, $3, $4, $3, now(), now(), 'confirmed')`,
      [randomUUID(), fixture.schoolA, fixture.requester.userId, fixture.provider.userId]);
    });
    const blockedBefore = await score(fixture.provider.userId);
    const householdSwap = await privileged('fixture: household urgent proposed swap', async () => {
      const proposedAt = fixture.now;
      const service = new Date(fixture.now.getTime() + HOUR_MS);
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
      [patternIds, fixture.schoolA, owners, intents, service, proposedAt]);
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
      [instanceIds, patternIds, fixture.schoolA, owners, intents, service, proposedAt]);
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
        fixture.provider.userId, fixture.requester.userId, service, proposedAt,
      ]);
      return { swapId };
    });
    const householdStatus = await authenticated<{ transition_swap_proposal: string }>(
      fixture.provider.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text) as transition_swap_proposal',
      [householdSwap.swapId, 'accept'],
    );
    expect(householdStatus[0].transition_swap_proposal).toBe('accepted');
    expect(await score(fixture.provider.userId)).toBe(blockedBefore);
    const afterHousehold = await events(fixture.provider.userId);
    expect(afterHousehold.filter((row) => row.reason_code === 'urgent_cover')).toHaveLength(
      providerEvents.filter((row) => row.reason_code === 'urgent_cover').length,
    );
  });

  it('swapConsentCancelPostsWindowPenalty: consent revoke under 24h posts cancel delta once', async () => {
    const serviceAt = new Date(fixture.now.getTime() + 3 * HOUR_MS);
    const swap = await createAcceptedSwap({
      serviceAt, acceptedAt: new Date(fixture.now.getTime() - HOUR_MS),
    });
    await privileged('fixture: seed contact consent for revoke', async () => {
      await db().query(`insert into public.contact_consents
        (id, school_id, swap_id, member, consent_version, policy_version, scope, granted_at)
        values ($1, $2, $3, $4, 1, 1, 'swap_partner_and_chosen_backups', now())`,
      [randomUUID(), fixture.schoolA, swap.swapId, fixture.requester.membershipId]);
    });
    const before = await score(fixture.requester.userId);
    await authenticated(fixture.requester.userId,
      'select public.revoke_contact_sharing($1::uuid)', [swap.swapId]);
    expect(await score(fixture.requester.userId)).toBe(before - 3);
    const mine = await events(fixture.requester.userId);
    expect(mine.filter((row) => row.source_entity_type === 'swap_cancellation_event')).toEqual([
      expect.objectContaining({ reason_code: 'cancel_under_24h', delta: -3 }),
    ]);
  });

  it('crossSchoolAndClientWritesDenied: School B cannot read School A events; clients cannot apply deltas', async () => {
    const serviceAt = new Date(fixture.now.getTime() - HOUR_MS);
    const swap = await createAcceptedSwap({
      serviceAt, acceptedAt: new Date(serviceAt.getTime() - DAY_MS),
    });
    await privileged('fixture: complete for cross-school denial', async () => {
      await db().query(`update public.swap_legs set completed_at = $2 where id = $1`,
        [swap.legId, serviceAt]);
    });
    const own = await events(fixture.provider.userId);
    expect(own.length).toBeGreaterThan(0);
    const cross = await authenticated<{ id: string }>(fixture.parentB.userId,
      `select id from public.trust_score_events where subject_user_id = $1`,
      [fixture.provider.userId]);
    expect(cross).toEqual([]);
    const moderatorCross = await authenticated<{ id: string }>(fixture.moderatorB.userId,
      `select id from public.trust_score_events`);
    expect(moderatorCross).toEqual([]);
    await denied(() => authenticated(fixture.provider.userId,
      `select public.apply_trust_score_delta($1::uuid, $2::uuid, 1::smallint,
        'completed_trip'::text, 'browser'::text, $3::uuid)`,
      [fixture.provider.userId, fixture.schoolA, randomUUID()]));
    await denied(() => authenticated(fixture.provider.userId,
      `select public.trust_policy_delta($1::uuid, 'completed_trip')`, [fixture.schoolA]));
    await denied(() => authenticated(fixture.noMembershipUser,
      `select public.post_trust_urgent_cover_for_swap($1::uuid)`, [swap.swapId]));
  });

  it('allowlistInternalOnly: Task 6.2 helpers are internal with pg_catalog search_path', async () => {
    const allowlist = JSON.parse(
      await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8'),
    ) as { authenticated: Array<{ name: string }>; internal: Array<{ name: string }> };
    const authNames = allowlist.authenticated.map((entry) => entry.name);
    const internalNames = allowlist.internal.map((entry) => entry.name);
    for (const name of [
      'trust_published_policy', 'trust_policy_delta', 'trust_hours_until_instance',
      'trust_cancel_reason_for_hours', 'post_trust_completed_trip',
      'post_trust_schedule_cancellation', 'post_trust_swap_cancellation',
      'post_trust_urgent_cover_for_swap',
    ]) {
      expect(authNames).not.toContain(name);
      expect(internalNames).toContain(name);
    }
    const rows = await privileged('read-back: trust delta function paths', async () => {
      return (await db().query<{ proname: string; search_path: string | null; auth_exec: boolean }>(`
        select p.proname,
          (select substr(setting, 13) from pg_catalog.unnest(p.proconfig) setting
           where setting like 'search_path=%' limit 1) as search_path,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'trust_published_policy', 'trust_policy_delta', 'trust_hours_until_instance',
          'trust_cancel_reason_for_hours', 'post_trust_completed_trip',
          'post_trust_schedule_cancellation', 'post_trust_swap_cancellation',
          'post_trust_urgent_cover_for_swap'
        )
      `)).rows;
    });
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.search_path).toBe('pg_catalog');
      expect(row.auth_exec).toBe(false);
    }
  });
});
