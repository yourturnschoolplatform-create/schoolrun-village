import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
const sql = await readFile('db/migrations/0020_day5_two_step_handover.sql', 'utf8');
const remediation = await readFile('db/migrations/0021_day5_handover_analytics_lock_order.sql', 'utf8');
const allowlist = JSON.parse(await readFile('db/function_allowlist.json', 'utf8')) as {
  authenticated: Array<{ name: string; searchPath?: string }>;
  internal: Array<{ name: string; searchPath?: string }>;
};

describe('Task 5.3 handover static contract (not live RLS evidence)', () => {
  it('orders completion analytics actor keys before conflict handling across different proposals', () => {
    expect(remediation).toMatch(/order by m\.user_id\s+on conflict do nothing/);
    expect(remediation).toContain('set search_path=pg_catalog');
    expect(remediation).toContain('revoke all on function public.record_leg_confirmation(uuid,text) from public,anon,authenticated;');
  });
  it('allows only a leg identifier in public confirmation wrappers with fixed kinds', () => {
    for (const [name, kind] of [['confirm_pickup_done', 'pickup_done'], ['confirm_child_arrived', 'child_arrived']]) {
      expect(sql).toContain(`create function public.${name}(p_leg_id uuid)`);
      expect(sql).toContain(`select public.record_leg_confirmation(p_leg_id,'${kind}');`);
    }
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('number_confirmed=2 and leg.completed_at is null');
    expect(sql).toContain('unique (swap_leg_id,confirmation_kind)');
  });
  it('restricts reminder records to an overdue accepted leg with exactly one confirmation', () => {
    expect(sql).toContain('number_confirmed<>1');
    expect(sql).toContain("event_time<leg.expected_arrival_at+interval '30 minutes'");
    expect(sql).toContain('leg.completed_at is not null');
    expect(sql).toContain('unique (swap_leg_id,missing_confirmation)');
    expect(sql).toContain('handover history is immutable');
    expect(sql).toContain('for update');
  });
  it('lists every new function with pg_catalog-only path and grants only the intended browser commands', () => {
    const names = [...sql.matchAll(/create function public\.(\w+)\(/g)].map((match) => match[1]);
    expect(names).toHaveLength(7);
    for (const name of names) {
      const declaration = [...allowlist.authenticated, ...allowlist.internal].find((row) => row.name === name);
      expect(declaration?.searchPath).toBe('pg_catalog');
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^;]*from public,anon,authenticated;`));
    }
    expect(sql).toContain('grant execute on function public.enqueue_due_handover_reminders() to service_role;');
    expect(sql).toContain('create unique index analytics_first_trip_completed_once');
  });
});
