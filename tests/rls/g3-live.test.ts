import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;

type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string;
  schoolB: string;
  moderatorA: Member;
  parentA: Member;
  parentA2: Member;
  parentB: Member;
  parentB2: Member;
  joiner: string;
  joiner2: string;
  rater: string;
};

describe('G3 invitation scope expiry and analytics attribution', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let fixture: Fixture;
  let caseSavepoint = '';
  let savepointNumber = 0;

  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    if (!client) throw new Error('G3 live test connection is not initialized.');
    try { return await client.query<T>(sql, values); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
      throw Object.assign(new Error(`G3 database operation failed (SQLSTATE ${code}); details suppressed.`), { code });
    }
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^fixture: [a-z0-9 ._-]+$/i.test(label)) throw new Error('Privileged operations require a fixture label.');
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
    const identity = await query<{
      role: string; row_security: string; rolsuper: boolean; rolbypassrls: boolean; correct_subject: boolean;
    }>(`select current_user::text as role, current_setting('row_security') as row_security,
      r.rolsuper, r.rolbypassrls, auth.uid() = $1::uuid as correct_subject
      from pg_catalog.pg_roles r where r.rolname = current_user`, [userId]);
    expect(identity.rows).toEqual([{
      role: 'authenticated', row_security: 'on', rolsuper: false, rolbypassrls: false, correct_subject: true,
    }]);
    return (await query<T>(sql, values)).rows;
  }

  async function anonymous(): Promise<void> {
    await query('set local role anon; set local row_security = on');
    await query(`select set_config('request.jwt.claims', '{"role":"anon"}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`);
    const identity = await query(`select current_user::text as role, current_setting('row_security') as row_security,
      rolsuper, rolbypassrls from pg_catalog.pg_roles where rolname = current_user`);
    expect(identity.rows).toEqual([{ role: 'anon', row_security: 'on', rolsuper: false, rolbypassrls: false }]);
  }

  async function denied(action: () => Promise<unknown>, codes: string[]): Promise<string> {
    const name = `g3_denied_${++savepointNumber}`;
    await query(`savepoint ${name}`);
    let code: string | null = null;
    try {
      try { await action(); }
      catch (error) { code = (error as { code?: string }).code ?? 'non-database-error'; }
    } finally {
      await query(`rollback to savepoint ${name}`);
      await query(`release savepoint ${name}`);
    }
    expect(code).not.toBeNull();
    expect(codes).toContain(code);
    return code ?? '';
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({ schoolId, userId: randomUUID(), membershipId: randomUUID() });
    const moderatorA = member(schoolA);
    const parentA = member(schoolA);
    const parentA2 = member(schoolA);
    const parentB = member(schoolB);
    const parentB2 = member(schoolB);
    const joiner = randomUUID();
    const joiner2 = randomUUID();
    const rater = randomUUID();
    const members = [moderatorA, parentA, parentA2, parentB, parentB2];
    const userIds = [...members.map((item) => item.userId), joiner, joiner2, rater];
    await query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'yourturn_test_ G3 A', 'Australia/Melbourne'),
             ($3, $4, 'yourturn_test_ G3 B', 'Australia/Sydney')`,
    [schoolA, `g3a-${schoolA}`, schoolB, `g3b-${schoolB}`]);
    await query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated', 'g3-' || id::text || '@example.invalid', now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"yourturn_test_ G3"}'::jsonb, now(), now()
      from unnest($1::uuid[]) u(id)`, [userIds]);
    await query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, 'verified'::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[]) m(id, school_id, user_id)`, [
      members.map((item) => item.membershipId),
      members.map((item) => item.schoolId),
      members.map((item) => item.userId),
    ]);
    await query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`, [randomUUID(), moderatorA.userId, schoolA]);
    await query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'G3 A', 'Synthetic safety declaration A', true, now()),
             ($3, $4, 1, 'G3 B', 'Synthetic safety declaration B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    await query(`insert into public.safety_declarations
      (id, membership_id, parent_id, school_id, declaration_version_id,
       licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      select id, membership_id, parent_id, school_id, declaration_id, true, true, true, true
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[])
        s(id, membership_id, parent_id, school_id, declaration_id)`, [
      members.map(() => randomUUID()),
      members.map((item) => item.membershipId),
      members.map((item) => item.userId),
      members.map((item) => item.schoolId),
      members.map((item) => item.schoolId === schoolA ? declarationA : declarationB),
    ]);
    return { schoolA, schoolB, moderatorA, parentA, parentA2, parentB, parentB2, joiner, joiner2, rater };
  }

  beforeAll(async () => {
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for G3 live tests.');
    client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
    try { await client.connect(); }
    catch { throw new Error('Unable to connect to the dedicated RLS test database; connection details suppressed.'); }
    await query('begin');
    await query(`set local timezone = 'UTC'; set local row_security = on;
      set local statement_timeout = '20s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: synthetic g3 principals', seed);
  }, LIVE_TIMEOUT);

  beforeEach(async () => {
    caseSavepoint = `g3_case_${++savepointNumber}`;
    await query(`savepoint ${caseSavepoint}`);
  });

  afterEach(async () => {
    if (caseSavepoint) {
      await query(`rollback to savepoint ${caseSavepoint}`);
      await query(`release savepoint ${caseSavepoint}`);
    }
  });

  afterAll(async () => {
    try { if (client) await client.query('rollback'); }
    finally { if (client) await client.end(); client = undefined; }
  }, LIVE_TIMEOUT);

  it('school invitation token is at least 16 bytes and only its hash is stored', async () => {
    const created = await authenticated<{ invitation_token: string }>(
      fixture.moderatorA.userId,
      'select invitation_token from public.create_school_invitation($1)',
      [fixture.schoolA],
    );
    if (created.length !== 1) throw new Error('school invitation returned no token');
    const token = created[0].invitation_token;
    expect(token.length).toBe(48);
    const stored = await privileged('fixture: read school invitation hash', () => query<{
      nbytes: number; hashed: boolean; not_plaintext: boolean; leaks: number; token_columns: number;
    }>(`select octet_length(decode($1, 'hex')) as nbytes,
        i.token_hash = encode(extensions.digest($1, 'sha256'), 'hex') as hashed,
        i.token_hash <> $1 as not_plaintext,
        (select count(*)::int from public.audit_logs a
          where a.actor_id = $2 and a.payload::text like '%' || $1 || '%') as leaks,
        (select count(*)::int from pg_catalog.pg_attribute a
          join pg_catalog.pg_class c on c.oid = a.attrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
            and c.relkind = 'r' and a.attname ~ '(^|_)token$') as token_columns
      from public.school_invitations i
      where i.invited_by = $2 and i.school_id = $3`,
    [token, fixture.moderatorA.userId, fixture.schoolA]));
    expect(stored.rows).toEqual([{ nbytes: 24, hashed: true, not_plaintext: true, leaks: 0, token_columns: 0 }]);
    expect(stored.rows[0].nbytes).toBeGreaterThanOrEqual(16);
  });

  it('household invitation token is at least 16 bytes and only its hash is stored', async () => {
    const created = await authenticated<{ create_household_link_invitation: string }>(
      fixture.parentA.userId, 'select public.create_household_link_invitation()');
    if (created.length !== 1) throw new Error('household invitation returned no token');
    const token = created[0].create_household_link_invitation;
    expect(token.length).toBe(48);
    const stored = await privileged('fixture: read household invitation scope', () => query<{
      nbytes: number; hashed: boolean; not_plaintext: boolean; school_id: string; leaks: number;
    }>(`select octet_length(decode($1, 'hex')) as nbytes,
        i.token_hash = encode(extensions.digest($1, 'sha256'), 'hex') as hashed,
        i.token_hash <> $1 as not_plaintext,
        i.school_id::text as school_id,
        (select count(*)::int from public.audit_logs a
          where a.actor_id = $2 and a.payload::text like '%' || $1 || '%') as leaks
      from public.household_link_invitations i
      where i.invited_by = $2 and i.token_hash = encode(extensions.digest($1, 'sha256'), 'hex')`,
    [token, fixture.parentA.userId]));
    expect(stored.rows).toEqual([{
      nbytes: 24, hashed: true, not_plaintext: true, school_id: fixture.schoolA, leaks: 0,
    }]);
  });

  it('expired school invitation and expired invite code are rejected', async () => {
    const token = 'a'.repeat(48);
    await privileged('fixture: expired school invitation', () => query(
      `insert into public.school_invitations (school_id, invited_by, token_hash, status, sent_at, expires_at)
       values ($1, $2, encode(extensions.digest($3, 'sha256'), 'hex'), 'sent', now() - interval '2 days', now() - interval '1 day')`,
      [fixture.schoolA, fixture.moderatorA.userId, token],
    ));
    const opened = await authenticated<{ open_school_invitation: string }>(
      fixture.joiner, 'select public.open_school_invitation($1)', [token]);
    expect(opened).toEqual([{ open_school_invitation: 'unavailable' }]);
    await privileged('fixture: expired invite code', () => query(
      `insert into public.school_invite_codes (school_id, code_hash, label, created_at, expires_at, max_uses)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now() - interval '2 days', now() - interval '1 day', 5)`,
      [fixture.schoolA, 'G3EXPIREDCODE', `g3-expired-${randomUUID()}`],
    ));
    const redeemed = await authenticated<{ status: string }>(
      fixture.joiner, 'select public.redeem_school_invite_code($1, $2) as status', [fixture.schoolA, 'G3EXPIREDCODE']);
    expect(redeemed).toEqual([{ status: 'invalid' }]);
    const membership = await privileged('fixture: confirm expired code wrote no membership', () => query(
      'select id from public.school_memberships where user_id = $1::uuid and school_id = $2::uuid',
      [fixture.joiner, fixture.schoolA],
    ));
    expect(membership.rows).toEqual([]);
  });

  it('invite code use limit stops a second redemption', async () => {
    const label = `g3-once-${randomUUID()}`;
    await privileged('fixture: active single-use code', () => query(
      `insert into public.school_invite_codes (school_id, code_hash, label, expires_at, max_uses)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3, now() + interval '7 days', 1)`,
      [fixture.schoolA, 'G3ONCECODE', label],
    ));
    const first = await authenticated<{ status: string }>(
      fixture.joiner, 'select public.redeem_school_invite_code($1, $2) as status', [fixture.schoolA, 'G3ONCECODE']);
    expect(first).toEqual([{ status: 'pending' }]);
    const second = await authenticated<{ status: string }>(
      fixture.joiner2, 'select public.redeem_school_invite_code($1, $2) as status', [fixture.schoolA, 'G3ONCECODE']);
    expect(second).toEqual([{ status: 'invalid' }]);
    const usage = await privileged('fixture: read invite use count', () => query<{ uses: number; memberships: number }>(
      `select c.use_count as uses,
        (select count(*)::int from public.school_memberships m where m.school_id = $1::uuid and m.user_id = any($2::uuid[])) as memberships
       from public.school_invite_codes c where c.label = $3`,
      [fixture.schoolA, [fixture.joiner, fixture.joiner2], label],
    ));
    expect(usage.rows).toEqual([{ uses: 1, memberships: 1 }]);
  });

  it('five failed attempts are kept and the next attempt is rate limited', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await authenticated<{ status: string }>(
        fixture.rater, 'select public.redeem_school_invite_code($1, $2) as status', [fixture.schoolA, 'G3BADCODE']);
      expect(result).toEqual([{ status: 'invalid' }]);
    }
    const counted = await privileged('fixture: read attempt count', () => query<{ recent: number }>(
      `select count(*)::int as recent from public.school_invite_attempts
       where user_id = $1::uuid and attempted_at > now() - interval '15 minutes'`,
      [fixture.rater],
    ));
    expect(counted.rows).toEqual([{ recent: 5 }]);
    const code = await denied(
      () => authenticated(fixture.rater, 'select public.redeem_school_invite_code($1, $2)', [fixture.schoolA, 'G3BADCODE']),
      ['P0001'],
    );
    expect(code).toBe('P0001');
  });

  it('attempts older than 15 minutes do not count toward the rate limit', async () => {
    await privileged('fixture: seed aged attempts', () => query(
      `insert into public.school_invite_attempts (user_id, attempted_at)
       select $1::uuid, now() - interval '16 minutes' from generate_series(1, 5)`,
      [fixture.joiner2],
    ));
    const result = await authenticated<{ status: string }>(
      fixture.joiner2, 'select public.redeem_school_invite_code($1, $2) as status', [fixture.schoolA, 'G3OLDCODE']);
    expect(result).toEqual([{ status: 'invalid' }]);
  });

  it('C2 household invitation is scoped to the caller school', async () => {
    const code = await denied(
      () => authenticated(fixture.joiner, 'select public.create_household_link_invitation()'),
      ['42501'],
    );
    expect(code).toBe('42501');
    const created = await authenticated<{ create_household_link_invitation: string }>(
      fixture.parentA.userId, 'select public.create_household_link_invitation()');
    const other = await authenticated<{ create_household_link_invitation: string }>(
      fixture.parentB.userId, 'select public.create_household_link_invitation()');
    const rows = await privileged('fixture: read household invitation scope', () => query<{ invited_by: string; school_id: string }>(
      `select invited_by::text, school_id::text from public.household_link_invitations
       where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')
          or token_hash = encode(extensions.digest($2, 'sha256'), 'hex')
       order by school_id`,
      [created[0].create_household_link_invitation, other[0].create_household_link_invitation],
    ));
    expect([...rows.rows].sort((left, right) => left.school_id.localeCompare(right.school_id))).toEqual([
      { invited_by: fixture.parentA.userId, school_id: fixture.schoolA },
      { invited_by: fixture.parentB.userId, school_id: fixture.schoolB },
    ].sort((left, right) => left.school_id.localeCompare(right.school_id)));
  });

  it('C2 a school B user cannot claim a school A household invitation', async () => {
    const created = await authenticated<{ create_household_link_invitation: string }>(
      fixture.parentA.userId, 'select public.create_household_link_invitation()');
    const code = await denied(
      () => authenticated(fixture.parentB.userId, 'select public.claim_household_link_invitation($1)', [created[0].create_household_link_invitation]),
      ['P0002'],
    );
    expect(code).toBe('P0002');
    const claimed = await authenticated<{ claim_household_link_invitation: string }>(
      fixture.parentA2.userId, 'select public.claim_household_link_invitation($1)', [created[0].create_household_link_invitation]);
    expect(claimed[0].claim_household_link_invitation).toMatch(/^[0-9a-f-]{36}$/);
    const links = await privileged('fixture: confirm cross-school claim wrote nothing', () => query<{ school_id: string; status: string; outsider: number }>(
      `select l.school_id::text, l.status::text,
        (select count(*)::int from public.household_links x
          where x.school_id = $1::uuid and (x.first_parent_id = $2::uuid or x.second_parent_id = $2::uuid)) as outsider
       from public.household_links l where l.id = $3::uuid`,
      [fixture.schoolA, fixture.parentB.userId, claimed[0].claim_household_link_invitation],
    ));
    expect(links.rows).toEqual([{ school_id: fixture.schoolA, status: 'confirmed', outsider: 0 }]);
  });

  it('C3 expire_my_swap_proposals changes only the caller expired proposals', async () => {
    const ownExpired = randomUUID();
    const ownAsRecipient = randomUUID();
    const ownFuture = randomUUID();
    const otherExpired = randomUUID();
    const otherSchool = randomUUID();
    const ownAccepted = randomUUID();
    await privileged('fixture: seed proposal statuses', () => query(
      `insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, expires_at, accepted_at)
       values
        ($1, $7, $8, $9, 'proposed', now() - interval '2 hours', now() - interval '1 hour', null),
        ($2, $7, $9, $8, 'proposed', now() - interval '2 hours', now() - interval '1 hour', null),
        ($3, $7, $8, $9, 'proposed', now(), now() + interval '2 days', null),
        ($4, $7, $9, $10, 'proposed', now() - interval '2 hours', now() - interval '1 hour', null),
        ($5, $11, $12, $13, 'proposed', now() - interval '2 hours', now() - interval '1 hour', null),
        ($6, $7, $8, $9, 'accepted', now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours')`,
      [ownExpired, ownAsRecipient, ownFuture, otherExpired, otherSchool, ownAccepted,
        fixture.schoolA, fixture.parentA.userId, fixture.parentA2.userId, fixture.moderatorA.userId,
        fixture.schoolB, fixture.parentB.userId, fixture.parentB2.userId],
    ));
    const changed = await authenticated<{ changed: number }>(
      fixture.parentA.userId, 'select public.expire_my_swap_proposals() as changed');
    expect(changed).toEqual([{ changed: 2 }]);
    const rows = await privileged('fixture: read proposal statuses', () => query<{ id: string; status: string }>(
      `select id::text, status from public.swap_proposals where id = any($1::uuid[]) order by id`,
      [[ownExpired, ownAsRecipient, ownFuture, otherExpired, otherSchool, ownAccepted]],
    ));
    expect([...rows.rows].sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: ownExpired, status: 'expired' },
      { id: ownAsRecipient, status: 'expired' },
      { id: ownFuture, status: 'proposed' },
      { id: otherExpired, status: 'proposed' },
      { id: otherSchool, status: 'proposed' },
      { id: ownAccepted, status: 'accepted' },
    ].sort((left, right) => left.id.localeCompare(right.id)));
  });

  it('C4 analytics actor and school come from auth.uid and anon is denied', async () => {
    await authenticated(fixture.parentA.userId, 'select public.record_email_verified_event()');
    await authenticated(fixture.parentA.userId, 'select public.record_email_verified_event()');
    await authenticated(fixture.parentA.userId, 'select public.record_first_match_viewed()');
    await authenticated(fixture.parentA.userId, 'select public.record_first_match_viewed()');
    await authenticated(fixture.parentB.userId, 'select public.record_first_match_viewed()');
    await authenticated(fixture.joiner, 'select public.record_email_verified_event()');
    await authenticated(fixture.joiner, 'select public.record_first_match_viewed()');
    const events = await privileged('fixture: read analytics events', () => query<{ event_name: string; actor_id: string; school_id: string | null; copies: number }>(
      `select event_name, actor_id::text, school_id::text, count(*)::int as copies
       from public.analytics_events
       where actor_id = any($1::uuid[]) and event_name in ('email_verified', 'first_match_viewed')
       group by event_name, actor_id, school_id
       order by actor_id, event_name`,
      [[fixture.parentA.userId, fixture.parentB.userId, fixture.joiner]],
    ));
    const byActor = new Map<string, typeof events.rows>();
    for (const row of events.rows) {
      const list = byActor.get(row.actor_id) ?? [];
      list.push(row);
      byActor.set(row.actor_id, list);
    }
    expect(byActor.get(fixture.parentA.userId)).toEqual([
      { event_name: 'email_verified', actor_id: fixture.parentA.userId, school_id: null, copies: 1 },
      { event_name: 'first_match_viewed', actor_id: fixture.parentA.userId, school_id: fixture.schoolA, copies: 1 },
    ]);
    expect(byActor.get(fixture.parentB.userId)).toEqual([
      { event_name: 'first_match_viewed', actor_id: fixture.parentB.userId, school_id: fixture.schoolB, copies: 1 },
    ]);
    expect(byActor.get(fixture.joiner)).toEqual([
      { event_name: 'email_verified', actor_id: fixture.joiner, school_id: null, copies: 1 },
    ]);
    expect(events.rows.some((row) => row.actor_id === fixture.parentB.userId && row.school_id === fixture.schoolA)).toBe(false);
    const emailDenied = await denied(() => anonymous().then(() => query('select public.record_email_verified_event()')), ['42501']);
    const matchDenied = await denied(() => anonymous().then(() => query('select public.record_first_match_viewed()')), ['42501']);
    expect(emailDenied).toBe('42501');
    expect(matchDenied).toBe('42501');
  });
});
