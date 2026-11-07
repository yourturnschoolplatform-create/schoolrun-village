/**
 * Task 8.3 live suite: handover reminder delivery via email-relay queue after
 * live eligibility recheck. Authenticated cannot claim/send/enqueue handover
 * reminders. Cross-school isolation included. Authenticated + synthetic JWT;
 * ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;
const MINUTE_MS = 60_000;

type Member = { userId: string; membershipId: string; schoolId: string; email: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  requester: Member;
  provider: Member;
  parentB: Member;
  moderatorB: Member;
  now: Date;
};
type Swap = { swapId: string; legId: string };

describe('Task 8.3 live handover reminder delivery', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Handover reminder delivery live test connection is not initialised.');
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
    const name = `handover_delivery_denial_${++savepointNumber}`;
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
    const now = new Date();
    const member = (schoolId: string): Member => {
      const userId = randomUUID();
      return {
        schoolId, userId, membershipId: randomUUID(),
        email: `hrd-${userId}@example.invalid`,
      };
    };
    const requester = member(schoolA);
    const provider = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [requester, provider, parentB, moderatorB];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Handover Delivery School A', 'Australia/Sydney'),
             ($3, $4, 'Handover Delivery School B', 'Australia/Melbourne')`,
    [schoolA, `hrd-a-${schoolA}`, schoolB, `hrd-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select m.id, 'authenticated', 'authenticated', m.email, now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', 'Parent ' || left(m.id::text, 8)), now(), now()
      from unnest($1::uuid[], $2::text[]) as m(id, email)`,
    [members.map((m) => m.userId), members.map((m) => m.email)]);
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
      values ($1, $2, 1, 'HRD A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'HRD B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return { schoolA, schoolB, requester, provider, parentB, moderatorB, now };
  }

  async function createSwap(options: {
    requester?: Member; provider?: Member; expectedAt: Date; schoolId?: string;
  }): Promise<Swap> {
    return privileged('fixture: overdue accepted swap leg', async () => {
      const requester = options.requester ?? fixture.requester;
      const provider = options.provider ?? fixture.provider;
      const schoolId = options.schoolId ?? requester.schoolId;
      const swapId = randomUUID();
      const legId = randomUUID();
      const reverseLegId = randomUUID();
      const patterns = Array.from({ length: 4 }, () => randomUUID());
      const instances = Array.from({ length: 4 }, () => randomUUID());
      const owners = [provider.userId, requester.userId, requester.userId, provider.userId];
      const intents = ['can_help', 'need_help', 'can_help', 'need_help'];
      await db().query(`insert into public.availability_patterns
        (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
         area_label, capacity, starts_on, created_at)
        select p.id, $2::uuid, p.owner_id, p.intent::public.schedule_intent, 'pickup',
          extract(isodow from (now() at time zone s.timezone))::smallint,
          '15:00'::time, '15:30'::time, 'Carlton', 1, (now() at time zone s.timezone)::date,
          now() - interval '2 days'
        from unnest($1::uuid[], $3::uuid[], $4::text[]) p(id, owner_id, intent)
        cross join public.schools s where s.id = $2`, [patterns, schoolId, owners, intents]);
      await db().query(`insert into public.availability_instances
        (id, pattern_id, school_id, owner_id, service_date, intent, direction,
         window_start, window_end, area_label, capacity, created_at)
        select i.id, i.pattern_id, $3::uuid, i.owner_id, (now() at time zone s.timezone)::date,
          i.intent::public.schedule_intent, 'pickup', '15:00'::time, '15:30'::time, 'Carlton', 1,
          now() - interval '2 days'
        from unnest($1::uuid[], $2::uuid[], $4::uuid[], $5::text[]) i(id, pattern_id, owner_id, intent)
        cross join public.schools s where s.id = $3`, [instances, patterns, schoolId, owners, intents]);
      await db().query(`insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, accepted_at, expires_at)
        values ($1, $2, $3, $4, 'accepted', now() - interval '2 days',
          now() - interval '1 day', now() + interval '1 day')`,
      [swapId, schoolId, requester.userId, provider.userId]);
      await db().query(`insert into public.swap_legs
        (id, swap_id, school_id, helper_instance_id, requester_instance_id,
         helper_id, requester_id, service_date, created_at)
        select leg_id, $3::uuid, $4::uuid, helper_instance_id, requester_instance_id,
          helper_id, requester_id, (now() at time zone s.timezone)::date, now() - interval '2 days'
        from (values ($1::uuid, $5::uuid, $6::uuid, $9::uuid, $10::uuid),
                     ($2::uuid, $7::uuid, $8::uuid, $10::uuid, $9::uuid))
          l(leg_id, helper_instance_id, requester_instance_id, helper_id, requester_id)
        cross join public.schools s where s.id = $4`, [
        legId, reverseLegId, swapId, schoolId, ...instances, provider.userId, requester.userId,
      ]);
      await db().query('update public.swap_legs set expected_arrival_at = $2 where swap_id = $1',
        [swapId, options.expectedAt]);
      return { swapId, legId };
    });
  }

  async function confirmPickup(swap: Swap, actor = fixture.provider): Promise<void> {
    await authenticated(actor.userId, 'select public.confirm_pickup_done($1::uuid)', [swap.legId]);
  }

  async function confirmArrived(swap: Swap, actor = fixture.requester): Promise<void> {
    await authenticated(actor.userId, 'select public.confirm_child_arrived($1::uuid)', [swap.legId]);
  }

  beforeEach(async () => {
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required.');
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query('begin');
    transactionStarted = true;
    fixture = await privileged('fixture: handover delivery seed', seed);
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

  it('deliverEligibleQueuesAndClaims: overdue reminder queues handover_reminder then service claim completes', async () => {
    const swap = await createSwap({
      expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS),
    });
    await confirmPickup(swap);

    const reminders = await privileged('read-back: reminder rows', async () => {
      const { rows } = await db().query<{ id: string; recipient_membership: string }>(
        'select id, recipient_membership from public.swap_leg_reminders where swap_leg_id = $1',
        [swap.legId]);
      return rows;
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].recipient_membership).toBe(fixture.requester.membershipId);

    await denied(() => authenticated(fixture.requester.userId,
      'select public.deliver_due_handover_reminders(10)'));
    await denied(() => authenticated(fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'handover_reminder', $2::uuid)`,
      [swap.swapId, fixture.requester.userId]));

    const delivered = await privileged('read-back: deliver due handover reminders', async () => {
      const { rows } = await db().query<{ deliver_due_handover_reminders: {
        queued: number; suppressed: number; items: Array<{ outcome: string; reminder_id: string }>;
      } }>('select public.deliver_due_handover_reminders(50) as deliver_due_handover_reminders');
      return rows[0].deliver_due_handover_reminders;
    });
    expect(delivered.queued).toBeGreaterThanOrEqual(1);
    expect(delivered.items.some(
      (item) => item.reminder_id === reminders[0].id && item.outcome === 'queued',
    )).toBe(true);

    const queue = await privileged('read-back: handover relay queue', async () => {
      const { rows } = await db().query<{
        id: string; kind: string; status: string; template_key: string;
      }>(`select id, kind, status, template_key from public.email_relay_queue
          where swap_id = $1 and kind = 'handover_reminder'`, [swap.swapId]);
      return rows;
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      kind: 'handover_reminder', status: 'queued', template_key: 'handover_reminder_v1',
    });

    await denied(() => authenticated(fixture.requester.userId,
      'select public.claim_email_relay_batch(5)'));

    const claimed = await privileged('read-back: claim handover reminder batch', async () => {
      const { rows } = await db().query<{ claim_email_relay_batch: {
        items: Array<{ id: string; kind: string; recipient_email: string }>;
      } }>('select public.claim_email_relay_batch(10) as claim_email_relay_batch');
      return rows[0].claim_email_relay_batch;
    });
    const match = claimed.items.find((item) => item.id === queue[0].id);
    expect(match?.kind).toBe('handover_reminder');
    expect(match?.recipient_email).toBe(fixture.requester.email);

    const completed = await privileged('read-back: complete handover reminder delivery', async () => {
      const { rows } = await db().query<{ complete_email_relay_delivery: string }>(
        `select public.complete_email_relay_delivery($1::uuid, 'sent', 'dry_run')
           as complete_email_relay_delivery`, [queue[0].id]);
      return rows[0].complete_email_relay_delivery;
    });
    expect(completed).toBe('sent');

    const listed = await authenticated<{ list_my_handover_reminder_deliveries: Array<{
      outcome: string; reminder_id: string;
    }> }>(fixture.requester.userId,
      'select public.list_my_handover_reminder_deliveries() as list_my_handover_reminder_deliveries');
    expect(listed[0].list_my_handover_reminder_deliveries.some(
      (row) => row.reminder_id === reminders[0].id && row.outcome === 'queued',
    )).toBe(true);
    expect(JSON.stringify(listed[0].list_my_handover_reminder_deliveries))
      .not.toMatch(/phone|mobile|amount|price|currency|nickname/i);

    const second = await privileged('read-back: idempotent second delivery sweep', async () => {
      const { rows } = await db().query<{ deliver_due_handover_reminders: {
        queued: number; suppressed: number;
      } }>('select public.deliver_due_handover_reminders(50) as deliver_due_handover_reminders');
      return rows[0].deliver_due_handover_reminders;
    });
    expect(second.queued).toBe(0);
  });

  it('suppressCompletedAndCancelled: delivery recheck suppresses resolved reminders without queueing', async () => {
    const completedSwap = await createSwap({
      expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS),
    });
    await confirmPickup(completedSwap);
    await confirmArrived(completedSwap);

    const cancelledSwap = await createSwap({
      expectedAt: new Date(fixture.now.getTime() - 40 * MINUTE_MS),
    });
    await confirmPickup(cancelledSwap);
    await authenticated(fixture.requester.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text)',
      [cancelledSwap.swapId, '+61400000901']);
    await authenticated(fixture.requester.userId,
      'select public.revoke_contact_sharing($1::uuid)', [cancelledSwap.swapId]);

    const result = await privileged('read-back: deliver suppressed reminders', async () => {
      const { rows } = await db().query<{ deliver_due_handover_reminders: {
        queued: number; suppressed: number; items: Array<{
          swap_leg_id: string; outcome: string; email_relay_queue_id: string | null;
        }>;
      } }>('select public.deliver_due_handover_reminders(50) as deliver_due_handover_reminders');
      return rows[0].deliver_due_handover_reminders;
    });

    const completedItem = result.items.find((item) => item.swap_leg_id === completedSwap.legId);
    const cancelledItem = result.items.find((item) => item.swap_leg_id === cancelledSwap.legId);
    expect(completedItem?.outcome).toBe('suppressed_completed');
    expect(completedItem?.email_relay_queue_id).toBeNull();
    expect(cancelledItem?.outcome).toBe('suppressed_cancelled');
    expect(cancelledItem?.email_relay_queue_id).toBeNull();

    const queued = await privileged('read-back: no suppressed queue rows', async () => {
      const { rows } = await db().query(
        `select id from public.email_relay_queue
         where kind = 'handover_reminder' and swap_id = any($1::uuid[])`,
        [[completedSwap.swapId, cancelledSwap.swapId]]);
      return rows;
    });
    expect(queued).toEqual([]);
  });

  it('crossSchoolDenials: School B cannot read School A deliveries or enqueue foreign handover mail', async () => {
    const swapA = await createSwap({
      expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS),
    });
    await confirmPickup(swapA);
    await privileged('read-back: deliver school A reminder', async () => {
      await db().query('select public.deliver_due_handover_reminders(50)');
    });

    const foreignList = await authenticated<{ list_my_handover_reminder_deliveries: unknown[] }>(
      fixture.parentB.userId,
      'select public.list_my_handover_reminder_deliveries() as list_my_handover_reminder_deliveries');
    expect(foreignList[0].list_my_handover_reminder_deliveries).toEqual([]);

    const foreignSelect = await authenticated<{ id: string }>(
      fixture.moderatorB.userId,
      `select id from public.handover_reminder_deliveries where school_id = $1`,
      [fixture.schoolA]);
    expect(foreignSelect).toEqual([]);

    await denied(() => authenticated(fixture.parentB.userId,
      `select public.enqueue_email_relay($1::uuid, 'handover_reminder', $2::uuid)`,
      [swapA.swapId, fixture.requester.userId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.deliver_due_handover_reminders(10)'));
  });

  it('noDirectDml: clients cannot insert update delete delivery rows or forge handover queue', async () => {
    const swap = await createSwap({
      expectedAt: new Date(fixture.now.getTime() - 31 * MINUTE_MS),
    });
    await confirmPickup(swap);
    const reminderId = await privileged('read-back: reminder id for dml denial', async () => {
      const { rows } = await db().query<{ id: string }>(
        'select id from public.swap_leg_reminders where swap_leg_id = $1', [swap.legId]);
      return rows[0].id;
    });

    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.handover_reminder_deliveries
        (school_id, reminder_id, swap_leg_id, swap_id, recipient_user_id,
         recipient_membership, outcome)
       values ($1, $2, $3, $4, $5, $6, 'queued')`,
      [fixture.schoolA, reminderId, swap.legId, swap.swapId,
        fixture.requester.userId, fixture.requester.membershipId]),
    ['42501', '23514']);

    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.email_relay_queue
        (school_id, swap_id, recipient_user_id, recipient_membership,
         kind, template_key, status, created_by)
       values ($1, $2, $3, $4, 'handover_reminder', 'handover_reminder_v1', 'queued', $3)`,
      [fixture.schoolA, swap.swapId, fixture.requester.userId, fixture.requester.membershipId]),
    ['42501']);

    await privileged('read-back: deliver for update denial', async () => {
      await db().query('select public.deliver_due_handover_reminders(50)');
    });
    await denied(() => authenticated(fixture.requester.userId,
      `update public.handover_reminder_deliveries set outcome = 'suppressed_completed'`),
    ['55000', '42501']);
    await denied(() => authenticated(fixture.requester.userId,
      'delete from public.handover_reminder_deliveries'),
    ['55000', '42501']);
  });

  it('catalogAllowlistAndSearchPath: delivery table RLS; RPCs allowlisted; no money fields', async () => {
    const tables = await privileged('read-back: delivery table catalog', async () => {
      const { rows } = await db().query<{
        table_name: string; rls: boolean; insert_priv: boolean;
      }>(`select c.relname as table_name, c.relrowsecurity as rls,
             has_table_privilege('authenticated', c.oid, 'INSERT') as insert_priv
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
             and c.relname = 'handover_reminder_deliveries'`);
      return rows;
    });
    expect(tables).toEqual([{
      table_name: 'handover_reminder_deliveries', rls: true, insert_priv: false,
    }]);

    const moneyCols = await privileged('read-back: delivery money columns', async () => {
      const { rows } = await db().query(
        `select column_name from information_schema.columns
         where table_schema = 'public'
           and table_name = 'handover_reminder_deliveries'
           and column_name ~* '(amount|price|currency|money|photo|nickname|latitude|longitude)'`);
      return rows;
    });
    expect(moneyCols).toEqual([]);

    const fns = await privileged('read-back: delivery functions', async () => {
      const { rows } = await db().query<{
        proname: string; search_path: string | null; exec_auth: boolean; exec_service: boolean;
      }>(`select p.proname,
             (select trim(both '"' from unnest) from pg_catalog.unnest(
                coalesce(p.proconfig, array[]::text[])) unnest
              where unnest like 'search_path=%' limit 1) as search_path,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as exec_auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as exec_service
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in (
               'deliver_due_handover_reminders',
               'list_my_handover_reminder_deliveries',
               'handover_reminder_live_eligibility',
               'guard_handover_reminder_deliveries'
             )`);
      return rows;
    });
    const byName = Object.fromEntries(fns.map((f) => [f.proname, f]));
    expect(byName.list_my_handover_reminder_deliveries.search_path).toBe('search_path=pg_catalog');
    expect(byName.list_my_handover_reminder_deliveries.exec_auth).toBe(true);
    expect(byName.deliver_due_handover_reminders.search_path).toBe('search_path=pg_catalog');
    expect(byName.deliver_due_handover_reminders.exec_auth).toBe(false);
    expect(byName.deliver_due_handover_reminders.exec_service).toBe(true);
    expect(byName.handover_reminder_live_eligibility.exec_auth).toBe(false);
    expect(byName.guard_handover_reminder_deliveries.exec_auth).toBe(false);

    const kindOk = await privileged('read-back: queue accepts handover kind', async () => {
      const { rows } = await db().query<{ ok: boolean }>(
        `select exists (
           select 1 from pg_catalog.pg_constraint c
           where c.conrelid = 'public.email_relay_queue'::regclass
             and pg_catalog.pg_get_constraintdef(c.oid) like '%handover_reminder%'
             and pg_catalog.pg_get_constraintdef(c.oid) like '%contact_consent_revoked%'
         ) as ok`);
      return rows[0].ok;
    });
    expect(kindOk).toBe(true);
  });
});
