/**
 * Task 6.1 live suite: trust score engine, bands, peer band-only exposure.
 * One transaction per test; authenticated role + synthetic JWT; ROLLBACK cleanup.
 * apply_trust_score_delta is exercised only via privileged fixture RESET ROLE.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  declarationA: string;
  declarationB: string;
  parentA: Member;
  peerA: Member;
  parentB: Member;
  moderatorB: Member;
  pendingA: Member;
  noMembershipUser: string;
  userIds: string[];
};

describe('Task 6.1 live trust score engine and peer exposure', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  function db(): Client {
    if (!client) throw new Error('Trust live test connection is not initialised.');
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
    const name = `trust_denial_${++savepointNumber}`;
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
    const parentA = member(schoolA);
    const peerA = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const pendingA = member(schoolA);
    const noMembershipUser = randomUUID();
    const members = [parentA, peerA, parentB, moderatorB, pendingA];
    const userIds = [...members.map((m) => m.userId), noMembershipUser];

    await db().query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Trust School A', 'Australia/Sydney'),
             ($3, $4, 'Trust School B', 'Australia/Melbourne')`,
    [schoolA, `trust-a-${schoolA}`, schoolB, `trust-b-${schoolB}`]);
    await db().query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated',
        'trust-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Trust Fixture"}'::jsonb, now(), now()
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
      values ($1, $2, 1, 'Trust declaration A', 'Synthetic school safety declaration A', true, now()),
             ($3, $4, 1, 'Trust declaration B', 'Synthetic school safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members.filter((row) => row !== pendingA)) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, declarationA, declarationB, parentA, peerA, parentB,
      moderatorB, pendingA, noMembershipUser, userIds,
    };
  }

  async function applyDelta(
    subject: Member, delta: number, reason: string, sourceId = randomUUID(),
  ): Promise<number> {
    return privileged('fixture: apply trust score delta', async () => {
      const { rows } = await db().query<{ score: number }>(
        `select public.apply_trust_score_delta($1::uuid, $2::uuid, $3::smallint, $4::text,
          'trust_live_fixture'::text, $5::uuid) as score`,
        [subject.userId, subject.schoolId, delta, reason, sourceId],
      );
      return rows[0].score;
    });
  }

  async function myTrust(userId: string): Promise<{
    trust_score: number; trust_band: string; admin_suspended: boolean;
  }> {
    const rows = await authenticated<{ trust: {
      trust_score: number; trust_band: string; admin_suspended: boolean;
    } }>(userId, 'select public.get_my_trust() as trust');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].trust).sort()).toEqual([
      'admin_suspended', 'trust_band', 'trust_score',
    ]);
    return rows[0].trust;
  }

  async function peerBand(viewerId: string, peerUserId: string): Promise<{ trust_band: string }> {
    const rows = await authenticated<{ band: { trust_band: string } }>(
      viewerId, 'select public.get_peer_trust_band($1::uuid) as band', [peerUserId],
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].band)).toEqual(['trust_band']);
    return rows[0].band;
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for trust live tests.');
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

  it('trustScoreEngine: apply_trust_score_delta clamps, posts history, and is idempotent by source', async () => {
    const source = randomUUID();
    const after = await applyDelta(fixture.parentA, 20, 'completed_trip', source);
    expect(after).toBe(90);
    const mine = await myTrust(fixture.parentA.userId);
    expect(mine.trust_score).toBe(90);
    expect(mine.trust_band).toBe('Trusted');
    expect(mine.admin_suspended).toBe(false);

    const again = await applyDelta(fixture.parentA, 20, 'completed_trip', source);
    expect(again).toBe(90);

    const high = await applyDelta(fixture.parentA, 100, 'urgent_cover', randomUUID());
    expect(high).toBe(150);
    await applyDelta(fixture.parentA, -100, 'confirmed_no_show', randomUUID());
    await applyDelta(fixture.parentA, -100, 'reviewed_safety_violation', randomUUID());
    await applyDelta(fixture.parentA, -100, 'cancel_under_2h', randomUUID());
    const floored = await myTrust(fixture.parentA.userId);
    expect(floored.trust_score).toBe(-100);
    expect(floored.trust_band).toBe('Suspended');

    const events = await authenticated<{
      delta: number; score_after: number; reason_code: string;
    }>(fixture.parentA.userId,
      `select delta, score_after, reason_code from public.trust_score_events
       where subject_user_id = $1 order by created_at, id`, [fixture.parentA.userId]);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((row) => Number.isInteger(row.delta))).toBe(true);
  });

  it('trustBands: published thresholds map scores and admin_suspended forces Suspended', async () => {
    const cases: Array<[number, string]> = [
      [150, 'Trusted'], [85, 'Trusted'], [84, 'Standard'], [60, 'Standard'],
      [59, 'Caution'], [40, 'Caution'], [39, 'Restricted'], [20, 'Restricted'],
      [19, 'Suspended'], [-100, 'Suspended'],
    ];
    for (const [score, band] of cases) {
      await privileged('fixture: set trust score for band case', async () => {
        await db().query(
          `update public.profiles set trust_score = $2::smallint, admin_suspended = false
           where id = $1::uuid`, [fixture.parentA.userId, score],
        );
      });
      const mine = await myTrust(fixture.parentA.userId);
      expect(mine.trust_score).toBe(score);
      expect(mine.trust_band).toBe(band);
      const peer = await peerBand(fixture.peerA.userId, fixture.parentA.userId);
      expect(peer.trust_band).toBe(band);
    }
    await privileged('fixture: force admin_suspended band', async () => {
      await db().query(
        `update public.profiles set trust_score = 150::smallint, admin_suspended = true
         where id = $1::uuid`, [fixture.parentA.userId],
      );
    });
    const suspended = await myTrust(fixture.parentA.userId);
    expect(suspended.trust_score).toBe(150);
    expect(suspended.trust_band).toBe('Suspended');
    const peerSuspended = await peerBand(fixture.peerA.userId, fixture.parentA.userId);
    expect(peerSuspended.trust_band).toBe('Suspended');
  });

  it('peerExposure: peers see band only; cross-school and non-members are denied; score stays hidden', async () => {
    await privileged('fixture: set peer exposure score', async () => {
      await db().query(
        `update public.profiles set trust_score = 92::smallint, admin_suspended = false
         where id = $1::uuid`, [fixture.parentA.userId],
      );
      await db().query(
        `select public.apply_trust_score_delta($1::uuid, $2::uuid, 1::smallint,
          'manual_adjustment'::text, 'trust_live_peer'::text, $3::uuid)`,
        [fixture.parentA.userId, fixture.schoolA, randomUUID()],
      );
    });
    const peer = await peerBand(fixture.peerA.userId, fixture.parentA.userId);
    expect(peer).toEqual({ trust_band: 'Trusted' });
    expect(JSON.stringify(peer)).not.toMatch(/trust_score|"92"|score/i);

    await denied(() => peerBand(fixture.parentB.userId, fixture.parentA.userId), ['42501']);
    await denied(() => peerBand(fixture.moderatorB.userId, fixture.parentA.userId), ['42501']);
    await denied(() => peerBand(fixture.pendingA.userId, fixture.parentA.userId), ['42501']);
    await denied(() => peerBand(fixture.noMembershipUser, fixture.parentA.userId), ['42501']);
    await denied(() => peerBand(fixture.parentA.userId, fixture.parentA.userId), ['22023']);

    const peerProfiles = await authenticated<{ trust_score: number | null }>(
      fixture.peerA.userId,
      `select trust_score from public.profiles where id = $1::uuid`,
      [fixture.parentA.userId],
    );
    expect(peerProfiles).toEqual([]);

    const peerEvents = await authenticated<{ id: string }>(
      fixture.peerA.userId,
      `select id from public.trust_score_events where subject_user_id = $1::uuid`,
      [fixture.parentA.userId],
    );
    expect(peerEvents).toEqual([]);
    const crossEvents = await authenticated<{ id: string }>(
      fixture.parentB.userId,
      `select id from public.trust_score_events`,
    );
    expect(crossEvents).toEqual([]);
  });

  it('trustEventsAppendOnlyAndGrants: authenticated cannot mutate history or call apply directly', async () => {
    const source = randomUUID();
    await applyDelta(fixture.parentA, 5, 'completed_trip', source);
    const eventRows = await privileged('read-back: trust event id', async () => {
      const { rows } = await db().query<{ id: string }>(
        `select id from public.trust_score_events
         where subject_user_id = $1::uuid and source_entity_id = $2::uuid`,
        [fixture.parentA.userId, source],
      );
      return rows;
    });
    expect(eventRows).toHaveLength(1);

    await denied(() => authenticated(fixture.parentA.userId,
      `update public.trust_score_events set delta = 1 where id = $1::uuid`,
      [eventRows[0].id]), ['55000', '42501']);
    await denied(() => authenticated(fixture.parentA.userId,
      `delete from public.trust_score_events where id = $1::uuid`,
      [eventRows[0].id]), ['55000', '42501']);
    await denied(() => authenticated(fixture.parentA.userId,
      `insert into public.trust_score_events
        (school_id, subject_user_id, delta, score_after, reason_code,
         source_entity_type, source_entity_id)
       values ($1, $2, 1, 71, 'completed_trip', 'manual', $3)`,
      [fixture.schoolA, fixture.parentA.userId, randomUUID()]), ['42501']);
    await denied(() => authenticated(fixture.parentA.userId,
      `select public.apply_trust_score_delta($1::uuid, $2::uuid, 1::smallint,
        'completed_trip'::text, 'browser'::text, $3::uuid)`,
      [fixture.parentA.userId, fixture.schoolA, randomUUID()]), ['42501']);
  });

  it('trustAllowlistAndSearchPath: get_my_trust and get_peer_trust_band are allowlisted with pg_catalog search_path', async () => {
    const allowlist = JSON.parse(
      await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8'),
    ) as { authenticated: Array<{ name: string }>; internal: Array<{ name: string }> };
    const authNames = allowlist.authenticated.map((entry) => entry.name);
    const internalNames = allowlist.internal.map((entry) => entry.name);
    expect(authNames).toContain('get_my_trust');
    expect(authNames).toContain('get_peer_trust_band');
    expect(authNames).not.toContain('apply_trust_score_delta');
    expect(authNames).not.toContain('trust_band_for_score');
    expect(authNames).not.toContain('trust_band_for_user');
    expect(internalNames).toContain('apply_trust_score_delta');
    expect(internalNames).toContain('guard_trust_score_events');
    expect(internalNames).toContain('trust_band_for_user');

    const rows = await privileged('read-back: trust function search_path', async () => {
      return (await db().query<{
        proname: string; search_path: string | null; prosecdef: boolean;
      }>(`
        select p.proname,
          (select option_value from pg_catalog.unnest(p.proconfig) cfg(option)
             join lateral (select split_part(cfg.option, '=', 1) as option_name,
                                  substr(cfg.option, position('=' in cfg.option) + 1) as option_value
                          ) parsed on true
           where parsed.option_name = 'search_path' limit 1) as search_path,
          p.prosecdef
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('get_my_trust', 'get_peer_trust_band', 'apply_trust_score_delta',
                            'trust_band_for_score', 'trust_band_for_user', 'guard_trust_score_events')
      `)).rows;
    });
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.search_path).toBe('pg_catalog');
      if (row.proname !== 'trust_band_for_score') {
        expect(row.prosecdef).toBe(true);
      }
    }

    const grants = await privileged('read-back: trust execute grants', async () => {
      return (await db().query<{ proname: string; grantee: string }>(`
        select p.proname, r.rolname as grantee
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          on true
        join pg_catalog.pg_roles r on r.oid = acl.grantee
        where n.nspname = 'public'
          and p.proname in ('get_my_trust', 'get_peer_trust_band', 'apply_trust_score_delta')
          and acl.privilege_type = 'EXECUTE'
          and r.rolname in ('anon', 'authenticated', 'public')
        order by 1, 2
      `)).rows;
    });
    expect(grants).toEqual([
      { proname: 'get_my_trust', grantee: 'authenticated' },
      { proname: 'get_peer_trust_band', grantee: 'authenticated' },
    ]);
  });

  it('trustNoMoneyFields: trust schema and RPC payloads never introduce amount/price/currency', async () => {
    const columns = await privileged('read-back: trust_score_events columns', async () => {
      return (await db().query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'trust_score_events'
        order by ordinal_position
      `)).rows.map((row) => row.column_name);
    });
    expect(columns.some((name) => /amount|price|currency|money|fee|payment|balance/i.test(name)))
      .toBe(false);
    const mine = await myTrust(fixture.parentA.userId);
    expect(JSON.stringify(mine)).not.toMatch(/amount|price|currency|money|fee|payment/i);
    const peer = await peerBand(fixture.peerA.userId, fixture.parentA.userId);
    expect(JSON.stringify(peer)).not.toMatch(/amount|price|currency|money|fee|payment/i);
  });
});
