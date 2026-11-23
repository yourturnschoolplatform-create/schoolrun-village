export type DiscussionSharePayload = {
  title: string;
  text: string;
  url: string;
};

const EXCERPT_MAX = 160;

export function excerptDiscussionText(raw: string | null | undefined, max = EXCERPT_MAX): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Direct SPA URL into a school discussion thread (optional post anchor). */
export function buildDiscussionShareUrl(threadId: string, postId?: string | null): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({
    view: 'community',
    panel: 'discussions',
    thread: threadId,
  });
  if (postId && /^[0-9a-f-]{36}$/i.test(postId)) {
    params.set('post', postId);
  }
  return `${origin}/?${params.toString()}`;
}

export function buildDiscussionSharePayload(input: {
  threadId: string;
  threadTitle: string;
  excerpt?: string | null;
  postId?: string | null;
  kind?: 'thread' | 'post' | 'comment';
}): DiscussionSharePayload {
  const title = (input.threadTitle || 'SchoolRun Village discussion').trim().slice(0, 120);
  const excerpt = excerptDiscussionText(input.excerpt);
  const kind = input.kind ?? 'thread';
  const label = kind === 'comment'
    ? 'Comment from a school discussion'
    : kind === 'post'
      ? 'Post from a school discussion'
      : 'School discussion';
  const text = excerpt
    ? `${title}\n\n${excerpt}\n\n${label} on SchoolRun Village`
    : `${title}\n\n${label} on SchoolRun Village`;
  return {
    title,
    text,
    url: buildDiscussionShareUrl(input.threadId, input.postId),
  };
}

export function formatDiscussionShareClipboard(payload: DiscussionSharePayload): string {
  return `${payload.text}\n\n${payload.url}`;
}

export function buildSmsShareHref(payload: DiscussionSharePayload): string {
  const body = encodeURIComponent(`${payload.text}\n${payload.url}`);
  return `sms:?body=${body}`;
}

export function buildWhatsAppShareHref(payload: DiscussionSharePayload): string {
  const text = encodeURIComponent(`${payload.text}\n${payload.url}`);
  return `https://wa.me/?text=${text}`;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Prefer the platform share sheet when available.
 * Returns: shared | cancelled | unavailable | failed
 */
export async function tryNativeShare(
  payload: DiscussionSharePayload,
): Promise<'shared' | 'cancelled' | 'unavailable' | 'failed'> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'unavailable';
  }
  try {
    await navigator.share({
      title: payload.title,
      text: payload.text,
      url: payload.url,
    });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return 'cancelled';
    }
    // Some browsers reject if the gesture was lost — treat as unavailable for menu fallback.
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'unavailable';
    }
    return 'failed';
  }
}
