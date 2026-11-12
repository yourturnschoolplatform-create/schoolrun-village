import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Day 11/12 instant pickup board boundary', () => {
  it('posts via direct table insert, uses suburb labels, and enables realtime without money fields', async () => {
    const api = await readFile(resolve('src/lib/instant-pickup-api.ts'), 'utf8');
    const sql = await readFile(resolve('db/migrations/0055_day11_instant_pickup_requests.sql'), 'utf8');
    const day12 = await readFile(resolve('db/migrations/0056_day12_live_matching_and_reminders.sql'), 'utf8');
    expect(api).not.toMatch(/\.rpc\(\s*['"]create_instant_pickup_request['"]/);
    expect(api).not.toMatch(/\.rpc\(\s*['"]list_instant_pickup_requests['"]/);
    expect(api).toContain("client.rpc('accept_instant_pickup_request'");
    expect(api).toContain('p_request_id:');
    expect(api).toContain("rpc<InstantPickupRequest>(client, 'check_in_instant_pickup'");
    expect(api).toMatch(/p_request_id:\s*args\.p_request_id|p_request_id:\s*assertRequestId/);
    expect(api).toContain("table: 'instant_pickup_requests'");
    expect(api).toContain(".from('instant_pickup_requests')");
    expect(api).toContain('.insert(payload)');
    expect(api).toContain('requester_id');
    expect(api).toContain('area_label');
    expect(sql).toMatch(/create table public\.instant_pickup_requests/i);
    expect(sql).toMatch(/is_suburb_area_label/i);
    expect(sql).toMatch(/community_text_is_allowed/i);
    expect(sql).toMatch(/public\.is_member/i);
    expect(sql).toMatch(/supabase_realtime/i);
    expect(sql).toMatch(/yourturn\.instant_pickup_mutate/i);
    expect(day12).toMatch(/function public\.accept_instant_pickup_request/i);
    expect(day12).toMatch(/function public\.check_in_instant_pickup/i);
    expect(day12).toMatch(/interval '30 minutes'/i);
    expect(day12).toMatch(/pg_catalog\.date_part\('isodow'/i);
    expect(day12).not.toMatch(/pg_catalog\.extract\s*\(\s*isodow\s+from/i);
    expect(sql).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|nickname|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });
});
