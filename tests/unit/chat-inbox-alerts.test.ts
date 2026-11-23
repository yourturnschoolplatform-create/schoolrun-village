import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUnreadDocumentTitle } from '../../src/lib/chat-inbox-alerts';

describe('chat inbox document title', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefixes unread count when the document is hidden', () => {
    const doc = { title: 'SchoolRun Village', hidden: true };
    vi.stubGlobal('document', doc);
    applyUnreadDocumentTitle(3);
    expect(doc.title).toBe('(3) SchoolRun Village');
  });

  it('restores the base title when focused or unread is zero', () => {
    const doc = { title: '(2) SchoolRun Village', hidden: false };
    vi.stubGlobal('document', doc);
    applyUnreadDocumentTitle(2);
    expect(doc.title).toBe('SchoolRun Village');

    doc.hidden = true;
    applyUnreadDocumentTitle(0);
    expect(doc.title).toBe('SchoolRun Village');
  });
});
