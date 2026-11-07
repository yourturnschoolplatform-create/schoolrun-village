/**
 * Task 7.2 live suite: outbound email relay queue, masking, delivery policy,
 * service-only claim, cross-school denials. Authenticated + synthetic JWT; ROLLBACK.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type Member = { userId: string; membershipId: string; schoolId: string; email: string };
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

type QueueItem = {
  id: string;
  school_id: string;
  kind: string;
  status: string;
  masked_recipient: string;
  recipient_user_id: string;
};

describe('Task 7.2 live email relay queue masking and delivery policy', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Email relay live test connection is not initialised.');
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
    const name = `email_relay_denial_${++savepointNumber}`;
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
    const member = (schoolId: string): Member => {
      const userId = randomUUID();
      return {
        schoolId, userId, membershipId: randomUUID(),
        email: `relay-${userId}@example.invalid`,
      };
    };
    const requester = member(schoolA);
    const provider = member(schoolA);
    const stranger = member(schoolA);
    const moderatorA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const members = [requester, provider, stranger, moderatorA, parentB, moderatorB];
    const { rows: clock } = await db().query<{ now: Date }>('select now() as now');

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Relay School A', 'Australia/Sydney'),
             ($3, $4, 'Relay School B', 'Australia/Melbourne')`,
    [schoolA, `relay-a-${schoolA}`, schoolB, `relay-b-${schoolB}`]);
    for (const m of members) {
      await db().query(`insert into auth.users
        (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
         raw_user_meta_data, created_at, updated_at)
        values ($1, 'authenticated', 'authenticated', $2, now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          '{"display_name":"Relay Fixture"}'::jsonb, now(), now())`,
      [m.userId, m.email]);
    }
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
      cross join public.consent_documents d where d.is_active`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Relay A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Relay B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, requester, provider, stranger, moderatorA, parentB, moderatorB,
      now: clock[0].now,
    };
  }

  async function createAcceptedSwap(): Promise<{ swapId: string }> {
    return privileged('fixture: accepted swap for email relay', async () => {
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
      return { swapId };
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for email relay live tests.');
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

  it('enqueueMasksRecipient: partner enqueue returns masked address only and never raw email or mobile', async () => {
    const { swapId } = await createAcceptedSwap();
    const rows = await authenticated<{ enqueue_email_relay: QueueItem }>(
      fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)
         as enqueue_email_relay`,
      [swapId, fixture.provider.userId],
    );
    const item = rows[0].enqueue_email_relay;
    expect(item.status).toBe('queued');
    expect(item.kind).toBe('swap_partner_notice');
    expect(item.masked_recipient).toMatch(/^r\*\*\*@e\*\*\*\.invalid$/);
    expect(item.masked_recipient).not.toBe(fixture.provider.email);
    expect(JSON.stringify(item)).not.toMatch(new RegExp(fixture.provider.email.replace('.', '\\.'), 'i'));
    expect(JSON.stringify(item)).not.toMatch(/phone|mobile|\+61|amount|price|currency/i);

    const listed = await authenticated<{ list_my_email_relay_queue: QueueItem[] }>(
      fixture.provider.userId,
      'select public.list_my_email_relay_queue() as list_my_email_relay_queue',
    );
    expect(listed[0].list_my_email_relay_queue.some((row) => row.id === item.id)).toBe(true);
    expect(listed[0].list_my_email_relay_queue.every((row) => row.masked_recipient.includes('***'))).toBe(true);
  });

  it('deliveryPolicyBlocksHandoverAndExposesTransport: policy excludes Day 8 reminders; handover enqueue denied', async () => {
    const policy = await authenticated<{ get_email_relay_delivery_policy: {
      transport: string; excluded_kinds: string[]; allowed_kinds: string[];
    } }>(
      fixture.requester.userId,
      'select public.get_email_relay_delivery_policy() as get_email_relay_delivery_policy',
    );
    expect(policy[0].get_email_relay_delivery_policy.transport).toBe('server_admin_only');
    expect(policy[0].get_email_relay_delivery_policy.excluded_kinds).toContain('handover_reminder');
    expect(policy[0].get_email_relay_delivery_policy.allowed_kinds).not.toContain('handover_reminder');

    const { swapId } = await createAcceptedSwap();
    await denied(() => authenticated(fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'handover_reminder', $2::uuid)`,
      [swapId, fixture.provider.userId]));
  });

  it('crossSchoolAndRoleDenials: stranger School B parent/moderator cannot enqueue or read School A queue', async () => {
    const { swapId } = await createAcceptedSwap();
    const created = await authenticated<{ enqueue_email_relay: QueueItem }>(
      fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'contact_consent_revoked', $2::uuid)
         as enqueue_email_relay`,
      [swapId, fixture.provider.userId],
    );
    const id = created[0].enqueue_email_relay.id;

    await denied(() => authenticated(fixture.stranger.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)`,
      [swapId, fixture.provider.userId]));
    await denied(() => authenticated(fixture.parentB.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)`,
      [swapId, fixture.provider.userId]));
    await denied(() => authenticated(fixture.moderatorB.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)`,
      [swapId, fixture.provider.userId]));
    await denied(() => authenticated(fixture.requester.userId,
      'select public.list_school_email_relay_queue()'));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.list_school_email_relay_queue()'));

    const foreign = await authenticated<{ list_school_email_relay_queue: {
      school_id: string; items: QueueItem[];
    } }>(
      fixture.moderatorB.userId,
      'select public.list_school_email_relay_queue() as list_school_email_relay_queue',
    );
    expect(foreign[0].list_school_email_relay_queue.school_id).toBe(fixture.schoolB);
    expect(foreign[0].list_school_email_relay_queue.items).toEqual([]);

    const direct = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.email_relay_queue where id = $1', [id],
    );
    expect(direct).toEqual([]);

    const schoolQueue = await authenticated<{ list_school_email_relay_queue: {
      items: QueueItem[];
    } }>(
      fixture.moderatorA.userId,
      'select public.list_school_email_relay_queue() as list_school_email_relay_queue',
    );
    expect(schoolQueue[0].list_school_email_relay_queue.items.some((row) => row.id === id)).toBe(true);
    expect(JSON.stringify(schoolQueue[0].list_school_email_relay_queue))
      .not.toMatch(new RegExp(fixture.provider.email.replace('.', '\\.'), 'i'));
  });

  it('claimAndCompleteServiceOnly: authenticated denied; privileged claim exposes email once then marks sent', async () => {
    const { swapId } = await createAcceptedSwap();
    const created = await authenticated<{ enqueue_email_relay: QueueItem }>(
      fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)
         as enqueue_email_relay`,
      [swapId, fixture.provider.userId],
    );
    const id = created[0].enqueue_email_relay.id;

    await denied(() => authenticated(fixture.requester.userId,
      'select public.claim_email_relay_batch(5)'));
    await denied(() => authenticated(fixture.moderatorA.userId,
      'select public.complete_email_relay_delivery($1::uuid, $2::text, $3::text)',
      [id, 'sent', 'delivered']));

    const claimed = await privileged('read-back: claim email relay batch', async () => {
      const { rows } = await db().query<{ claim_email_relay_batch: {
        items: Array<{ id: string; recipient_email: string; masked_recipient: string }>;
      } }>('select public.claim_email_relay_batch(5) as claim_email_relay_batch');
      return rows[0].claim_email_relay_batch;
    });
    const match = claimed.items.find((row) => row.id === id);
    expect(match?.recipient_email).toBe(fixture.provider.email);
    expect(match?.masked_recipient).toMatch(/\*\*\*/);

    const completed = await privileged('read-back: complete email relay delivery', async () => {
      const { rows } = await db().query<{ complete_email_relay_delivery: string }>(
        `select public.complete_email_relay_delivery($1::uuid, 'sent', 'dry_run')
           as complete_email_relay_delivery`, [id],
      );
      return rows[0].complete_email_relay_delivery;
    });
    expect(completed).toBe('sent');

    const listed = await authenticated<{ list_my_email_relay_queue: QueueItem[] }>(
      fixture.provider.userId,
      'select public.list_my_email_relay_queue() as list_my_email_relay_queue',
    );
    expect(listed[0].list_my_email_relay_queue.find((row) => row.id === id)?.status).toBe('sent');
  });

  it('noDirectDmlAndCatalogPrivacy: clients cannot mutate queue; no email phone money columns', async () => {
    const { swapId } = await createAcceptedSwap();
    const created = await authenticated<{ enqueue_email_relay: QueueItem }>(
      fixture.requester.userId,
      `select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)
         as enqueue_email_relay`,
      [swapId, fixture.provider.userId],
    );
    const id = created[0].enqueue_email_relay.id;

    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.email_relay_queue
       (school_id, swap_id, recipient_user_id, recipient_membership, kind, template_key, status, created_by)
       select school_id, swap_id, recipient_user_id, recipient_membership, kind, template_key, status, created_by
       from public.email_relay_queue where id = $1`, [id]));
    await denied(() => authenticated(fixture.requester.userId,
      `update public.email_relay_queue set status = 'sent' where id = $1`, [id]));
    await denied(() => authenticated(fixture.requester.userId,
      `delete from public.email_relay_queue where id = $1`, [id]));
    await denied(() => authenticated(fixture.requester.userId,
      `insert into public.email_relay_delivery_events (school_id, queue_id, event_code)
       values ($1, $2, 'sent')`, [fixture.schoolA, id]));

    const sensitive = await privileged('read-back: email relay sensitive columns', async () => {
      const { rows } = await db().query<{ count: string }>(`
        select count(*)::text as count from information_schema.columns
        where table_schema = 'public'
          and table_name in (
            'email_relay_queue', 'email_relay_delivery_events', 'email_relay_delivery_policies'
          )
          and column_name ~* '(amount|price|currency|money|fee|payment|phone|mobile|nickname|smtp|secret|password)'`);
      return rows[0].count;
    });
    expect(sensitive).toBe('0');
  });

  it('catalogAllowlistAndSearchPath: RLS SELECT-only; RPCs allowlisted; claim internal to service_role', async () => {
    const catalog = await privileged('read-back: email relay catalogue', async () => {
      const { rows } = await db().query<{
        relname: string; relrowsecurity: boolean; insert_priv: boolean; select_priv: boolean;
      }>(`
        select c.relname, c.relrowsecurity,
          has_table_privilege('authenticated', c.oid, 'INSERT') as insert_priv,
          has_table_privilege('authenticated', c.oid, 'SELECT') as select_priv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in (
          'email_relay_queue', 'email_relay_delivery_events', 'email_relay_delivery_policies'
        )
        order by c.relname`);
      return rows;
    });
    expect(catalog).toHaveLength(3);
    for (const row of catalog) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.insert_priv).toBe(false);
      expect(row.select_priv).toBe(true);
    }

    const paths = await privileged('read-back: email relay function search paths', async () => {
      const { rows } = await db().query<{
        proname: string; search_path: string | null; auth_exec: boolean; anon_exec: boolean;
        service_exec: boolean;
      }>(`
        select p.proname,
          (select substr(setting, 13) from unnest(p.proconfig) setting
            where setting like 'search_path=%') as search_path,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'mask_email_address', 'get_email_relay_delivery_policy', 'enqueue_email_relay',
          'list_my_email_relay_queue', 'list_school_email_relay_queue',
          'claim_email_relay_batch', 'complete_email_relay_delivery',
          'guard_email_relay_history', 'email_relay_published_policy',
          'email_relay_kind_allowed', 'email_relay_queue_json', 'guard_email_relay_policy',
          'email_relay_policy_definition_is_valid'
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
      'enqueue_email_relay',
      'get_email_relay_delivery_policy',
      'list_my_email_relay_queue',
      'list_school_email_relay_queue',
      'mask_email_address',
    ]);
    expect(paths.find((row) => row.proname === 'claim_email_relay_batch')?.service_exec).toBe(true);
    expect(paths.find((row) => row.proname === 'claim_email_relay_batch')?.auth_exec).toBe(false);
    expect(paths.find((row) => row.proname === 'complete_email_relay_delivery')?.auth_exec).toBe(false);
  });
});
