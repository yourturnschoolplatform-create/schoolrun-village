import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LIVE_TIMEOUT = 60_000;
const SCOPE = 'swap_partner_and_chosen_backups';
// Synthetic inputs only; compare phones as booleans, never in assertion diffs.
const PHONE_A = '+61400000101';
const PHONE_A_V2 = '+61400000102';
const PHONE_B = '+61400000103';
const syntheticPhones = [PHONE_A, PHONE_A_V2, PHONE_B];
const publicContactTables = [
  'contact_consents', 'contact_consent_backups',
  'swap_cancellation_events', 'swap_contact_notifications',
];
const contactFunctions = [
  'grant_contact_sharing', 'get_shared_contact', 'revoke_contact_sharing',
  'guard_contact_history', 'contact_member_is_active',
];
type Member = { userId: string; membershipId: string; schoolId: string };
type Fixture = {
  schoolA: string; schoolB: string; declarationA: string;
  owner: Member; partner: Member; oldBackup: Member; newBackup: Member;
  unchosen: Member; unrelated: Member; pending: Member; parentB: Member; moderatorB: Member;
  noMembershipUser: string; userIds: string[];
};
type Receipt = {
  id: string; consentVersion: number; policyVersion: number; scope: string;
  grantedAt: string; defaultContactMethod: string;
};
type Swap = { id: string; acceptedAt: Date | null };
type SafeError = Error & { code: string; sensitiveEcho: boolean };

/**
 * Deliberately independent of committed fixtures and legacy UUIDs. The helper
 * design is copied minimally from ledger-live.test.ts: one TLS connection and
 * unconditional ROLLBACK per test, including failed beforeEach setup; synthetic
 * auth.users only; never touch global active consent documents. No DEV URL,
 * commit-capable fixture helper, credentials, raw auth records or phones in logs.
 * Privileged access is labelled fixture/read-back only, never an RLS assertion.
 */
describe('Task 5.2 live consent-gated private contact sharing', { timeout: LIVE_TIMEOUT }, () => {
  let client: Client | undefined;
  let transactionStarted = false;
  let savepointNumber = 0;
  let fixture: Fixture;

  async function query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    if (!client) throw new Error('Contact live test connection is not initialized.');
    try {
      return await client.query<T>(sql, values);
    } catch (error) {
      // pg errors can embed SQL parameters, row details and input values. Retain
      // SQLSTATE and a boolean-only echo signal, not the original error/cause.
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'non-database-error';
      const diagnostic = error instanceof Error ? error.message : '';
      const detail = typeof error === 'object' && error !== null && 'detail' in error
        ? String(error.detail) : '';
      throw Object.assign(new Error(`Contact database operation failed (SQLSTATE ${code}); details suppressed.`), {
        code, sensitiveEcho: syntheticPhones.some((phone) => `${diagnostic} ${detail}`.includes(phone)),
      });
    }
  }

  async function privileged<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (!/^(fixture|read-back): [a-z0-9 ._-]+$/i.test(label)) {
      throw new Error('Privileged actions require a synthetic fixture/read-back label.');
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
    const identity = await query(`select current_role::text as role,
      current_setting('row_security') as row_security, r.rolsuper, r.rolbypassrls,
      auth.uid() = $1::uuid as correct_subject
      from pg_catalog.pg_roles r where r.rolname = current_role`, [userId]);
    expect(identity.rows).toEqual([{
      role: 'authenticated', row_security: 'on', rolsuper: false,
      rolbypassrls: false, correct_subject: true,
    }]);
    return (await query<T>(sql, values)).rows;
  }

  async function anonymous(sql: string, values: unknown[] = []): Promise<QueryResultRow[]> {
    await query('set local role anon; set local row_security = on');
    await query(`select set_config('request.jwt.claims', '{"role":"anon"}', true),
      set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'anon', true)`);
    const identity = await query(`select current_role::text as role,
      current_setting('row_security') as row_security, rolsuper, rolbypassrls,
      auth.uid() is null as no_subject from pg_catalog.pg_roles where rolname = current_role`);
    expect(identity.rows).toEqual([{
      role: 'anon', row_security: 'on', rolsuper: false, rolbypassrls: false, no_subject: true,
    }]);
    return (await query(sql, values)).rows;
  }

  async function isolated<T>(action: () => Promise<T>): Promise<T> {
    const name = `contact_isolated_${++savepointNumber}`;
    await query(`savepoint ${name}`);
    try {
      return await action();
    } finally {
      // Even unexpectedly successful writes and successful leak-scan RPCs vanish.
      await query(`rollback to savepoint ${name}`);
      await query(`release savepoint ${name}`);
    }
  }

  async function denied(action: () => Promise<unknown>, codes = ['42501']): Promise<void> {
    let code: string | null = null;
    let sensitiveEcho = false;
    await isolated(async () => {
      try { await action(); }
      catch (error) {
        code = (error as SafeError).code ?? 'non-database-error';
        sensitiveEcho = (error as SafeError).sensitiveEcho ?? false;
      }
    });
    expect(sensitiveEcho).toBe(false);
    expect(codes).toContain(code);
  }

  function expectPhoneFree(value: unknown): void {
    const serialized = JSON.stringify(value) ?? '';
    expect(syntheticPhones.some((phone) => serialized.includes(phone))).toBe(false);
  }

  async function signMembership(member: Member, declaration: string): Promise<void> {
    await query(`insert into public.safety_declarations
      (id, membership_id, parent_id, school_id, declaration_version_id,
       licence_confirmed, insurance_confirmed, child_restraints_confirmed, pickup_rules_confirmed)
      values ($1, $2, $3, $4, $5, true, true, true, true)`,
    [randomUUID(), member.membershipId, member.userId, member.schoolId, declaration]);
  }

  async function seed(): Promise<Fixture> {
    const schoolA = randomUUID();
    const schoolB = randomUUID();
    const declarationA = randomUUID();
    const declarationB = randomUUID();
    const member = (schoolId: string): Member => ({
      schoolId, userId: randomUUID(), membershipId: randomUUID(),
    });
    const owner = member(schoolA);
    const partner = member(schoolA);
    const oldBackup = member(schoolA);
    const newBackup = member(schoolA);
    const unchosen = member(schoolA);
    const unrelated = member(schoolA);
    const pending = member(schoolA);
    const parentB = member(schoolB);
    const moderatorB = member(schoolB);
    const noMembershipUser = randomUUID();
    const members = [owner, partner, oldBackup, newBackup, unchosen, unrelated, pending, parentB, moderatorB];
    const userIds = [...members.map((m) => m.userId), noMembershipUser];
    await query(`insert into public.schools (id, slug, display_name, timezone)
      values ($1, $2, 'Contact School A', 'Australia/Sydney'),
             ($3, $4, 'Contact School B', 'Australia/Melbourne')`,
    [schoolA, `contact-a-${schoolA}`, schoolB, `contact-b-${schoolB}`]);
    await query(`insert into public.school_configs (school_id, max_backups)
      values ($1, 2), ($2, 2) on conflict (school_id) do update set max_backups = 2`, [schoolA, schoolB]);
    // The profile trigger receives no password or token, only synthetic metadata.
    await query(`insert into auth.users
      (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at)
      select id, 'authenticated', 'authenticated', 'contact-' || id::text || '@example.invalid',
        now(), '{"provider":"email","providers":["email"]}'::jsonb,
        '{"display_name":"Contact Fixture"}'::jsonb, now(), now()
      from unnest($1::uuid[]) u(id)`, [userIds]);
    await query(`insert into public.school_memberships
      (id, school_id, user_id, status, verified_email_at, invite_code_verified_at,
       self_declaration_accepted_at, approved_by, approved_at, created_at)
      select id, school_id, user_id, status::public.school_membership_status,
        now(), now(), now(), user_id, now(), now() - interval '10 days'
      from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])
        m(id, school_id, user_id, status)`, [
      members.map((m) => m.membershipId), members.map((m) => m.schoolId),
      members.map((m) => m.userId), members.map((m) => m === pending ? 'pending_moderator' : 'verified'),
    ]);
    await query(`insert into public.role_assignments
      (id, user_id, school_id, role, code_of_conduct_accepted_at, granted_by)
      values ($1, $2, $3, 'moderator', now(), $2)`, [randomUUID(), moderatorB.userId, schoolB]);
    // READ ONLY against shared active documents; only our own acceptance rows.
    await query(`insert into public.consent_acceptances (user_id, document_id)
      select u.id, d.id from unnest($1::uuid[]) u(id)
      cross join public.consent_documents d where d.is_active`, [userIds]);
    await query(`insert into public.safety_declaration_versions
      (id, school_id, version, title, summary, is_published, published_at)
      values ($1, $2, 1, 'Contact declaration A', 'Synthetic contact safety A', true, now()),
             ($3, $4, 1, 'Contact declaration B', 'Synthetic contact safety B', true, now())`,
    [declarationA, schoolA, declarationB, schoolB]);
    for (const m of members.filter((m) => m !== pending)) {
      await signMembership(m, m.schoolId === schoolA ? declarationA : declarationB);
    }
    return {
      schoolA, schoolB, declarationA, owner, partner, oldBackup, newBackup, unchosen,
      unrelated, pending, parentB, moderatorB, noMembershipUser, userIds,
    };
  }

  async function createSwap(status: 'accepted' | 'proposed' = 'accepted'): Promise<Swap> {
    return privileged('fixture: unique accepted or proposed contact swap', async () => {
      const result = await query<{ id: string; accepted_at: Date | null }>(`insert into public.swap_proposals
        (id, school_id, proposer_id, recipient_id, status, proposed_at, accepted_at, expires_at)
        values ($1, $2, $3, $4, $5, now() - interval '2 days',
          case when $5 = 'accepted' then now() - interval '1 day' else null end,
          now() + interval '1 day') returning id, accepted_at`,
      [randomUUID(), fixture.schoolA, fixture.owner.userId, fixture.partner.userId, status]);
      return { id: result.rows[0].id, acceptedAt: result.rows[0].accepted_at };
    });
  }

  async function grant(
    swap: Swap, actor = fixture.owner, phone = PHONE_A, backups: string[] = [],
  ): Promise<Receipt> {
    const rows = await authenticated<{ receipt: Receipt }>(actor.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text, $3::uuid[]) as receipt',
      [swap.id, phone, backups]);
    expectPhoneFree(rows);
    expect(rows).toHaveLength(1);
    const receipt = rows[0].receipt;
    expect(Object.keys(receipt).sort()).toEqual([
      'id', 'consentVersion', 'policyVersion', 'scope', 'grantedAt', 'defaultContactMethod',
    ].sort());
    expect(receipt).toMatchObject({
      policyVersion: 1, scope: SCOPE, defaultContactMethod: 'email_relay',
    });
    expect(/^[0-9a-f-]{36}$/i.test(receipt.id)).toBe(true);
    expect(Number.isFinite(Date.parse(receipt.grantedAt))).toBe(true);
    return receipt;
  }

  async function phoneIs(swap: Swap, actor: Member, member: string, expected: string | null): Promise<void> {
    const rows = await authenticated(actor.userId,
      `select public.get_shared_contact($1::uuid, $2::uuid)
        is not distinct from $3::text as matches`, [swap.id, member, expected]);
    expect(rows).toEqual([{ matches: true }]);
  }

  async function revoke(swap: Swap, actor = fixture.owner): Promise<void> {
    const rows = await authenticated(actor.userId,
      'select public.revoke_contact_sharing($1::uuid) as outcome', [swap.id]);
    expectPhoneFree(rows);
    expect(rows).toEqual([{ outcome: 'cancelled_consent_revoked' }]);
  }

  async function snapshot(swap: Swap): Promise<QueryResultRow> {
    return privileged('read-back: phone-free contact lifecycle snapshot', async () => {
      const result = await query(`select
        (select to_jsonb(s) from public.swap_proposals s where id = $1) as proposal,
        coalesce((select jsonb_agg(to_jsonb(c) order by member, consent_version)
          from public.contact_consents c where swap_id = $1), '[]'::jsonb) as consents,
        coalesce((select jsonb_agg(to_jsonb(b) order by b.consent_id, b.backup_membership)
          from public.contact_consent_backups b join public.contact_consents c on c.id = b.consent_id
          where c.swap_id = $1), '[]'::jsonb) as backups,
        (select count(*)::int from yourturn_private.mobile_numbers m
          join public.contact_consents c on c.id = m.consent_id where c.swap_id = $1) as private_count,
        coalesce((select jsonb_agg(to_jsonb(e) order by id)
          from public.swap_cancellation_events e where swap_id = $1), '[]'::jsonb) as events,
        coalesce((select jsonb_agg(to_jsonb(n) order by id)
          from public.swap_contact_notifications n where swap_id = $1), '[]'::jsonb) as inbox,
        coalesce((select jsonb_agg(to_jsonb(l) order by l.id)
          from public.swap_ledger_entries l join public.swap_legs leg on leg.id = l.swap_leg_id
          where leg.swap_id = $1), '[]'::jsonb) as ledger,
        (select count(*)::int from public.audit_logs where school_id = $2) as audit_count,
        not exists (select 1 from public.audit_logs where school_id = $2
          and exists (select 1 from unnest($3::text[]) phone(value)
            where position(phone.value in payload::text) > 0)) as audit_phone_free`,
      [swap.id, fixture.schoolA, syntheticPhones]);
      expectPhoneFree(result.rows);
      expect(result.rows[0].audit_phone_free).toBe(true);
      return result.rows[0];
    });
  }

  beforeEach(async () => {
    transactionStarted = false;
    savepointNumber = 0;
    const url = process.env.SUPABASE_RLS_TEST_DATABASE_URL;
    if (!url) throw new Error('SUPABASE_RLS_TEST_DATABASE_URL is required for contact live tests.');
    client = new Client({
      connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000,
    });
    try { await client.connect(); }
    catch { throw new Error('Unable to connect to the dedicated RLS test database; connection details suppressed.'); }
    await query('begin');
    transactionStarted = true;
    await query(`set local timezone = 'UTC'; set local row_security = on;
      set local statement_timeout = '15s'; set local lock_timeout = '5s'`);
    fixture = await privileged('fixture: independent two-school contact onboarding', seed);
  }, LIVE_TIMEOUT);

  afterEach(async () => {
    try {
      if (transactionStarted && client) await query('rollback');
    } finally {
      transactionStarted = false;
      if (client) await client.end();
      client = undefined;
    }
  }, LIVE_TIMEOUT);

  it('beforegrantNULL: accepted partners and prospective backups receive NULL before consent', async () => {
    const swap = await createSwap();
    for (const actor of [fixture.owner, fixture.partner, fixture.oldBackup]) {
      await phoneIs(swap, actor, fixture.owner.membershipId, null);
      await phoneIs(swap, actor, fixture.partner.membershipId, null);
    }
    const state = await snapshot(swap);
    expect(state.consents).toEqual([]);
    expect(state.private_count).toBe(0);
  });

  it('grantReceipt: version one is phone-free and omitted backups default to empty', async () => {
    const swap = await createSwap();
    const rows = await authenticated<{ receipt: Receipt }>(fixture.owner.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text) as receipt', [swap.id, PHONE_A]);
    expectPhoneFree(rows);
    expect(rows[0].receipt).toMatchObject({
      consentVersion: 1, policyVersion: 1, scope: SCOPE, defaultContactMethod: 'email_relay',
    });
    const state = await snapshot(swap);
    expect(state.backups).toEqual([]);
    expect(state.private_count).toBe(1);
    expect(state.proposal.status).toBe('accepted');
  });

  it('acceptedpartnerSuccess: both accepted partners read only the other consenting membership', async () => {
    const swap = await createSwap();
    expect((await grant(swap)).consentVersion).toBe(1);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A);
    await phoneIs(swap, fixture.owner, fixture.partner.membershipId, null);
    expect((await grant(swap, fixture.partner, PHONE_B)).consentVersion).toBe(1);
    await phoneIs(swap, fixture.owner, fixture.partner.membershipId, PHONE_B);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A);
    await phoneIs(swap, fixture.owner, fixture.owner.membershipId, null);
    await phoneIs(swap, fixture.partner, fixture.partner.membershipId, null);
  });

  it('chosenbackupSuccess: two explicitly chosen verified same-school backups can read the owner', async () => {
    const swap = await createSwap();
    await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId, fixture.newBackup.membershipId]);
    for (const actor of [fixture.oldBackup, fixture.newBackup]) {
      await phoneIs(swap, actor, fixture.owner.membershipId, PHONE_A);
      await phoneIs(swap, actor, fixture.partner.membershipId, null);
    }
  });

  it.each(['unchosen', 'unrelated', 'parentB', 'moderatorB'] as const)(
    'deniedReader-%s: unchosen unrelated same-school School B and moderator B receive NULL', async (key) => {
      const swap = await createSwap();
      await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
      await phoneIs(swap, fixture[key], fixture.owner.membershipId, null);
      expect(await authenticated(fixture[key].userId,
        'select id from public.contact_consents where swap_id = $1', [swap.id])).toEqual([]);
      expect(await authenticated(fixture[key].userId,
        'select consent_id from public.contact_consent_backups where school_id = $1', [fixture.schoolA])).toEqual([]);
    },
  );

  it('memberArgumentIsNotCallerIdentity: user IDs foreign memberships and unrelated consenting targets cannot spoof access', async () => {
    const swap = await createSwap();
    await grant(swap);
    for (const member of [fixture.owner.userId, fixture.partner.membershipId, fixture.parentB.membershipId, randomUUID()]) {
      await phoneIs(swap, fixture.partner, member, null);
    }
    const other = await createSwap();
    await phoneIs(other, fixture.partner, fixture.owner.membershipId, null);
    await phoneIs(swap, fixture.unrelated, fixture.owner.membershipId, null);
    await phoneIs(swap, fixture.owner, fixture.owner.membershipId, null);
  });

  it('anonymousDenied: anon cannot execute any contact RPC even for a known consent', async () => {
    const swap = await createSwap();
    await grant(swap);
    await denied(() => anonymous('select public.grant_contact_sharing($1, $2)', [swap.id, PHONE_A]));
    await denied(() => anonymous('select public.get_shared_contact($1, $2)', [swap.id, fixture.owner.membershipId]));
    await denied(() => anonymous('select public.revoke_contact_sharing($1)', [swap.id]));
  });

  it('ownerOnlyMetadata: partner and chosen backup cannot SELECT consent or backup snapshots', async () => {
    const swap = await createSwap();
    const receipt = await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    const rows = await authenticated(fixture.owner.userId,
      'select id, member, consent_version, policy_version, scope from public.contact_consents where swap_id = $1', [swap.id]);
    expect(rows).toEqual([{
      id: receipt.id, member: fixture.owner.membershipId, consent_version: 1, policy_version: 1, scope: SCOPE,
    }]);
    expect(await authenticated(fixture.owner.userId,
      'select consent_id, school_id, backup_membership from public.contact_consent_backups where consent_id = $1',
      [receipt.id])).toEqual([{
      consent_id: receipt.id, school_id: fixture.schoolA, backup_membership: fixture.oldBackup.membershipId,
    }]);
    for (const actor of [fixture.partner, fixture.oldBackup]) {
      expect(await authenticated(actor.userId,
        'select id from public.contact_consents where swap_id = $1', [swap.id])).toEqual([]);
      expect(await authenticated(actor.userId,
        'select consent_id from public.contact_consent_backups where consent_id = $1', [receipt.id])).toEqual([]);
    }
  });

  it('privateSchemaTableDenied: even owner partner and chosen backup cannot directly read or write private phones', async () => {
    const swap = await createSwap();
    const receipt = await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    for (const actor of [fixture.owner, fixture.partner, fixture.oldBackup]) {
      await denied(() => authenticated(actor.userId, 'select * from yourturn_private.mobile_numbers'));
      await denied(() => authenticated(actor.userId,
        'select mobile_number from yourturn_private.mobile_numbers where consent_id = $1', [receipt.id]));
      await denied(() => authenticated(actor.userId, `insert into yourturn_private.mobile_numbers
        (consent_id, member, mobile_number) values ($1, $2, $3)`,
      [receipt.id, fixture.owner.membershipId, PHONE_A]));
      await denied(() => authenticated(actor.userId,
        'update yourturn_private.mobile_numbers set mobile_number = $2 where consent_id = $1', [receipt.id, PHONE_A_V2]));
      await denied(() => authenticated(actor.userId,
        'delete from yourturn_private.mobile_numbers where consent_id = $1', [receipt.id]));
    }
  });

  it('version1to2Snapshots: regrant supersedes without revocation or cancellation and replaces the chosen backup set', async () => {
    const swap = await createSwap();
    const first = await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    await phoneIs(swap, fixture.oldBackup, fixture.owner.membershipId, PHONE_A);
    const before = await snapshot(swap);
    const second = await grant(swap, fixture.owner, PHONE_A_V2, [fixture.newBackup.membershipId]);
    expect(second.consentVersion).toBe(2);
    expect(second.id === first.id).toBe(false);
    const after = await snapshot(swap);
    expect(after.proposal).toEqual(before.proposal);
    expect(after.events).toEqual([]);
    expect(after.inbox).toEqual([]);
    expect(after.private_count).toBe(2);
    expect(after.consents).toHaveLength(2);
    const old = after.consents.find((c: QueryResultRow) => c.id === first.id);
    const latest = after.consents.find((c: QueryResultRow) => c.id === second.id);
    expect(old).toEqual({ ...before.consents[0], superseded_at: old.superseded_at });
    expect(old.superseded_at).not.toBeNull();
    expect(old.revoked_at).toBeNull();
    expect(latest).toMatchObject({
      member: fixture.owner.membershipId, school_id: fixture.schoolA, swap_id: swap.id,
      consent_version: 2, policy_version: 1, scope: SCOPE, revoked_at: null, superseded_at: null,
    });
    expect(after.backups).toEqual(expect.arrayContaining([
      { consent_id: first.id, school_id: fixture.schoolA, backup_membership: fixture.oldBackup.membershipId },
      { consent_id: second.id, school_id: fixture.schoolA, backup_membership: fixture.newBackup.membershipId },
    ]));
    expect(after.backups).toHaveLength(2);
    await privileged('read-back: immutable private version snapshots boolean only', async () => {
      const rows = await query(`select consent_id, member,
        mobile_number = case when consent_id = $1 then $3 else $4 end as matches
        from yourturn_private.mobile_numbers where consent_id = any($2::uuid[]) order by consent_id`,
      [first.id, [first.id, second.id], PHONE_A, PHONE_A_V2]);
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((r) => r.matches === true && r.member === fixture.owner.membershipId)).toBe(true);
    });
    await phoneIs(swap, fixture.oldBackup, fixture.owner.membershipId, null);
    await phoneIs(swap, fixture.newBackup, fixture.owner.membershipId, PHONE_A_V2);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A_V2);
  });

  it.each(['empty', 'local', 'landline', 'foreign', 'short', 'long', 'whitespace', 'null'] as const)(
    'invalidMobile-%s: non-AU-E164 input rejects generically with no contact side effects', async (kind) => {
      const invalid: Record<typeof kind, string | null> = {
        empty: '', local: '0400000101', landline: '+61200000101', foreign: '+15550000101',
        short: '+6140000010', long: '+614000001010', whitespace: ` ${PHONE_A}`, null: null,
      };
      const swap = await createSwap();
      await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
      const before = await snapshot(swap);
      await denied(() => authenticated(fixture.owner.userId,
        'select public.grant_contact_sharing($1::uuid, $2::text, $3::uuid[])',
        [swap.id, invalid[kind], [fixture.newBackup.membershipId]]), ['22023', '42501']);
      expect(await snapshot(swap)).toEqual(before);
    },
  );

  it.each(['owner', 'partner', 'parentB', 'moderatorB', 'pending', 'unknown', 'userId'] as const)(
    'invalidBackup-%s: owner partner foreign pending unknown and user IDs reject without side effects', async (kind) => {
      const swap = await createSwap();
      await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
      const backups = {
        owner: fixture.owner.membershipId, partner: fixture.partner.membershipId,
        parentB: fixture.parentB.membershipId, moderatorB: fixture.moderatorB.membershipId,
        pending: fixture.pending.membershipId, unknown: randomUUID(), userId: fixture.newBackup.userId,
      };
      const before = await snapshot(swap);
      await denied(() => authenticated(fixture.owner.userId,
        'select public.grant_contact_sharing($1::uuid, $2::text, $3::uuid[])',
        [swap.id, PHONE_A_V2, [backups[kind]]]), ['22023', '42501']);
      expect(await snapshot(swap)).toEqual(before);
    },
  );

  it.each([0, 1, 2])('tooManyBackups-limit%s: school-configured ceiling rejects atomically', async (limit) => {
    const swap = await createSwap();
    await grant(swap);
    await privileged('fixture: independent school backup ceiling', async () => {
      await query('update public.school_configs set max_backups = $2 where school_id = $1', [fixture.schoolA, limit]);
    });
    const backups = [fixture.oldBackup.membershipId, fixture.newBackup.membershipId, fixture.unchosen.membershipId];
    const before = await snapshot(swap);
    await denied(() => authenticated(fixture.owner.userId,
      'select public.grant_contact_sharing($1::uuid, $2::text, $3::uuid[])',
      [swap.id, PHONE_A_V2, backups.slice(0, limit + 1)]), ['22023', '42501']);
    expect(await snapshot(swap)).toEqual(before);
  });

  it.each(['unrelated', 'parentB', 'moderatorB', 'pending', 'noMembershipUser'] as const)(
    'wrongCaller-%s: non-owning or unverified caller cannot grant or revoke another consent', async (key) => {
      const swap = await createSwap();
      await grant(swap);
      const user = key === 'noMembershipUser' ? fixture.noMembershipUser : fixture[key].userId;
      const before = await snapshot(swap);
      await denied(() => authenticated(user,
        'select public.grant_contact_sharing($1::uuid, $2::text)', [swap.id, PHONE_A_V2]));
      await denied(() => authenticated(user, 'select public.revoke_contact_sharing($1::uuid)', [swap.id]));
      expect(await snapshot(swap)).toEqual(before);
    },
  );

  it.each(['pending_moderator', 'suspended', 'missingSafety', 'missingConsent', 'adminSuspended'] as const)(
    'inactiveParticipant-%s: inactive owners cannot grant or read but retain idempotent withdrawal of their existing consent', async (state) => {
      const swap = await createSwap();
      await grant(swap);
      await grant(swap, fixture.partner, PHONE_B);
      await privileged('fixture: consenting participant loses active onboarding', async () => {
        if (state === 'missingSafety') {
          await query('delete from public.safety_declarations where membership_id = $1', [fixture.owner.membershipId]);
        } else if (state === 'missingConsent') {
          await query('delete from public.consent_acceptances where user_id = $1', [fixture.owner.userId]);
        } else if (state === 'adminSuspended') {
          await query('update public.profiles set admin_suspended = true where id = $1', [fixture.owner.userId]);
        } else {
          await query('update public.school_memberships set status = $2 where id = $1', [fixture.owner.membershipId, state]);
        }
      });
      const before = await snapshot(swap);
      await denied(() => authenticated(fixture.owner.userId,
        'select public.grant_contact_sharing($1::uuid, $2::text)', [swap.id, PHONE_A_V2]));
      await phoneIs(swap, fixture.owner, fixture.partner.membershipId, null);
      await phoneIs(swap, fixture.partner, fixture.owner.membershipId, null);
      expect(await snapshot(swap)).toEqual(before);
      await revoke(swap);
      const withdrawn = await snapshot(swap);
      expect(withdrawn.proposal.status).toBe('cancelled_consent_revoked');
      expect(withdrawn.events).toHaveLength(1);
      await revoke(swap);
      expect(await snapshot(swap)).toEqual(withdrawn);
    },
  );

  it('inactiveBackup: chosen backup loses immediate read access when verified status is suspended', async () => {
    const swap = await createSwap();
    await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    await phoneIs(swap, fixture.oldBackup, fixture.owner.membershipId, PHONE_A);
    await privileged('fixture: chosen backup suspended', async () => {
      await query("update public.school_memberships set status = 'suspended' where id = $1", [fixture.oldBackup.membershipId]);
    });
    await phoneIs(swap, fixture.oldBackup, fixture.owner.membershipId, null);
  });

  it('proposedDenied: proposed participants and nonparticipants cannot grant or revoke before acceptance', async () => {
    const swap = await createSwap('proposed');
    const before = await snapshot(swap);
    for (const actor of [fixture.owner, fixture.partner, fixture.unrelated]) {
      await denied(() => authenticated(actor.userId,
        'select public.grant_contact_sharing($1::uuid, $2::text)', [swap.id, PHONE_A]));
      await denied(() => authenticated(actor.userId, 'select public.revoke_contact_sharing($1::uuid)', [swap.id]));
      await phoneIs(swap, actor, fixture.owner.membershipId, null);
    }
    expect(await snapshot(swap)).toEqual(before);
  });

  it('nonconsentingPartnerCannotRevokeOwner: accepted partnership alone does not own the other consent', async () => {
    const swap = await createSwap();
    await grant(swap);
    const before = await snapshot(swap);
    await denied(() => authenticated(fixture.partner.userId,
      'select public.revoke_contact_sharing($1::uuid)', [swap.id]));
    expect(await snapshot(swap)).toEqual(before);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A);
  });

  it('revokeLifecycle: latest consent revocation cancels with retained acceptance event partner-only phone-free inbox and immediate NULL both ways', async () => {
    const swap = await createSwap();
    const old = await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    const latest = await grant(swap, fixture.owner, PHONE_A_V2, [fixture.newBackup.membershipId]);
    const other = await grant(swap, fixture.partner, PHONE_B, [fixture.oldBackup.membershipId]);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A_V2);
    await phoneIs(swap, fixture.owner, fixture.partner.membershipId, PHONE_B);
    await revoke(swap);
    const state = await snapshot(swap);
    expect(state.proposal.status).toBe('cancelled_consent_revoked');
    expect(new Date(state.proposal.accepted_at).getTime()).toBe(swap.acceptedAt!.getTime());
    expect(state.proposal.cancelled_at).not.toBeNull();
    const own = state.consents.find((c: QueryResultRow) => c.id === latest.id);
    expect(own.revoked_at).not.toBeNull();
    expect(own.superseded_at).toBeNull();
    expect(state.consents.find((c: QueryResultRow) => c.id === old.id).revoked_at).toBeNull();
    expect(state.consents.find((c: QueryResultRow) => c.id === other.id)).toMatchObject({
      revoked_at: null, superseded_at: null,
    });
    expect(Date.parse(state.proposal.cancelled_at)).toBeGreaterThanOrEqual(swap.acceptedAt!.getTime());
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      school_id: fixture.schoolA, swap_id: swap.id, actor_membership: fixture.owner.membershipId,
      consent_id: latest.id, reason: 'consent_revoked',
    });
    expect(Number.isFinite(Date.parse(state.events[0].created_at))).toBe(true);
    expect(state.events[0].created_at).toBe(own.revoked_at);
    expect(state.proposal.cancelled_at).toBe(own.revoked_at);
    expect(state.inbox).toHaveLength(1);
    expect(state.inbox[0]).toMatchObject({
      school_id: fixture.schoolA, swap_id: swap.id, recipient_membership: fixture.partner.membershipId,
      kind: 'contact_consent_revoked', message: 'Contact sharing was withdrawn. This swap has ended.',
    });
    expect(Number.isFinite(Date.parse(state.inbox[0].created_at))).toBe(true);
    expect(state.inbox[0].created_at).toBe(own.revoked_at);
    const inbox = await authenticated(fixture.partner.userId,
      'select * from public.swap_contact_notifications where swap_id = $1', [swap.id]);
    expectPhoneFree(inbox);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].recipient_membership).toBe(fixture.partner.membershipId);
    for (const actor of [fixture.owner, fixture.oldBackup, fixture.newBackup, fixture.unrelated, fixture.parentB, fixture.moderatorB]) {
      expect(await authenticated(actor.userId,
        'select id from public.swap_contact_notifications where swap_id = $1', [swap.id])).toEqual([]);
    }
    for (const actor of [fixture.owner, fixture.partner, fixture.oldBackup, fixture.newBackup]) {
      await phoneIs(swap, actor, fixture.owner.membershipId, null);
      await phoneIs(swap, actor, fixture.partner.membershipId, null);
    }
  });

  it('idempotentRevoke: repeat owning revocation preserves exact timestamps history event and single inbox row', async () => {
    const swap = await createSwap();
    await grant(swap);
    await revoke(swap);
    const before = await snapshot(swap);
    await revoke(swap);
    await revoke(swap);
    expect(await snapshot(swap)).toEqual(before);
    expect(before.events).toHaveLength(1);
    expect(before.inbox).toHaveLength(1);
  });

  it('noRevival: neither owner may regrant or accept a consent-cancelled swap', async () => {
    const swap = await createSwap();
    await grant(swap);
    await grant(swap, fixture.partner, PHONE_B);
    await revoke(swap);
    const before = await snapshot(swap);
    for (const actor of [fixture.owner, fixture.partner]) {
      await denied(() => authenticated(actor.userId,
        'select public.grant_contact_sharing($1::uuid, $2::text)', [swap.id, PHONE_A_V2]));
      await denied(() => authenticated(actor.userId,
        "select public.transition_swap_proposal($1::uuid, 'accept')", [swap.id]));
    }
    expect(await snapshot(swap)).toEqual(before);
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, null);
  });

  async function completedLeg(swap: Swap): Promise<{ instance: string; pattern: string }> {
    return privileged('fixture: trusted completion for cancellation ledger regression', async () => {
      const patterns = [randomUUID(), randomUUID()];
      const instances = [randomUUID(), randomUUID()];
      const owners = [fixture.partner.userId, fixture.owner.userId];
      const intents = ['can_help', 'need_help'];
      await query(`insert into public.availability_patterns
        (id, school_id, owner_id, intent, direction, weekday, window_start, window_end,
         area_label, capacity, starts_on)
        select id, $2::uuid, owner_id, intent::public.schedule_intent, 'pickup',
          extract(isodow from (now() at time zone 'Australia/Sydney'))::smallint,
          '15:00'::time, '15:30'::time, 'Carlton', 1,
          (now() at time zone 'Australia/Sydney')::date
        from unnest($1::uuid[], $3::uuid[], $4::text[]) p(id, owner_id, intent)`,
      [patterns, fixture.schoolA, owners, intents]);
      await query(`insert into public.availability_instances
        (id, pattern_id, school_id, owner_id, service_date, intent, direction,
         window_start, window_end, area_label, capacity)
        select id, pattern_id, $3::uuid, owner_id, (now() at time zone 'Australia/Sydney')::date,
          intent::public.schedule_intent, 'pickup', '15:00'::time, '15:30'::time, 'Carlton', 1
        from unnest($1::uuid[], $2::uuid[], $4::uuid[], $5::text[]) i(id, pattern_id, owner_id, intent)`,
      [instances, patterns, fixture.schoolA, owners, intents]);
      await query(`insert into public.swap_legs
        (id, swap_id, school_id, helper_instance_id, requester_instance_id, helper_id,
         requester_id, service_date, completed_at)
        values ($1, $2, $3, $4, $5, $6, $7,
          (now() at time zone 'Australia/Sydney')::date, now() - interval '1 hour')`,
      [randomUUID(), swap.id, fixture.schoolA, ...instances, ...owners]);
      return { instance: instances[1], pattern: patterns[1] };
    });
  }

  it('unchangedLedgerAfterCancel: consent withdrawal preserves immutable completed trip entries and pair counts', async () => {
    const swap = await createSwap();
    await completedLeg(swap);
    await grant(swap);
    const before = await snapshot(swap);
    expect(before.ledger).toHaveLength(1);
    const ledgers = [];
    for (const actor of [fixture.owner, fixture.partner]) {
      ledgers.push(await authenticated(actor.userId, 'select public.get_my_ledger() as ledger'));
    }
    await revoke(swap);
    expect((await snapshot(swap)).ledger).toEqual(before.ledger);
    for (const [index, actor] of [fixture.owner, fixture.partner].entries()) {
      expect(await authenticated(actor.userId, 'select public.get_my_ledger() as ledger')).toEqual(ledgers[index]);
    }
  });

  it.each(publicContactTables)('noDirectDML-%s: clients cannot INSERT UPDATE DELETE or TRUNCATE contact metadata history or inbox', async (table) => {
    const swap = await createSwap();
    const receipt = await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    await revoke(swap);
    const before = await snapshot(swap);
    const inserts: Record<string, [string, unknown[]]> = {
      contact_consents: [`(id, school_id, swap_id, member, consent_version, policy_version, scope, granted_at)
        values ($1, $2, $3, $4, 2, 1, $5, now())`,
      [randomUUID(), fixture.schoolA, swap.id, fixture.owner.membershipId, SCOPE]],
      contact_consent_backups: ['(consent_id, school_id, backup_membership) values ($1, $2, $3)',
        [receipt.id, fixture.schoolA, fixture.newBackup.membershipId]],
      swap_cancellation_events: [`(id, school_id, swap_id, actor_membership, consent_id, reason)
        values ($1, $2, $3, $4, $5, 'consent_revoked')`,
      [randomUUID(), fixture.schoolA, swap.id, fixture.owner.membershipId, receipt.id]],
      swap_contact_notifications: [`(id, school_id, swap_id, recipient_membership, kind, message)
        values ($1, $2, $3, $4, 'contact_consent_revoked', 'Contact sharing was withdrawn. This swap has ended.')`,
      [randomUUID(), fixture.schoolA, swap.id, fixture.partner.membershipId]],
    };
    for (const actor of [fixture.owner, fixture.partner, fixture.oldBackup, fixture.moderatorB]) {
      await denied(() => authenticated(actor.userId, `insert into public.${table} ${inserts[table][0]}`, inserts[table][1]));
      await denied(() => authenticated(actor.userId, `update public.${table} set school_id = school_id where school_id = $1`, [fixture.schoolA]));
      await denied(() => authenticated(actor.userId, `delete from public.${table} where school_id = $1`, [fixture.schoolA]));
      await denied(() => authenticated(actor.userId, `truncate public.${table}`));
    }
    expect(await snapshot(swap)).toEqual(before);
  });

  it('immutableCancellationEvent: privileged UPDATE DELETE and TRUNCATE cannot rewrite cancellation history', async () => {
    const swap = await createSwap();
    await grant(swap);
    await revoke(swap);
    const before = await snapshot(swap);
    await privileged('read-back: cancellation history append-only guards', async () => {
      await denied(() => query('update public.swap_cancellation_events set reason = reason where swap_id = $1', [swap.id]), ['55000']);
      await denied(() => query('delete from public.swap_cancellation_events where swap_id = $1', [swap.id]), ['55000']);
      await denied(() => query('truncate public.swap_cancellation_events'), ['55000']);
    });
    expect(await snapshot(swap)).toEqual(before);
  });

  it('catalogPrivacy: no public phone columns or views referencing the private phone table and no private client privileges or policies', async () => {
    const columns = await authenticated<{ name: string }>(fixture.owner.userId,
      `select a.attname as name from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and a.attnum > 0 and not a.attisdropped`);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.some((c) => /mobile|phone|msisdn|e164/i.test(c.name))).toBe(false);
    const views = await authenticated(fixture.owner.userId, `select c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm') and (
        pg_catalog.pg_get_viewdef(c.oid, true) ~* 'yourturn_private|mobile_numbers|mobile_number'
        or exists (select 1 from pg_catalog.pg_rewrite r
          join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = r.oid
          where r.ev_class = c.oid and d.refobjid = (
            select private.oid from pg_catalog.pg_class private
            join pg_catalog.pg_namespace pn on pn.oid = private.relnamespace
            where pn.nspname = 'yourturn_private' and private.relname = 'mobile_numbers')))`);
    expect(views).toEqual([]);
    const privateRows = await authenticated(fixture.owner.userId, `select c.relrowsecurity as rls,
      (select count(*)::int from pg_catalog.pg_policy p where p.polrelid = c.oid) as policies,
      has_schema_privilege('authenticated', n.oid, 'USAGE,CREATE') as auth_schema,
      has_schema_privilege('anon', n.oid, 'USAGE,CREATE') as anon_schema,
      has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_table,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_table,
      has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') as auth_columns,
      has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') as anon_columns
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'yourturn_private' and c.relname = 'mobile_numbers'`);
    expect(privateRows).toEqual([{
      rls: true, policies: 0, auth_schema: false, anon_schema: false, auth_table: false, anon_table: false,
      auth_columns: false, anon_columns: false,
    }]);
    const phoneReaders = await privileged('read-back: dedicated private phone reader functions', async () => {
      return (await query<{ name: string }>(`select p.proname as name from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'yourturn_private') and p.prokind = 'f'
          and p.prosrc ~* 'mobile_numbers' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        order by p.proname`)).rows;
    });
    // The grant writes; only get_shared_contact is a client-callable reader.
    expect(phoneReaders.map((r) => r.name).filter((name) => name !== 'grant_contact_sharing')).toEqual(['get_shared_contact']);
  });

  it('catalogTables: every new table has RLS SELECT-only client grants and exact consent and backup metadata columns', async () => {
    const rows = await authenticated(fixture.owner.userId, `select c.relname as name, c.relrowsecurity as rls,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
      has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_write,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
      array(select a.attname::text from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attname) as columns
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[]) order by c.relname`, [publicContactTables]);
    expect(rows).toHaveLength(publicContactTables.length);
    for (const row of rows) {
      expect(row).toMatchObject({ rls: true, auth_select: true, auth_write: false, anon_access: false });
    }
    expect(rows.find((r) => r.name === 'contact_consents')?.columns).toEqual([
      'id', 'school_id', 'swap_id', 'member', 'consent_version', 'policy_version',
      'scope', 'granted_at', 'revoked_at', 'superseded_at',
    ].sort());
    expect(rows.find((r) => r.name === 'contact_consent_backups')?.columns).toEqual([
      'consent_id', 'school_id', 'backup_membership',
    ].sort());
    const constraints = await authenticated(fixture.owner.userId, `select
      exists (select 1 from pg_catalog.pg_index i where i.indrelid = 'public.swap_cancellation_events'::regclass
        and i.indisunique and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
          = array['swap_id']::text[]) as one_event,
      exists (select 1 from pg_catalog.pg_index i where i.indrelid = 'public.swap_contact_notifications'::regclass
        and i.indisunique and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
          = array['swap_id','recipient_membership','kind']::text[]) as unique_inbox`);
    expect(constraints).toEqual([{ one_event: true, unique_inbox: true }]);
  });

  it('catalogFunctions: three contact RPCs have explicit authenticated-only EXECUTE and all five pg_catalog paths with internal execution denied', async () => {
    const rows = await authenticated(fixture.owner.userId, `select p.proname as name,
      pg_catalog.oidvectortypes(p.proargtypes) as args, p.prorettype::regtype::text as result,
      p.prosecdef as security_definer,
      array(select s from unnest(p.proconfig) s where s like 'search_path=%') as path,
      exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl,
        pg_catalog.acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute,
      exists (select 1 from pg_catalog.aclexplode(p.proacl) a
        join pg_catalog.pg_roles r on r.oid = a.grantee
        where r.rolname = 'authenticated' and a.privilege_type = 'EXECUTE') as explicit_auth
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`, [contactFunctions]);
    expect(rows).toHaveLength(5);
    const signatures: Record<string, [string, string]> = {
      contact_member_is_active: ['uuid, uuid', 'boolean'],
      get_shared_contact: ['uuid, uuid', 'text'],
      grant_contact_sharing: ['uuid, text, uuid[]', 'jsonb'],
      guard_contact_history: ['', 'trigger'], revoke_contact_sharing: ['uuid', 'text'],
    };
    for (const row of rows) {
      const exposed = ['grant_contact_sharing', 'get_shared_contact', 'revoke_contact_sharing'].includes(row.name);
      expect(row).toMatchObject({
        args: signatures[row.name][0], result: signatures[row.name][1], path: ['search_path=pg_catalog'],
        public_execute: false, anon_execute: false, auth_execute: exposed, explicit_auth: exposed,
      });
      if (exposed) expect(row.security_definer).toBe(true);
    }
    await denied(() => authenticated(fixture.owner.userId, 'select public.guard_contact_history()'));
    await denied(() => authenticated(fixture.owner.userId,
      'select public.contact_member_is_active($1::uuid, $2::uuid)', [fixture.owner.membershipId, fixture.schoolA]));
    const allowlist = JSON.parse(await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8')) as {
      authenticated: Array<{ name: string }>; internal: Array<{ name: string }>;
    };
    for (const name of contactFunctions) {
      const exposed = ['grant_contact_sharing', 'get_shared_contact', 'revoke_contact_sharing'].includes(name);
      expect(allowlist.authenticated.some((entry) => entry.name === name)).toBe(exposed);
      if (!exposed) expect(allowlist.internal.some((entry) => entry.name === name)).toBe(true);
    }
  });

  it('allAllowlistedRPCResponseLeakScan: every allowlisted RPC is actually called in a rollback savepoint with only the scoped dedicated getter exception', async () => {
    const swap = await createSwap();
    const source = await completedLeg(swap);
    await grant(swap, fixture.owner, PHONE_A, [fixture.oldBackup.membershipId]);
    await grant(swap, fixture.partner, PHONE_B, [fixture.newBackup.membershipId]);
    // Same function/argument mapping as rpc-smoke.test.ts, but parameterized with
    // this transaction's synthetic seeded IDs. No legacy committed fixture IDs.
    type Call = { sql: string; values?: unknown[]; actor?: Member; dedicatedGetter?: boolean };
    const calls: Record<string, Call> = {
      accept_current_consent: { sql: "select public.accept_current_consent('terms', 1)" },
      add_onboarding_child: { sql: "select public.add_onboarding_child($1::uuid, 'Contact child'::text, 3::smallint)", values: [fixture.owner.membershipId] },
      approve_school_membership: { sql: 'select public.approve_school_membership($1::uuid)', values: [fixture.pending.membershipId] },
      block_match_user: { sql: 'select public.block_match_user($1::uuid)', values: [fixture.unrelated.userId] },
      cancel_availability_instance: { sql: 'select public.cancel_availability_instance($1::uuid)', values: [source.instance] },
      cancel_availability_pattern: { sql: 'select public.cancel_availability_pattern($1::uuid)', values: [source.pattern] },
      claim_household_link_invitation: { sql: "select public.claim_household_link_invitation(repeat('0', 48))" },
      claim_school_invitation: { sql: "select public.claim_school_invitation(repeat('0', 48))" },
      confirm_household_link: { sql: 'select public.confirm_household_link($1::uuid)', values: [fixture.schoolA] },
      create_availability_pattern: { sql: "select public.create_availability_pattern($1::uuid, 'can_help'::text, 'pickup'::text, 1::smallint, '08:00'::time, '08:30'::time, 'Carlton'::text, 1::smallint, current_date)", values: [fixture.schoolA] },
      create_household_link_invitation: { sql: 'select public.create_household_link_invitation()' },
      create_school_invitation: { sql: 'select * from public.create_school_invitation($1::uuid)', values: [fixture.schoolA] },
      expire_my_swap_proposals: { sql: 'select public.expire_my_swap_proposals()' },
      get_accepted_swap_children: { sql: 'select * from public.get_accepted_swap_children($1::uuid)', values: [swap.id] },
      get_my_ledger: { sql: 'select public.get_my_ledger()' },
      get_my_trust: { sql: 'select public.get_my_trust()' },
      get_peer_trust_band: { sql: 'select public.get_peer_trust_band($1::uuid)', values: [fixture.partner.userId] },
      get_reciprocal_match_candidates: { sql: 'select * from public.get_reciprocal_match_candidates(false)' },
      has_current_onboarding_consents: { sql: 'select public.has_current_onboarding_consents($1::uuid)', values: [fixture.owner.userId] },
      is_admin: { sql: 'select public.is_admin()' },
      is_approved_school_member: { sql: 'select public.is_approved_school_member($1::uuid)', values: [fixture.owner.userId] },
      is_member: { sql: 'select public.is_member($1::uuid)', values: [fixture.schoolA] },
      is_moderator: { sql: 'select public.is_moderator($1::uuid)', values: [fixture.schoolA] },
      is_same_household: { sql: 'select public.is_same_household($1::uuid, $2::uuid)', values: [fixture.owner.userId, fixture.partner.userId] },
      is_verified_email_user: { sql: 'select public.is_verified_email_user()' },
      list_my_swaps: { sql: 'select * from public.list_my_swaps()' },
      list_onboarding_school_options: { sql: 'select * from public.list_onboarding_school_options()' },
      list_pending_school_memberships: { sql: 'select * from public.list_pending_school_memberships()' },
      open_school_invitation: { sql: "select public.open_school_invitation(repeat('0', 48))" },
      propose_reciprocal_swap: { sql: 'select public.propose_reciprocal_swap($1::uuid, $1::uuid, $1::uuid, $1::uuid, false)', values: [source.instance] },
      record_email_verified_event: { sql: 'select public.record_email_verified_event()' },
      record_first_match_viewed: { sql: 'select public.record_first_match_viewed()' },
      redeem_school_invite_code: { sql: "select public.redeem_school_invite_code($1::uuid, 'CONTACT-SMOKE')", values: [fixture.schoolA] },
      refresh_my_availability_instances: { sql: 'select public.refresh_my_availability_instances()' },
      request_household_link: { sql: 'select public.request_household_link($1::uuid)', values: [fixture.unrelated.userId] },
      school_local_today: { sql: 'select public.school_local_today($1::uuid)', values: [fixture.schoolA] },
      set_school_membership_review_state: { sql: "select public.set_school_membership_review_state($1::uuid, 'rejected')", values: [fixture.pending.membershipId] },
      sign_onboarding_safety_declaration: { sql: 'select public.sign_onboarding_safety_declaration($1::uuid, $2::uuid)', values: [fixture.owner.membershipId, fixture.declarationA] },
      transition_swap_proposal: { sql: "select public.transition_swap_proposal($1::uuid, 'withdraw')", values: [swap.id] },
      update_availability_pattern: { sql: "select public.update_availability_pattern($1::uuid, 'can_help'::text, 'pickup'::text, 1::smallint, '08:00'::time, '08:30'::time, 'Carlton'::text, 1::smallint, current_date)", values: [source.pattern] },
      update_onboarding_parent_profile: { sql: "select public.update_onboarding_parent_profile('Contact parent')" },
      grant_contact_sharing: { sql: 'select public.grant_contact_sharing($1::uuid, $2::text, $3::uuid[])', values: [swap.id, PHONE_A_V2, [fixture.newBackup.membershipId]] },
      get_shared_contact: { sql: 'select public.get_shared_contact($1::uuid, $2::uuid) as phone', values: [swap.id, fixture.owner.membershipId], actor: fixture.partner, dedicatedGetter: true },
      revoke_contact_sharing: { sql: 'select public.revoke_contact_sharing($1::uuid)', values: [swap.id] },
      confirm_pickup_done: { sql: 'select public.confirm_pickup_done((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1))', values: [swap.id] },
      confirm_child_arrived: { sql: 'select public.confirm_child_arrived((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1))', values: [swap.id] },
      refresh_my_handover_reminders: { sql: 'select public.refresh_my_handover_reminders()' },
      list_my_trust_cases: { sql: 'select public.list_my_trust_cases()' },
      list_school_trust_queue: { sql: 'select public.list_school_trust_queue()' },
      report_no_show: { sql: 'select public.report_no_show((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1), false)', values: [swap.id] },
      dispute_trust_report: { sql: 'select public.dispute_trust_report($1::uuid)', values: [fixture.schoolA] },
      report_false_report: { sql: 'select public.report_false_report($1::uuid)', values: [fixture.schoolA] },
      resolve_trust_report: { sql: "select public.resolve_trust_report($1::uuid, 'reject')", values: [fixture.schoolA] },
      place_safety_hold: { sql: 'select public.place_safety_hold($1::uuid)', values: [fixture.unrelated.userId] },
      resolve_safety_hold: { sql: "select public.resolve_safety_hold($1::uuid, 'lift')", values: [fixture.schoolA] },
      file_trust_appeal: { sql: "select public.file_trust_appeal('safety_hold', $1::uuid)", values: [fixture.schoolA] },
      resolve_trust_appeal: { sql: "select public.resolve_trust_appeal($1::uuid, 'dismiss')", values: [fixture.schoolA] },
      user_has_active_safety_hold: { sql: 'select public.user_has_active_safety_hold($1::uuid, $2::uuid)', values: [fixture.owner.userId, fixture.schoolA] },
      generate_school_notice: { sql: 'select public.generate_school_notice((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1))', values: [swap.id] },
      get_school_notice: { sql: 'select public.get_school_notice($1::uuid)', values: [fixture.schoolA] },
      list_my_school_notices: { sql: 'select public.list_my_school_notices()' },
      list_school_notice_moderation_queue: { sql: 'select public.list_school_notice_moderation_queue()' },
      withdraw_school_notice: { sql: 'select public.withdraw_school_notice($1::uuid)', values: [fixture.schoolA] },
      mask_email_address: { sql: "select public.mask_email_address('parent@example.invalid')" },
      get_email_relay_delivery_policy: { sql: 'select public.get_email_relay_delivery_policy()' },
      enqueue_email_relay: { sql: "select public.enqueue_email_relay($1::uuid, 'swap_partner_notice', $2::uuid)", values: [swap.id, fixture.partner.userId] },
      list_my_email_relay_queue: { sql: 'select public.list_my_email_relay_queue()' },
      list_school_email_relay_queue: { sql: 'select public.list_school_email_relay_queue()' },
      get_retention_purge_policy: { sql: 'select public.get_retention_purge_policy()' },
      post_running_late_notice: { sql: 'select public.post_running_late_notice((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1))', values: [swap.id] },
      get_running_late_notice: { sql: 'select public.get_running_late_notice((select id from public.swap_legs where swap_id=$1::uuid order by id limit 1))', values: [swap.id] },
      list_my_running_late_notices: { sql: 'select public.list_my_running_late_notices()' },
      create_community_thread: { sql: "select public.create_community_thread('Contact scan title', 'School discussion body without contact details.')" },
      create_community_post: { sql: 'select public.create_community_post($1::uuid, $2::text)', values: [fixture.schoolA, 'Follow-up post for privacy scan.'] },
      create_community_comment: { sql: 'select public.create_community_comment($1::uuid, $2::text)', values: [fixture.schoolA, 'Comment for privacy scan.'] },
      toggle_community_like: { sql: "select public.toggle_community_like('post', $1::uuid)", values: [fixture.schoolA] },
      list_community_threads: { sql: 'select public.list_community_threads()' },
      list_community_posts: { sql: 'select public.list_community_posts($1::uuid)', values: [fixture.schoolA] },
      list_community_comments: { sql: 'select public.list_community_comments($1::uuid)', values: [fixture.schoolA] },
      report_community_content: { sql: "select public.report_community_content('post', $1::uuid, $2::text)", values: [fixture.schoolA, 'Contact scan report reason'] },
      hide_community_content: { sql: "select public.hide_community_content('post', $1::uuid)", values: [fixture.schoolA] },
      restore_community_content: { sql: "select public.restore_community_content('post', $1::uuid)", values: [fixture.schoolA] },
      remove_community_content: { sql: "select public.remove_community_content('post', $1::uuid)", values: [fixture.schoolA] },
      list_community_moderation_queue: { sql: 'select public.list_community_moderation_queue()' },
      list_my_handover_reminder_deliveries: { sql: 'select public.list_my_handover_reminder_deliveries()' },
      create_item_listing: { sql: "select public.create_item_listing('giveaway', 'Contact scan jacket', 'Spare school jacket free to collect', 'clothing', 'Free')" },
      search_item_listings: { sql: "select public.search_item_listings('jacket', 'giveaway', 'clothing')" },
      get_item_listing: { sql: 'select public.get_item_listing($1::uuid)', values: [fixture.schoolA] },
      create_listing_enquiry: { sql: 'select public.create_listing_enquiry($1::uuid, $2::text)', values: [fixture.schoolA, 'Can collect Friday afternoon'] },
      list_listing_enquiries: { sql: 'select public.list_listing_enquiries($1::uuid)', values: [fixture.schoolA] },
      list_restricted_listing_items: { sql: 'select public.list_restricted_listing_items()' },
      mark_item_listing_collected: { sql: 'select public.mark_item_listing_collected($1::uuid)', values: [fixture.schoolA] },
      mark_item_listing_fulfilled: { sql: 'select public.mark_item_listing_fulfilled($1::uuid)', values: [fixture.schoolA] },
      withdraw_item_listing: { sql: 'select public.withdraw_item_listing($1::uuid)', values: [fixture.schoolA] },
      report_item_listing: { sql: 'select public.report_item_listing($1::uuid, $2::text)', values: [fixture.schoolA, 'Contact scan listing report'] },
      hide_item_listing: { sql: 'select public.hide_item_listing($1::uuid)', values: [fixture.schoolA] },
      restore_item_listing: { sql: 'select public.restore_item_listing($1::uuid)', values: [fixture.schoolA] },
      remove_item_listing: { sql: 'select public.remove_item_listing($1::uuid)', values: [fixture.schoolA] },
      list_listing_moderation_queue: { sql: 'select public.list_listing_moderation_queue()' },
      create_restricted_listing_item: { sql: "select public.create_restricted_listing_item('contact_scan_item', 'Contact scan restricted', array['contact scan item'])" },
      update_restricted_listing_item: { sql: 'select public.update_restricted_listing_item($1::uuid, $2::text, $3::text[], $4::boolean)', values: [fixture.schoolA, 'Contact scan label', ['contact scan term'], true] },
      list_all_restricted_listing_items: { sql: 'select public.list_all_restricted_listing_items()' },
    };
    const allowlist = JSON.parse(await readFile(new URL('../../db/function_allowlist.json', import.meta.url), 'utf8')) as {
      authenticated: Array<{ name: string }>;
    };
    const names = allowlist.authenticated.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    // Fail before scanning if ANY allowed function is unaccounted for. Never
    // silently skip additions or claim scan completeness from catalogue text.
    expect(names.filter((name) => !Object.hasOwn(calls, name))).toEqual([]);
    expect(names).toContain('grant_contact_sharing');
    expect(names).toContain('get_shared_contact');
    // These two older RPCs have pre-existing ambiguous-column defects outside
    // Task 5.2. They still must actually be called and must never echo phones in
    // errors, but this privacy scan must not mislabel them as working or denied.
    const knownLegacyErrors: Record<string, string> = {
      accept_current_consent: '42702', refresh_my_availability_instances: '42702',
    };
    const outcomes: Array<{
      name: string; outcome: 'success' | 'denied' | 'known_legacy_error' | 'unexpected_error'; code: string | null;
    }> = [];
    const failures: Array<{ name: string; code: string }> = [];
    for (const name of names) {
      const call = calls[name];
      await isolated(async () => {
        let rows: QueryResultRow[];
        try {
          rows = await authenticated((call.actor ?? fixture.owner).userId, call.sql, call.values ?? []);
        } catch (error) {
          const safe = error as SafeError;
          expect(safe.sensitiveEcho).toBe(false);
          if (Object.hasOwn(knownLegacyErrors, name) && knownLegacyErrors[name] === safe.code) {
            outcomes.push({ name, outcome: 'known_legacy_error', code: safe.code });
          } else if (['42501', '22023', '55000', '23505', '23514', 'P0001', 'P0002'].includes(safe.code)) {
            outcomes.push({ name, outcome: 'denied', code: safe.code });
          } else {
            failures.push({ name, code: safe.code ?? 'non-database-error' });
            outcomes.push({ name, outcome: 'unexpected_error', code: safe.code ?? 'non-database-error' });
          }
          return;
        }
        outcomes.push({ name, outcome: 'success', code: null });
        if (call.dedicatedGetter) {
          // This one explicit exception proves the seeded phone really exists
          // and is revealed only to the scoped partner for the consenting member.
          expect(name === 'get_shared_contact' && call.actor === fixture.partner).toBe(true);
          expect(rows.length === 1 && rows[0].phone === PHONE_A).toBe(true);
        } else {
          expectPhoneFree(rows); // Includes grant: raw input must never echo.
        }
      });
    }
    // Safe audit of coverage only: never log RPC response bodies or parameters.
    console.info('contact RPC privacy scan outcomes', JSON.stringify(outcomes));
    expect(failures).toEqual([]);
    expect(outcomes.map((outcome) => outcome.name)).toEqual(names);
    expect(outcomes.find((outcome) => outcome.name === 'get_shared_contact')?.outcome).toBe('success');
    expect(outcomes.find((outcome) => outcome.name === 'grant_contact_sharing')?.outcome).toBe('success');
    await phoneIs(swap, fixture.partner, fixture.owner.membershipId, PHONE_A);
  }, 120_000);
});
