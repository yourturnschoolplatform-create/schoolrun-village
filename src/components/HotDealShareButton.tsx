import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import type { HotDeal } from '../../shared/hot-deals';
import {
  buildHotDealSharePayload,
  buildSmsShareHref,
  buildWhatsAppShareHref,
  copyTextToClipboard,
  formatHotDealShareClipboard,
  tryNativeShare,
  type HotDealSharePayload,
} from '../lib/hot-deal-share';

export function HotDealShareButton({
  deal,
  label = 'Share',
  compact = false,
  stopPropagation = false,
  onFeedback,
}: {
  deal: Pick<HotDeal, 'id' | 'title' | 'brandName' | 'groupAskAudCents' | 'summary'>;
  label?: string;
  compact?: boolean;
  stopPropagation?: boolean;
  onFeedback?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sheetId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const payload: HotDealSharePayload = buildHotDealSharePayload(deal);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointer(event: globalThis.MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) setOpen(false);
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

  function guardClick(event: MouseEvent) {
    if (stopPropagation) event.stopPropagation();
  }

  async function onShareClick(event: MouseEvent<HTMLButtonElement>) {
    guardClick(event);
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

  async function copyLink(event: MouseEvent) {
    guardClick(event);
    const ok = await copyTextToClipboard(payload.url);
    onFeedback?.(ok ? 'Link copied' : 'Could not copy the link on this device.');
    setOpen(false);
  }

  async function copyForWeChatKakao(event: MouseEvent) {
    guardClick(event);
    const ok = await copyTextToClipboard(formatHotDealShareClipboard(payload));
    onFeedback?.(ok
      ? 'Copied for WeChat / KakaoTalk'
      : 'Could not copy on this device. Long-press the link instead.');
    setOpen(false);
  }

  function openExternal(event: MouseEvent, href: string) {
    guardClick(event);
    window.open(href, '_blank', 'noopener,noreferrer');
    setOpen(false);
  }

  return (
    <div
      className={compact ? 'marketplace-share marketplace-share--compact' : 'marketplace-share'}
      ref={rootRef}
      onClick={guardClick}
    >
      <button
        type="button"
        className={
          compact
            ? 'text-button marketplace-share__trigger'
            : 'secondary-button marketplace-share__trigger'
        }
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={(event) => { void onShareClick(event); }}
      >
        {label}
      </button>
      {open ? (
        <div
          id={sheetId}
          className="marketplace-share__sheet"
          role="dialog"
          aria-label="Share Hot Deal"
        >
          <p className="marketplace-share__sheet-title">Share</p>
          <div className="marketplace-share__channels" role="group" aria-label="Share channels">
            <a
              className="marketplace-share__channel"
              href={buildSmsShareHref(payload)}
              onClick={(event) => {
                guardClick(event);
                setOpen(false);
              }}
            >
              Message (SMS)
            </a>
            <button
              type="button"
              className="marketplace-share__channel"
              onClick={(event) => openExternal(event, buildWhatsAppShareHref(payload))}
            >
              WhatsApp
            </button>
            <button
              type="button"
              className="marketplace-share__channel"
              onClick={(event) => { void copyForWeChatKakao(event); }}
            >
              WeChat / KakaoTalk
            </button>
            <button
              type="button"
              className="marketplace-share__channel"
              onClick={(event) => { void copyLink(event); }}
            >
              Copy link
            </button>
          </div>
          <button
            type="button"
            className="text-button marketplace-share__close"
            onClick={(event) => {
              guardClick(event);
              setOpen(false);
            }}
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
