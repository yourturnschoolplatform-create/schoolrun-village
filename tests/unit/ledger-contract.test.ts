import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const sql = await readFile('db/migrations/0018_day5_trip_count_ledger.sql', 'utf8');
const allowlist = JSON.parse(await readFile('db/function_allowlist.json', 'utf8')) as {
  authenticated: Array<{ name: string; searchPath?: string }>;
  internal: Array<{ name: string; searchPath?: string }>;
};

describe('Task 5.1 ledger schema contract', () => {
  it('restricts stored facts to the non-transferable source pair and integer trips', () => {
    const table = sql.split('create table public.swap_ledger_entries (')[1]?.split('\n);')[0];
    expect(table).toBeDefined();
    expect(table).toContain('trip_count_delta integer not null check (trip_count_delta = 1)');
    expect(table).toContain('swap_leg_id uuid not null unique');
    expect(table).toContain('check (from_membership <> to_membership)');
    expect(table).not.toMatch(/\b(amount|price|currency|money|transfer|third_party|balance)\w*\s+(numeric|integer|text|uuid|bigint)/i);
    expect(table).toContain("interval '1344 hours'");
    expect(table).toContain("interval '1008 hours'");
  });

  it('adds raising row and truncate guards and revokes all client writes', () => {
    expect(sql).toContain('before insert or update or delete on public.swap_ledger_entries');
    expect(sql).toContain('before truncate on public.swap_ledger_entries');
    expect(sql).toContain("raise exception 'trip ledger history is append-only'");
    expect(sql).toContain('revoke all on table public.swap_ledger_entries from public, anon, authenticated;');
    expect(sql).toContain('grant select on table public.swap_ledger_entries to authenticated;');
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|truncate).*to authenticated/i);
  });

  it('uses a caller-derived RPC with pair-only netting and read-time silent expiry', () => {
    expect(sql).toContain('create function public.get_my_ledger()');
    expect(sql).toContain('membership.user_id = auth.uid()');
    expect(sql).toContain('caller.id in (entry.from_membership, entry.to_membership)');
    expect(sql).toContain('from own_entries where not is_expired group by partner_membership');
    expect(sql).toContain("'trips_i_owe', greatest(net_count, 0)");
    expect(sql).toContain("'trips_owed_to_me', greatest(-net_count, 0)");
    expect(sql).not.toMatch(/update public\.swap_ledger_entries|delete from public\.swap_ledger_entries/i);
  });

  it('declares every new function with explicit grants, pg_catalog-only path and allowlist scope', () => {
    const functions = [...sql.matchAll(/create function public\.(\w+)\([^)]*\)[\s\S]*?\$\$;/g)];
    expect(functions.map((match) => match[1])).toEqual([
      'guard_swap_ledger_entry', 'record_completed_swap_leg', 'get_my_ledger',
    ]);
    for (const [definition, name] of functions) {
      expect(definition).toMatch(/set search_path = pg_catalog\s+as \$\$/);
      expect(sql).toContain(`revoke all on function public.${name}() from public, anon, authenticated;`);
      const declaration = [...allowlist.authenticated, ...allowlist.internal].find((entry) => entry.name === name);
      expect(declaration?.searchPath).toBe('pg_catalog');
    }
    expect(allowlist.authenticated.some((entry) => entry.name === 'get_my_ledger')).toBe(true);
    expect(allowlist.internal.map((entry) => entry.name)).toContain('record_completed_swap_leg');
  });
});
