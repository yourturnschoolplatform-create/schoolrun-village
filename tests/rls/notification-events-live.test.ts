/**
 * Task 10.2 live suite: handover / swap / trust system events enqueue owner
 * notifications. Authenticated + synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  requester: Member;
  provider: Member;
  moderatorA: Member;
  parentB: Member;
  now: Date;
};
type Notification = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, string>;
};

describe('Task 10.2 live system event notifications', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Notification-events live test connection is not initialised.');
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
    const name = `notification_events_denial_${++savepointNumber}`;
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

  async function inbox(userId: string): Promise<Notification[]> {
    const rows = await authenticated<{ list_my_notifications: Notification[] }>(
      userId, 'select public.list_my_notifications(false) as list_my_notifications',
    );
    return rows[0].list_my_notifications;
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
    const members = [requester, provider, moderatorA, parentB];
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Notify Events School A', 'Australia/Sydney'),
             ($3, $4, 'Notify Events School B', 'Australia/Melbourne')`,
    [schoolA, `nev-a-${schoolA}`, schoolB, `nev-b-${schoolB}`]);
    await db().query(`insert into public.school_configs (school_id) values ($1), ($2)`,
      [schoolA, schoolB]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'nev-' || id::text || '@example.invalid', now(),
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
    [randomUUID(), moderatorA.userId, schoolA]);
    await db().query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) as u(id)
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Notify Events A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Notify Events B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return { schoolA, schoolB, requester, provider, moderatorA, parentB, now: clock[0].now };
  }

  async function createAcceptedLeg(): Promise<{ swapId: string; legId: string }> {
    return privileged('fixture: accepted swap leg for notifications', async () => {
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

  async function createProposedSwap(): Promise<string> {
    return privileged('fixture: proposed swap for transition notify', async () => {
      const serviceAt = new Date(fixture.now.getTime() + 2 * HOUR_MS);
      const proposedAt = fixture.now;
      const swapId = randomUUID();
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
        (swap_id, school_id, helper_instance_id, requester_instance_id,
         helper_id, requester_id, service_date, created_at)
        values ($1, $2, $3, $4, $7, $8, ($9::timestamptz at time zone 'Australia/Sydney')::date, $10),
               ($1, $2, $5, $6, $8, $7, ($9::timestamptz at time zone 'Australia/Sydney')::date, $10)`, [
        swapId, fixture.schoolA, ...instanceIds,
        fixture.provider.userId, fixture.requester.userId, serviceAt, proposedAt,
      ]);
      return swapId;
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for notification-events live tests.');
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
    fixture = await privileged('fixture: unique two-school notification events onboarding', seed);
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

  it('handoverConfirmAndComplete: partner gets update then both get completed', async () => {
    const { legId } = await createAcceptedLeg();

    await authenticated(fixture.provider.userId,
      'select public.confirm_pickup_done($1::uuid)', [legId]);
    const afterPickup = await inbox(fixture.requester.userId);
    expect(afterPickup.some((n) => n.kind === 'handover_update'
      && n.metadata.reason_code === 'pickup_done'
      && n.metadata.entity_id === legId)).toBe(true);
    expect(JSON.stringify(afterPickup)).not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);

    await authenticated(fixture.requester.userId,
      'select public.confirm_child_arrived($1::uuid)', [legId]);
    const requesterInbox = await inbox(fixture.requester.userId);
    const providerInbox = await inbox(fixture.provider.userId);
    expect(requesterInbox.some((n) => n.kind === 'handover_completed'
      && n.metadata.reason_code === 'leg_completed')).toBe(true);
    expect(providerInbox.some((n) => n.kind === 'handover_completed'
      && n.metadata.reason_code === 'leg_completed')).toBe(true);
    expect(providerInbox.some((n) => n.kind === 'handover_update'
      && n.metadata.reason_code === 'child_arrived')).toBe(true);

    const foreign = await inbox(fixture.parentB.userId);
    expect(foreign).toEqual([]);
  });

  it('swapAcceptDeclineWithdraw: counterparty receives status notifications', async () => {
    const acceptId = await createProposedSwap();
    await authenticated(fixture.provider.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text)', [acceptId, 'accept']);
    const afterAccept = await inbox(fixture.requester.userId);
    expect(afterAccept.some((n) => n.kind === 'swap_accepted'
      && n.metadata.entity_id === acceptId)).toBe(true);

    const declineId = await createProposedSwap();
    await authenticated(fixture.provider.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text)', [declineId, 'decline']);
    const afterDecline = await inbox(fixture.requester.userId);
    expect(afterDecline.some((n) => n.kind === 'swap_declined'
      && n.metadata.entity_id === declineId)).toBe(true);

    const withdrawId = await createProposedSwap();
    await authenticated(fixture.requester.userId,
      'select public.transition_swap_proposal($1::uuid, $2::text)', [withdrawId, 'withdraw']);
    const afterWithdraw = await inbox(fixture.provider.userId);
    expect(afterWithdraw.some((n) => n.kind === 'swap_withdrawn'
      && n.metadata.entity_id === withdrawId)).toBe(true);
  });

  it('safetyHoldAndTrustDelta: subject notified without numeric scores', async () => {
    const hold = await authenticated<{ place_safety_hold: string }>(
      fixture.moderatorA.userId,
      'select public.place_safety_hold($1::uuid) as place_safety_hold',
      [fixture.provider.userId],
    );
    const afterPlace = await inbox(fixture.provider.userId);
    expect(afterPlace.some((n) => n.kind === 'safety_hold'
      && n.metadata.reason_code === 'safety_hold_placed'
      && n.metadata.entity_id === hold[0].place_safety_hold)).toBe(true);

    await authenticated(fixture.moderatorA.userId,
      'select public.resolve_safety_hold($1::uuid, $2::text)',
      [hold[0].place_safety_hold, 'lift']);
    const afterLift = await inbox(fixture.provider.userId);
    expect(afterLift.some((n) => n.kind === 'safety_hold'
      && n.metadata.reason_code === 'safety_hold_resolved'
      && n.metadata.outcome === 'lifted')).toBe(true);

    const sourceId = randomUUID();
    await privileged('fixture: apply trust delta for notify', async () => {
      await db().query(
        `select public.apply_trust_score_delta($1::uuid, $2::uuid, 1::smallint,
           'completed_trip', 'swap_leg', $3::uuid)`,
        [fixture.requester.userId, fixture.schoolA, sourceId],
      );
    });
    const trustInbox = await inbox(fixture.requester.userId);
    const trustNote = trustInbox.find((n) => n.kind === 'trust_update'
      && n.metadata.entity_id === sourceId);
    expect(trustNote).toBeTruthy();
    expect(`${trustNote?.title} ${trustNote?.body}`).not.toMatch(/\d/);
    expect(JSON.stringify(trustNote)).not.toMatch(/\b(amount|currency|payment|phone|photo|nickname)\b/i);
  });

  it('catalogTriggersAndInternalOnly: handover triggers and helpers are not client-executable', async () => {
    const catalog = await privileged('read-back: notification event catalog', async () => {
      const grants = await db().query<{ name: string; path: string; auth_exec: boolean }>(
        `select p.proname as name, p.proconfig::text as path,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in (
             'notify_user_event_once', 'notify_handover_confirmation',
             'notify_handover_completion', 'enqueue_user_notification'
           )
         order by p.proname`);
      const kinds = await db().query<{ definition: string }>(
        `select pg_catalog.pg_get_constraintdef(c.oid) as definition
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class rel on rel.oid = c.conrelid
         join pg_catalog.pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public' and rel.relname = 'notifications'
           and c.conname = 'notifications_kind_check'`);
      return { grants: grants.rows, kinds: kinds.rows[0]?.definition ?? '' };
    });

    expect(catalog.grants.every((g) => g.auth_exec === false)).toBe(true);
    for (const row of catalog.grants) {
      expect(row.path).toMatch(/search_path=pg_catalog/);
      expect(row.path).not.toMatch(/search_path=pg_catalog, public/);
    }
    expect(catalog.kinds).toMatch(/handover_completed/);
    expect(catalog.kinds).toMatch(/swap_proposed/);
    expect(catalog.kinds).toMatch(/trust_update/);

    await denied(() => authenticated(fixture.requester.userId,
      `select public.notify_user_event_once($1::uuid, $2::uuid, 'system', 'T', 'B',
         'swap_leg', $3::uuid, 'x', null, 'test')`,
      [fixture.requester.userId, fixture.schoolA, randomUUID()]));
  });
});
