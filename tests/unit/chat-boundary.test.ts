import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Day 11 direct chat boundary', () => {
  it('keeps chat writes on RPCs and uses Realtime only for message inserts', async () => {
    const api = await readFile(resolve('src/lib/chat-api.ts'), 'utf8');
    const hub = await readFile(resolve('src/components/ChatHub.tsx'), 'utf8');
    const sql = await readFile(resolve('db/migrations/0054_day11_direct_chat.sql'), 'utf8');
    expect(api).toContain("rpc<ChatRoom[]>(client, 'list_my_chat_rooms')");
    expect(api).toContain("rpc<ChatRoom>(client, 'get_or_create_schedule_chat'");
    expect(api).toContain("rpc<ChatRoom>(client, 'get_or_create_swap_chat'");
    expect(api).toContain("rpc<ChatMessage>(client, 'send_chat_message'");
    expect(api).toContain("table: 'chat_messages'");
    expect(api).toContain("event: 'INSERT'");
    expect(api).not.toContain('.from(');
    expect(hub).toContain('SchedulePin');
    expect(hub).toContain('chatApi.subscribeMessages');
    expect(hub).toContain('readByPeer');
    expect(sql).toMatch(/create table public\.chat_rooms/i);
    expect(sql).toMatch(/create table public\.chat_participants/i);
    expect(sql).toMatch(/create table public\.chat_messages/i);
    expect(sql).toMatch(/supabase_realtime/i);
    expect(sql).toMatch(/community_text_is_allowed/i);
    expect(sql).toMatch(/set search_path = pg_catalog/i);
    expect(sql).not.toMatch(
      /\b(amount|price|currency|money|fee|payment|phone|mobile|photo_url|latitude|longitude)\s+(text|numeric|integer|bigint|smallint|double precision|jsonb)\b/i,
    );
  });
});
