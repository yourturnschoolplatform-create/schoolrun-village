import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testDatabaseUrl = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
const describeLive = testDatabaseUrl ? describe : describe.skip;

const schoolNorth = '10000000-0000-0000-0000-000000000001';
const schoolSouth = '10000000-0000-0000-0000-000000000002';
const parentNorth = '20000000-0000-0000-0000-000000000001';
const parentSouth = '20000000-0000-0000-0000-000000000002';
const moderatorNorth = '20000000-0000-0000-0000-000000000003';
const admin = '20000000-0000-0000-0000-000000000004';
const moderatorSouth = '20000000-0000-0000-0000-000000000005';
const northSwap = '70000000-0000-0000-0000-000000000001';

/**
 * The direct connection is privileged only for isolated schema/fixture setup.
 * Every assertion changes to the non-superuser `authenticated` role, enables
 * row_security, and supplies synthetic request.jwt.claim values before querying.
 */
describeLive('live two-school Supabase RLS harness', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    const authUsers = [
      [parentNorth, 'yourturn_test_north_parent@example.invalid'],
      [parentSouth, 'yourturn_test_south_parent@example.invalid'],
      ['20000000-0000-0000-0000-000000000003', 'yourturn_test_north_moderator@example.invalid'],
      [admin, 'yourturn_test_admin@example.invalid'],
      [moderatorSouth, 'yourturn_test_south_moderator@example.invalid'],
    ];
    for (const [id, email] of authUsers) {
      await client.query(
        `insert into auth.users (
          instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at
        ) values (
          '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
          '$2a$10$yourturntestharnesshashonly0000000000000000000000000000000', now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
        ) on conflict (id) do update set email_confirmed_at = excluded.email_confirmed_at`,
        [id, email],
      );
    }
    await client.query(await readFile(resolve('db/fixtures/two-school.sql'), 'utf8'));
    await client.query(`insert into public.safety_declarations (membership_id, parent_id, school_id, declaration_version_id, licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      select m.id, m.user_id, m.school_id, v.id, true, true, true, true
      from public.school_memberships m join public.safety_declaration_versions v on v.school_id = m.school_id and v.is_published
      where m.user_id = $1 on conflict do nothing`, [moderatorNorth]);
    await client.query(`insert into public.swap_proposals (id, school_id, proposer_id, recipient_id, status, expires_at)
      values ($1, $2, $3, '20000000-0000-0000-0000-000000000003', 'proposed', now() + interval '24 hours') on conflict (id) do nothing`, [northSwap, schoolNorth, parentNorth]);
    await client.query(`insert into public.match_blocks (school_id, blocker_id, blocked_id)
      values ($1, $2, '20000000-0000-0000-0000-000000000003') on conflict do nothing`, [schoolNorth, parentNorth]);
    await client.query(`insert into public.swap_proposals (id, school_id, proposer_id, recipient_id, status, proposed_at, expires_at) values
      ('70000000-0000-0000-0000-000000000010', $1, $2, '20000000-0000-0000-0000-000000000003', 'proposed', now()-interval '2 hours', now()-interval '1 hour'),
      ('70000000-0000-0000-0000-000000000011', $1, $2, '20000000-0000-0000-0000-000000000003', 'proposed', now(), now()+interval '1 hour'),
      ('70000000-0000-0000-0000-000000000012', $1, '20000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004', 'proposed', now()-interval '2 hours', now()-interval '1 hour') on conflict (id) do nothing`, [schoolNorth, parentNorth]);
  });

  afterAll(async () => { await client.end(); });

  async function asAuthenticated<T extends QueryResultRow>(userId: string, query: string, values: unknown[] = []): Promise<T[]> {
    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      await client.query('set local row_security = on');
      await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      const identity = await client.query<{ current_role: string; row_security: string; is_superuser: boolean }>(`
        select current_user as current_role,
          current_setting('row_security') as row_security,
          (select rolsuper from pg_roles where rolname = current_user) as is_superuser
      `);
      const role = identity.rows[0];
      if (role?.current_role !== 'authenticated' || role.row_security !== 'on' || role.is_superuser) {
        throw new Error('Live RLS assertion was not running as the non-privileged authenticated role.');
      }
      const result = await client.query<T>(query, values);
      await client.query('rollback');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  it('blocks School B parent direct reads of School A school and configuration data', async () => {
    const schools = await asAuthenticated<{ id: string }>(parentSouth, 'select id from public.schools where id = $1', [schoolNorth]);
    const configs = await asAuthenticated<{ school_id: string }>(parentSouth, 'select school_id from public.school_configs where school_id = $1', [schoolNorth]);
    expect(schools).toEqual([]);
    expect(configs).toEqual([]);
  });

  it('blocks School B parent direct reads of School A child data', async () => {
    const children = await asAuthenticated<{ nickname: string }>(parentSouth, 'select nickname from public.child_profiles where parent_id = $1', [parentNorth]);
    expect(children).toEqual([]);
  });

  it('allows School B moderator own-school queue scope but blocks School A memberships', async () => {
    const ownSchool = await asAuthenticated<{ school_id: string }>(moderatorSouth, 'select school_id from public.school_memberships where school_id = $1', [schoolSouth]);
    const otherSchool = await asAuthenticated<{ school_id: string }>(moderatorSouth, 'select school_id from public.school_memberships where school_id = $1', [schoolNorth]);
    expect(ownSchool.length).toBeGreaterThan(0);
    expect(otherSchool).toEqual([]);
  });

  it('blocks School B users and moderators from School A-only safety declaration versions', async () => {
    const parentRows = await asAuthenticated<{ school_id: string }>(parentSouth, 'select school_id from public.safety_declaration_versions where school_id = $1', [schoolNorth]);
    const moderatorRows = await asAuthenticated<{ school_id: string }>(moderatorSouth, 'select school_id from public.safety_declaration_versions where school_id = $1', [schoolNorth]);
    expect(parentRows).toEqual([]);
    expect(moderatorRows).toEqual([]);
  });

  it('blocks School B parent and moderator reads of School A calendar, patterns, instances, households and cancellation events', async () => {
    const parentCalendar = await asAuthenticated<{ id: string }>(parentSouth, 'select id from public.school_calendar_periods where school_id = $1', [schoolNorth]);
    const moderatorCalendar = await asAuthenticated<{ id: string }>(moderatorSouth, 'select id from public.school_calendar_periods where school_id = $1', [schoolNorth]);
    const parentPatterns = await asAuthenticated<{ id: string }>(parentSouth, 'select id from public.availability_patterns where school_id = $1', [schoolNorth]);
    const moderatorInstances = await asAuthenticated<{ id: string }>(moderatorSouth, 'select id from public.availability_instances where school_id = $1', [schoolNorth]);
    const householdLinks = await asAuthenticated<{ id: string }>(parentSouth, 'select id from public.household_links where school_id = $1', [schoolNorth]);
    const cancellationEvents = await asAuthenticated<{ id: string }>(moderatorSouth, 'select id from public.schedule_cancellation_events where school_id = $1', [schoolNorth]);
    expect(parentCalendar).toEqual([]);
    expect(moderatorCalendar).toEqual([]);
    expect(parentPatterns).toEqual([]);
    expect(moderatorInstances).toEqual([]);
    expect(householdLinks).toEqual([]);
    expect(cancellationEvents).toEqual([]);
  });

  it('blocks School B parent and moderator mutation attempts against School A Day 3 data', async () => {
    const parentCalendarMutation = await asAuthenticated<{ id: string }>(parentSouth, "update public.school_calendar_periods set label = 'blocked' where school_id = $1 returning id", [schoolNorth]);
    const moderatorCalendarMutation = await asAuthenticated<{ id: string }>(moderatorSouth, "update public.school_calendar_periods set label = 'blocked' where school_id = $1 returning id", [schoolNorth]);
    expect(parentCalendarMutation).toEqual([]);
    expect(moderatorCalendarMutation).toEqual([]);
    await expect(asAuthenticated(parentSouth, "update public.availability_patterns set capacity = 8 where school_id = $1 returning id", [schoolNorth])).rejects.toThrow();
    await expect(asAuthenticated(moderatorSouth, "update public.availability_instances set status = 'cancelled' where school_id = $1 returning id", [schoolNorth])).rejects.toThrow();
    await expect(asAuthenticated(parentSouth, "update public.household_links set status = 'cancelled' where school_id = $1 returning id", [schoolNorth])).rejects.toThrow();
    await expect(asAuthenticated(moderatorSouth, "insert into public.schedule_cancellation_events (school_id, owner_id, pattern_id, instance_id, service_date, scope) values ($1, $2, '40000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '2026-04-06', 'instance')", [schoolNorth, moderatorSouth])).rejects.toThrow();
  });

  it('blocks School B parent and moderator reads and writes of School A proposals, legs and blocks', async () => {
    for (const actor of [parentSouth, moderatorSouth]) {
      expect(await asAuthenticated<{ id: string }>(actor, 'select id from public.swap_proposals where id = $1', [northSwap])).toEqual([]);
      expect(await asAuthenticated<{ id: string }>(actor, 'select id from public.swap_legs where school_id = $1', [schoolNorth])).toEqual([]);
      expect(await asAuthenticated<{ id: string }>(actor, 'select id from public.match_blocks where school_id = $1', [schoolNorth])).toEqual([]);
      await expect(asAuthenticated(actor, "update public.swap_proposals set status = 'withdrawn' where id = $1 returning id", [northSwap])).rejects.toThrow();
      await expect(asAuthenticated(actor, "insert into public.match_blocks (school_id, blocker_id, blocked_id) values ($1, $2, $3)", [schoolNorth, actor, parentNorth])).rejects.toThrow();
    }
  });

  it('does not expose household status to a third party or allow public internal expansion RPCs', async () => {
    const relationship = await asAuthenticated<{ same_household: boolean }>(parentSouth, 'select public.is_same_household($1, $2) as same_household', [parentNorth, '20000000-0000-0000-0000-000000000003']);
    expect(relationship).toEqual([{ same_household: false }]);
    await expect(asAuthenticated(parentSouth, "select public.expand_availability_pattern('40000000-0000-0000-0000-000000000001')")).rejects.toThrow();
  });

  it('denies anon execute on every public function and every public table privilege', async () => {
    const functionPrivileges = await client.query<{ allowed: boolean }>(`
      select coalesce(bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')), false) as allowed
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    `);
    const tablePrivileges = await client.query<{ allowed: boolean }>(`
      select coalesce(bool_or(has_table_privilege('anon', quote_ident(schemaname)||'.'||quote_ident(tablename), 'SELECT,INSERT,UPDATE,DELETE')), false) as allowed
      from pg_tables where schemaname = 'public'
    `);
    expect(functionPrivileges.rows[0]?.allowed).toBe(false);
    expect(tablePrivileges.rows[0]?.allowed).toBe(false);
  });

  it('requires a current school-specific declaration rather than accepting an older global declaration', async () => {
    const schoolConfig = await asAuthenticated<{ school_id: string }>(parentNorth, 'select school_id from public.school_configs where school_id = $1', [schoolNorth]);
    expect(schoolConfig).toEqual([]);
  });

  it('denies direct analytics writes and invite code/hash queries to browser-authenticated users', async () => {
    await expect(asAuthenticated(parentSouth, "insert into public.analytics_events (actor_id, event_name) values (current_setting('request.jwt.claim.sub')::uuid, 'signed_up') returning id")).rejects.toThrow();
    await expect(asAuthenticated(parentSouth, 'select id from public.school_invite_codes')).rejects.toThrow();
  });

  it('denies School B moderator direct membership mutation outside the audited review RPC', async () => {
    await expect(asAuthenticated(
      moderatorSouth,
      "update public.school_memberships set status = 'rejected' where school_id = $1 returning id",
      [schoolSouth],
    )).rejects.toThrow();
  });

  it('C1 creates school invitations only for the intended moderator or admin and school scope', async () => {
    const northModerator = await asAuthenticated<{ invitation_id: string }>(moderatorNorth, 'select invitation_id from public.create_school_invitation($1)', [schoolNorth]);
    expect(northModerator).toHaveLength(1);
    await expect(asAuthenticated(parentNorth, 'select invitation_id from public.create_school_invitation($1)', [schoolNorth])).rejects.toThrow();
    await expect(asAuthenticated(moderatorNorth, 'select invitation_id from public.create_school_invitation($1)', [schoolSouth])).rejects.toThrow();
    await expect(asAuthenticated(moderatorSouth, 'select invitation_id from public.create_school_invitation($1)', [schoolNorth])).rejects.toThrow();
    const administrator = await asAuthenticated<{ invitation_id: string }>(admin, 'select invitation_id from public.create_school_invitation($1)', [schoolNorth]);
    expect(administrator).toHaveLength(1);
  });

  it('C3 expires only the caller own expired proposal with privileged read-back', async () => {
    await client.query('begin');
    try {
      await client.query(`update public.swap_proposals set
        proposer_id = case id
          when '70000000-0000-0000-0000-000000000012' then '20000000-0000-0000-0000-000000000003'::uuid
          else $1::uuid end,
        recipient_id = case id
          when '70000000-0000-0000-0000-000000000012' then '20000000-0000-0000-0000-000000000004'::uuid
          else '20000000-0000-0000-0000-000000000003'::uuid end,
        status = 'proposed', accepted_at = null, cancelled_at = null,
        proposed_at = case id
          when '70000000-0000-0000-0000-000000000011' then now()
          else now() - interval '2 hours' end,
        expires_at = case id
          when '70000000-0000-0000-0000-000000000011' then now() + interval '1 hour'
          else now() - interval '1 hour' end,
        updated_at = now()
        where id in (
          '70000000-0000-0000-0000-000000000010',
          '70000000-0000-0000-0000-000000000011',
          '70000000-0000-0000-0000-000000000012'
        )`, [parentNorth]);
      await client.query('set local role authenticated'); await client.query('set local row_security = on');
      await client.query("select set_config('request.jwt.claim.role','authenticated',true)"); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [parentNorth]);
      await client.query('select public.expire_my_swap_proposals()');
      await client.query('reset role');
      const { rows } = await client.query<{ id: string; status: string }>("select id,status from public.swap_proposals where id in ('70000000-0000-0000-0000-000000000010','70000000-0000-0000-0000-000000000011','70000000-0000-0000-0000-000000000012') order by id");
      expect(rows).toEqual([{ id: '70000000-0000-0000-0000-000000000010', status: 'expired' }, { id: '70000000-0000-0000-0000-000000000011', status: 'proposed' }, { id: '70000000-0000-0000-0000-000000000012', status: 'proposed' }]);
    } finally { await client.query('rollback'); }
  });

  it('C4 derives analytics actor and school from auth.uid and denies anon', async () => {
    await client.query('begin');
    try {
      await client.query('set local role authenticated'); await client.query('set local row_security = on');
      await client.query("select set_config('request.jwt.claim.role','authenticated',true)"); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [parentSouth]);
      await client.query('select public.record_email_verified_event()'); await client.query('select public.record_first_match_viewed()');
      await client.query('reset role');
      const { rows } = await client.query<{ event_name: string; actor_id: string; school_id: string | null }>("select event_name,actor_id,school_id from public.analytics_events where actor_id=$1 and event_name in ('email_verified','first_match_viewed') order by event_name", [parentSouth]);
      expect(rows).toEqual([{ event_name: 'email_verified', actor_id: parentSouth, school_id: null }, { event_name: 'first_match_viewed', actor_id: parentSouth, school_id: schoolSouth }]);
      await client.query('set local role anon');
      await expect(client.query('select public.record_first_match_viewed()')).rejects.toThrow();
    } finally { await client.query('rollback'); }
  });

  it('G1 invitation and code RPCs handle valid, invalid, expired and cross-school calls without resolution errors', async () => {
    const asRole = async <T extends QueryResultRow>(user: string, sql: string, values: unknown[] = []) => {
      await client.query('set local role authenticated'); await client.query('set local row_security = on');
      await client.query("select set_config('request.jwt.claim.role','authenticated',true)"); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
      return client.query<T>(sql, values);
    };
    await client.query('begin');
    try {
      const { rows: schoolInvite } = await asRole<{ invitation_token: string }>(moderatorNorth, 'select invitation_token from public.create_school_invitation($1)', [schoolNorth]);
      expect(schoolInvite[0].invitation_token).toMatch(/^[a-f0-9]{48}$/);
      const { rows: opened } = await asRole<{ open_school_invitation: string }>(parentSouth, 'select public.open_school_invitation($1)', [schoolInvite[0].invitation_token]);
      expect(opened[0].open_school_invitation).toBe('opened');
      const { rows: badOpen } = await asRole<{ open_school_invitation: string }>(parentSouth, "select public.open_school_invitation(repeat('0',48))");
      expect(badOpen[0].open_school_invitation).toBe('unavailable');
      await client.query('reset role');
      await client.query("insert into public.school_invitations(school_id,invited_by,token_hash,sent_at,expires_at) values($1,$2,encode(extensions.digest(repeat('e',48),'sha256'),'hex'),now()-interval '8 days',now()-interval '1 day')", [schoolNorth, moderatorNorth]);
      await client.query('savepoint g1_expired_claim');
      try {
        await expect(asRole(parentSouth, "select public.claim_school_invitation(repeat('e',48))")).rejects.toThrow();
      } finally {
        await client.query('rollback to savepoint g1_expired_claim');
        await client.query('release savepoint g1_expired_claim');
      }
      const { rows: householdToken } = await asRole<{ create_household_link_invitation: string }>(moderatorNorth, 'select public.create_household_link_invitation()');
      expect(householdToken[0].create_household_link_invitation).toMatch(/^[a-f0-9]{48}$/);
      await client.query('savepoint g1_cross_claim');
      try {
        await expect(asRole(parentSouth, 'select public.claim_household_link_invitation($1)', [householdToken[0].create_household_link_invitation])).rejects.toThrow();
      } finally {
        await client.query('rollback to savepoint g1_cross_claim');
        await client.query('release savepoint g1_cross_claim');
      }
      const badCode = await asRole<{ redeem_school_invite_code: string }>(parentSouth, "select public.redeem_school_invite_code($1,'invalid-code')", [schoolNorth]);
      expect(badCode.rows[0].redeem_school_invite_code).toBe('invalid');
    } finally { await client.query('rollback'); }
  });

  it('leaves published trust policy unchanged after authenticated mutation attempt', async () => {
    const before = await client.query<{ definition: unknown; published_at: string }>("select definition, published_at from public.trust_policy_versions where school_id is null and version = 99");
    let rows: unknown[] = [];
    try { rows = await asAuthenticated(admin, "update public.trust_policy_versions set definition = '{}'::jsonb where school_id is null and version = 99 returning definition"); } catch { rows = []; }
    const after = await client.query<{ definition: unknown; published_at: string }>("select definition, published_at from public.trust_policy_versions where school_id is null and version = 99");
    expect(rows).toEqual([]);
    expect(after.rows).toEqual(before.rows);
  });
});

if (!testDatabaseUrl) {
  describe('live two-school Supabase RLS harness configuration', () => {
    it('reports the dedicated test database requirement instead of simulating a live RLS pass', () => {
      expect(testDatabaseUrl).toBeUndefined();
    });
  });
}
