/**
 * Task 7.3 live suite: 90-day disclosure/access-log/departure retention purge.
 * Authenticated + synthetic JWT; ROLLBACK. Ledger/trust/child preserved.
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 90_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

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

describe('Task 7.3 live 90-day disclosure and access log retention purge', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Retention purge live test connection is not initialised.');
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
    const name = `retention_denial_${++savepointNumber}`;
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
      values ($1, $2, 'Retention School A', 'Australia/Sydney'),
             ($3, $4, 'Retention School B', 'Australia/Melbourne')`,
    [schoolA, `ret-a-${schoolA}`, schoolB, `ret-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'retention-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Retention Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) as u(id)`, [members.map((m) => m.userId)]);
    await db().query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, 'verified'::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '120 days'
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
      values ($1, $2, 1, 'Retention A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Retention B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    await db().query(`insert into public.child_profiles
      (id, membership_id, parent_id, nickname, year_level)
      values ($1, $2, $3, 'RetainedKid', 4)`,
    [randomUUID(), requester.membershipId, requester.userId]);
    return {
      schoolA, schoolB, requester, provider, parentB, moderatorB, now: clock[0].now,
    };
  }

  async function createEndedSwapBundle(daysAgo: number): Promise<{
    swapId: string;
    legId: string;
    consentId: string;
    noticeId: string;
    departureId: string;
    relayId: string;
    ledgerId: string;
    trustEventId: string;
  }> {
    return privileged(`fixture: ended swap bundle ${daysAgo}d`, async () => {
      const endedAt = new Date(fixture.now.getTime() - daysAgo * DAY_MS);
      const serviceAt = new Date(endedAt.getTime() - DAY_MS);
      const proposedAt = new Date(endedAt.getTime() - 2 * DAY_MS);
      const acceptedAt = new Date(endedAt.getTime() - DAY_MS);
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
         helper_id, requester_id, service_date, created_at, completed_at)
        values ($1, $3, $4, $5, $6, $9, $10,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12, $13),
               ($2, $3, $4, $7, $8, $10, $9,
                ($11::timestamptz at time zone 'Australia/Sydney')::date, $12, null)`, [
        legId, reverseLegId, swapId, fixture.schoolA, ...instanceIds,
        fixture.provider.userId, fixture.requester.userId, serviceAt, proposedAt, acceptedAt,
      ]);

      const { rows: ledgerRows } = await db().query<{ id: string }>(
        'select id from public.swap_ledger_entries where swap_leg_id = $1', [legId]);
      const ledgerId = ledgerRows[0]?.id;
      if (!ledgerId) throw new Error('Expected ledger entry from completed leg.');
      const { rows: trustRows } = await db().query<{ id: string }>(
        `select id from public.trust_score_events
         where source_entity_type = 'swap_leg' and source_entity_id = $1
           and reason_code = 'completed_trip'`, [legId]);
      const trustEventId = trustRows[0]?.id;
      if (!trustEventId) throw new Error('Expected trust event from completed leg.');

      const consentId = randomUUID();
      await db().query(`insert into public.contact_consents
        (id, school_id, swap_id, member, consent_version, granted_at, revoked_at)
        values ($1, $2, $3, $4, 1, $5, $6)`,
      [consentId, fixture.schoolA, swapId, fixture.requester.membershipId, acceptedAt, endedAt]);
      await db().query(`insert into yourturn_private.mobile_numbers
        (consent_id, member, mobile_number) values ($1, $2, '+61412345678')`,
      [consentId, fixture.requester.membershipId]);
      await db().query(`insert into public.contact_consent_backups
        (consent_id, school_id, backup_membership) values ($1, $2, $3)`,
      [consentId, fixture.schoolA, fixture.provider.membershipId]);
      await db().query(`insert into public.swap_contact_notifications
        (school_id, swap_id, recipient_membership, created_at)
        values ($1, $2, $3, $4)`,
      [fixture.schoolA, swapId, fixture.provider.membershipId, endedAt]);

      const noticeId = randomUUID();
      await db().query(`insert into public.school_notices
        (id, school_id, swap_id, swap_leg_id, generated_by, service_date, year_levels,
         collector_display_name, notice_body, status, created_at)
        values ($1, $2, $3, $4, $5, ($6::timestamptz at time zone 'Australia/Sydney')::date,
          array[4]::smallint[], 'Collector Name',
          'Collection notice — 2020-01-01' || E'\nYear level: Year 4' || E'\nCollector: Collector Name',
          'active', $6)`,
      [noticeId, fixture.schoolA, swapId, legId, fixture.requester.userId, serviceAt]);
      await db().query(`insert into public.school_notice_access_logs
        (school_id, notice_id, actor_user_id, action, created_at)
        values ($1, $2, $3, 'generated', $4)`,
      [fixture.schoolA, noticeId, fixture.requester.userId, serviceAt]);

      const departureId = randomUUID();
      await db().query(`insert into public.departure_check_logs
        (id, school_id, swap_id, swap_leg_id, membership, outcome, created_at)
        values ($1, $2, $3, $4, $5, 'confirmed', $6)`,
      [departureId, fixture.schoolA, swapId, legId, fixture.provider.membershipId, serviceAt]);

      const relayId = randomUUID();
      await db().query(`insert into public.email_relay_queue
        (id, school_id, swap_id, recipient_user_id, recipient_membership, kind,
         template_key, status, created_by, created_at, claimed_at, sent_at)
        values ($1, $2, $3, $4, $5, 'contact_consent_revoked', 'contact_consent_revoked_v1',
          'sent', $6, $7, $7, $7)`,
      [relayId, fixture.schoolA, swapId, fixture.provider.userId,
        fixture.provider.membershipId, fixture.requester.userId, endedAt]);
      await db().query(`insert into public.email_relay_delivery_events
        (school_id, queue_id, event_code, created_at)
        values ($1, $2, 'sent', $3)`, [fixture.schoolA, relayId, endedAt]);

      await db().query(`update public.swap_proposals
        set status = 'cancelled_consent_revoked', cancelled_at = $2, updated_at = $2
        where id = $1`, [swapId, endedAt]);

      return {
        swapId, legId, consentId, noticeId, departureId, relayId, ledgerId, trustEventId,
      };
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for retention purge live tests.');
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
      set local statement_timeout = '30s'; set local lock_timeout = '5s'`);
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

  it('purgesExpiredKeepsInWindow: 91-day disclosures and logs removed; 89-day retained', async () => {
    const expired = await createEndedSwapBundle(91);
    const fresh = await createEndedSwapBundle(89);

    const result = await privileged('read-back: run retention purge', async () => {
      const { rows } = await db().query<{ purge_expired_disclosure_retention: {
        swaps_considered: number;
        contact_disclosures_purged: number;
        notice_logs_purged: number;
        departure_checks_purged: number;
        email_relay_rows_purged: number;
      } }>('select public.purge_expired_disclosure_retention() as purge_expired_disclosure_retention');
      return rows[0].purge_expired_disclosure_retention;
    });
    expect(result.swaps_considered).toBeGreaterThanOrEqual(1);
    expect(result.contact_disclosures_purged).toBeGreaterThan(0);
    expect(result.notice_logs_purged).toBeGreaterThan(0);
    expect(result.departure_checks_purged).toBeGreaterThan(0);
    expect(result.email_relay_rows_purged).toBeGreaterThan(0);

    const gone = await privileged('read-back: expired disclosure rows gone', async () => {
      const { rows } = await db().query<{
        consents: string; mobiles: string; notices: string; access: string;
        departures: string; relays: string;
      }>(`select
        (select count(*)::text from public.contact_consents where swap_id = $1) as consents,
        (select count(*)::text from yourturn_private.mobile_numbers where consent_id = $2) as mobiles,
        (select count(*)::text from public.school_notices where id = $3) as notices,
        (select count(*)::text from public.school_notice_access_logs where notice_id = $3) as access,
        (select count(*)::text from public.departure_check_logs where id = $4) as departures,
        (select count(*)::text from public.email_relay_queue where id = $5) as relays`,
      [expired.swapId, expired.consentId, expired.noticeId, expired.departureId, expired.relayId]);
      return rows[0];
    });
    expect(gone).toEqual({
      consents: '0', mobiles: '0', notices: '0', access: '0', departures: '0', relays: '0',
    });

    const kept = await privileged('read-back: in-window disclosure rows kept', async () => {
      const { rows } = await db().query<{
        consents: string; notices: string; departures: string; relays: string;
      }>(`select
        (select count(*)::text from public.contact_consents where swap_id = $1) as consents,
        (select count(*)::text from public.school_notices where id = $2) as notices,
        (select count(*)::text from public.departure_check_logs where id = $3) as departures,
        (select count(*)::text from public.email_relay_queue where id = $4) as relays`,
      [fresh.swapId, fresh.noticeId, fresh.departureId, fresh.relayId]);
      return rows[0];
    });
    expect(kept).toEqual({
      consents: '1', notices: '1', departures: '1', relays: '1',
    });
  });

  it('preservesLedgerTrustAndChildren: purge never deletes ledger trust events or child profiles', async () => {
    const expired = await createEndedSwapBundle(91);
    await privileged('read-back: run retention purge', async () => {
      await db().query('select public.purge_expired_disclosure_retention()');
    });
    const preserved = await privileged('read-back: ledger trust child preserved', async () => {
      const { rows } = await db().query<{
        ledger: string; trust: string; children: string;
      }>(`select
        (select count(*)::text from public.swap_ledger_entries where id = $1) as ledger,
        (select count(*)::text from public.trust_score_events where id = $2) as trust,
        (select count(*)::text from public.child_profiles
          where membership_id = $3 and nickname = 'RetainedKid') as children`,
      [expired.ledgerId, expired.trustEventId, fixture.requester.membershipId]);
      return rows[0];
    });
    expect(preserved).toEqual({ ledger: '1', trust: '1', children: '1' });
  });

  it('authenticatedDeniedCrossSchool: parents and School B cannot run purge or read foreign departure logs', async () => {
    const expired = await createEndedSwapBundle(91);
    await denied(() => authenticated(fixture.requester.userId,
      'select public.purge_expired_disclosure_retention()'));
    await denied(() => authenticated(fixture.parentB.userId,
      'select public.purge_expired_disclosure_retention()'));
    await denied(() => authenticated(fixture.moderatorB.userId,
      'select public.purge_expired_disclosure_retention()'));

    const foreign = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      'select id from public.departure_check_logs where id = $1', [expired.departureId],
    );
    expect(foreign).toEqual([]);

    const policy = await authenticated<{ get_retention_purge_policy: {
      retention_days: number; targets: string[]; preserved: string[];
    } }>(
      fixture.requester.userId,
      'select public.get_retention_purge_policy() as get_retention_purge_policy',
    );
    expect(policy[0].get_retention_purge_policy.retention_days).toBe(90);
    expect(policy[0].get_retention_purge_policy.targets).toContain('contact_disclosures');
    expect(policy[0].get_retention_purge_policy.preserved).toContain('swap_ledger_entries');
  });

  it('noClientDeleteWithoutPurgeFlag: ordinary deletes of disclosures still raise 55000', async () => {
    const fresh = await createEndedSwapBundle(10);
    await denied(() => authenticated(fixture.requester.userId,
      'delete from public.contact_consents where id = $1', [fresh.consentId]), ['42501', '55000']);
    await privileged('read-back: privileged delete without purge flag blocked', async () => {
      await denied(async () => {
        await db().query('delete from public.school_notice_access_logs where notice_id = $1',
          [fresh.noticeId]);
      }, ['55000']);
      await denied(async () => {
        await db().query('delete from public.departure_check_logs where id = $1',
          [fresh.departureId]);
      }, ['55000']);
    });
  });

  it('catalogAllowlistAndSearchPath: new tables RLS; purge service-only; no money fields', async () => {
    const catalog = await privileged('read-back: retention catalogue', async () => {
      const { rows } = await db().query<{
        relname: string; relrowsecurity: boolean; insert_priv: boolean; select_priv: boolean;
      }>(`
        select c.relname, c.relrowsecurity,
          has_table_privilege('authenticated', c.oid, 'INSERT') as insert_priv,
          has_table_privilege('authenticated', c.oid, 'SELECT') as select_priv
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('departure_check_logs', 'retention_purge_runs')
        order by c.relname`);
      return rows;
    });
    expect(catalog).toEqual([
      expect.objectContaining({
        relname: 'departure_check_logs', relrowsecurity: true, insert_priv: false, select_priv: true,
      }),
      expect.objectContaining({
        relname: 'retention_purge_runs', relrowsecurity: true, insert_priv: false, select_priv: true,
      }),
    ]);

    const money = await privileged('read-back: retention monetary columns', async () => {
      const { rows } = await db().query<{ count: string }>(`
        select count(*)::text as count from information_schema.columns
        where table_schema = 'public'
          and table_name in ('departure_check_logs', 'retention_purge_runs')
          and column_name ~* '(amount|price|currency|money|fee|payment|phone|mobile|nickname|lat|lng|location)'`);
      return rows[0].count;
    });
    expect(money).toBe('0');

    const paths = await privileged('read-back: retention function search paths', async () => {
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
          'purge_expired_disclosure_retention', 'get_retention_purge_policy',
          'swap_retention_ended_at', 'guard_departure_check_logs', 'guard_retention_purge_runs'
        )
        order by p.proname`);
      return rows;
    });
    for (const row of paths) {
      expect(row.search_path).toBe('pg_catalog');
      expect(row.anon_exec).toBe(false);
    }
    expect(paths.find((row) => row.proname === 'get_retention_purge_policy')?.auth_exec).toBe(true);
    expect(paths.find((row) => row.proname === 'purge_expired_disclosure_retention')?.auth_exec).toBe(false);
    expect(paths.find((row) => row.proname === 'purge_expired_disclosure_retention')?.service_exec).toBe(true);
  });
});
