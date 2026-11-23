import { describe, expect, it } from 'vitest';
import {
  buildDiscussionSharePayload,
  buildDiscussionShareUrl,
  buildSmsShareHref,
  buildWhatsAppShareHref,
  excerptDiscussionText,
  formatDiscussionShareClipboard,
} from '../../src/lib/discussion-share';

describe('discussion share helpers', () => {
  it('builds a direct thread URL with optional post id', () => {
    const url = buildDiscussionShareUrl(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(url).toContain('view=community');
    expect(url).toContain('panel=discussions');
    expect(url).toContain('thread=11111111-1111-4111-8111-111111111111');
    expect(url).toContain('post=22222222-2222-4222-8222-222222222222');
  });

  it('builds English share text with title, excerpt and url', () => {
    const payload = buildDiscussionSharePayload({
      threadId: '11111111-1111-4111-8111-111111111111',
      threadTitle: 'Wet-weather pickup tips',
      excerpt: 'Bring an extra towel for the after-school rush.',
      kind: 'post',
    });
    expect(payload.title).toBe('Wet-weather pickup tips');
    expect(payload.text).toContain('Bring an extra towel');
    expect(payload.text).toContain('SchoolRun Village');
    expect(payload.url).toContain('panel=discussions');
    expect(formatDiscussionShareClipboard(payload)).toContain(payload.url);
    expect(buildSmsShareHref(payload)).toMatch(/^sms:\?body=/);
    expect(buildWhatsAppShareHref(payload)).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it('clips long excerpts cleanly', () => {
    const long = 'a'.repeat(200);
    const clipped = excerptDiscussionText(long, 40);
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(clipped.endsWith('…')).toBe(true);
  });
});
