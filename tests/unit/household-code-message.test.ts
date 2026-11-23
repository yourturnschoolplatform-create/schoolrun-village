import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  encodeHouseholdCodeCard,
  isHouseholdCodeCard,
  parseHouseholdCodeCard,
} from '../../shared/household-code-message';

describe('household confirmation chat cards', () => {
  it('encodes and parses confirmation code cards', () => {
    const code = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
    const body = encodeHouseholdCodeCard(code);
    expect(isHouseholdCodeCard(body)).toBe(true);
    expect(parseHouseholdCodeCard(body)).toBe(code);
    expect(parseHouseholdCodeCard('hello')).toBeNull();
  });

  it('wires copy button, Request Match Karrot chat and confirm CTA', async () => {
    const hub = await readFile(resolve('src/components/ScheduleHub.tsx'), 'utf8');
    const board = await readFile(resolve('src/components/InstantPickupBoard.tsx'), 'utf8');
    const drawer = await readFile(resolve('src/components/MatchChatDrawer.tsx'), 'utf8');
    const css = await readFile(resolve('src/styles.css'), 'utf8');

    expect(hub).toContain('📋 Copy');
    expect(hub).toContain('✅ Copied!');
    expect(hub).toContain('copyHouseholdCode');
    expect(board).toContain('Request Match');
    expect(board).toContain('MatchChatDrawer');
    expect(board).toContain('pickupSummary');
    expect(board).toContain('onOpenInMessages');
    expect(drawer).toContain('listing-chat-overlay');
    expect(drawer).toContain('Share match code');
    expect(drawer).toContain('Confirm & Accept Match');
    expect(drawer).toContain('claimHouseholdCode');
    expect(drawer).toContain('encodeHouseholdCodeCard');
    expect(drawer).toContain('On my way');
    expect(drawer).toContain('At the school gate');
    expect(css).toContain('.household-code__copy');
    expect(css).toContain('.match-chat-drawer');
    expect(css).toContain('.listing-chat-overlay');
    expect(css).toContain('.chat-pin--pickup');
    expect(css).toContain('.household-code-card');
  });
});
