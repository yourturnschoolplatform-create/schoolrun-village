import { useEffect, useId, useRef, useState } from 'react';
import {
  buildDiscussionSharePayload,
  buildSmsShareHref,
  buildWhatsAppShareHref,
  copyTextToClipboard,
  formatDiscussionShareClipboard,
  tryNativeShare,
  type DiscussionSharePayload,
} from '../lib/discussion-share';

type ShareKind = 'thread' | 'post' | 'comment';

/**
 * Compact Share control for discussion threads / posts / comments.
 * Uses navigator.share when available, then a fallback channel sheet.
 */
export function DiscussionShareButton({
  threadId,
  threadTitle,
  excerpt = null,
  postId = null,
  kind = 'thread',
  label = 'Share',
  compact = false,
  onFeedback,
}: {
  threadId: string;
  threadTitle: string;
  excerpt?: string | null;
  postId?: string | null;
  kind?: ShareKind;
  label?: string;
  compact?: boolean;
  onFeedback?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sheetId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const payload: DiscussionSharePayload = buildDiscussionSharePayload({
    threadId,
    threadTitle,
    excerpt,
    postId,
    kind,
  });

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointer(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open]);

  function feedback(message: string) {
    onFeedback?.(message);
  }

  async function onShareClick() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await tryNativeShare(payload);
      if (result === 'shared' || result === 'cancelled') return;
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    const ok = await copyTextToClipboard(payload.url);
    feedback(ok ? 'Copied' : 'Could not copy the link on this device.');
    setOpen(false);
  }

  async function copyForWeChatKakao() {
    const ok = await copyTextToClipboard(formatDiscussionShareClipboard(payload));
    feedback(ok
      ? 'Copied for WeChat / KakaoTalk'
      : 'Could not copy on this device. Long-press the link instead.');
    setOpen(false);
  }

  function openExternal(href: string) {
    window.open(href, '_blank', 'noopener,noreferrer');
    setOpen(false);
  }

  return (
    <div className={compact ? 'discussion-share discussion-share--compact' : 'discussion-share'} ref={rootRef}>
      <button
        type="button"
        className={compact ? 'text-button discussion-share__trigger' : 'secondary-button feed-card__cta discussion-share__trigger'}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={() => { void onShareClick(); }}
      >
        {label}
      </button>

      {open ? (
        <div
          id={sheetId}
          className="discussion-share__sheet"
          role="dialog"
          aria-label="Share discussion"
        >
          <p className="discussion-share__sheet-title">Share</p>
          <div className="discussion-share__channels" role="group" aria-label="Share channels">
            <a
              className="discussion-share__channel"
              href={buildSmsShareHref(payload)}
              onClick={() => setOpen(false)}
            >
              Message (SMS)
            </a>
            <button
              type="button"
              className="discussion-share__channel"
              onClick={() => openExternal(buildWhatsAppShareHref(payload))}
            >
              WhatsApp
            </button>
            <button
              type="button"
              className="discussion-share__channel"
              onClick={() => { void copyForWeChatKakao(); }}
            >
              WeChat / KakaoTalk
            </button>
            <button
              type="button"
              className="discussion-share__channel"
              onClick={() => { void copyLink(); }}
            >
              Copy link
            </button>
          </div>
          <button
            type="button"
            className="text-button discussion-share__close"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
