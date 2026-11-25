import { useEffect, useId, useRef, useState } from 'react';
import {
  buildSchoolInviteShareUrl,
  formatSchoolInviteShareText,
} from '../../shared/care-credits';
import {
  buildSmsShareHref,
  buildWhatsAppShareHref,
  copyTextToClipboard,
  tryNativeShare,
} from '../lib/discussion-share';

/**
 * Compact School Parent Invite banner — both parents earn +1 Care Credit after verification.
 */
export function SchoolInviteCareBanner({
  careCredits = 2,
  onFeedback,
}: {
  careCredits?: number;
  onFeedback?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sheetId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const text = formatSchoolInviteShareText(careCredits);
  const url = buildSchoolInviteShareUrl();
  const payload = { title: 'Join SchoolRun Village', text, url };

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointer(event: MouseEvent | TouchEvent) {
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

  async function onShare() {
    const result = await tryNativeShare(payload);
    if (result === 'shared' || result === 'cancelled') return;
    setOpen(true);
  }

  async function copyLink() {
    const ok = await copyTextToClipboard(`${text}`);
    onFeedback?.(ok ? 'Invite link copied' : 'Could not copy the invite link on this device.');
    setOpen(false);
  }

  return (
    <aside className="school-invite-care" aria-labelledby="school-invite-care-title" ref={rootRef}>
      <div className="school-invite-care__copy min-w-0">
        <p className="eyebrow">Invite a school parent</p>
        <h3 id="school-invite-care-title">+1 Care Credit for both of you</h3>
        <p className="section-copy">
          Share SchoolRun Village with another verified school parent. After they join and verify, you both earn +1 Care Credit.
        </p>
      </div>
      <button
        type="button"
        className="secondary-button school-invite-care__cta"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        onClick={() => { void onShare(); }}
      >
        Share invite
      </button>
      {open ? (
        <div
          id={sheetId}
          className="marketplace-share__sheet school-invite-care__sheet"
          role="dialog"
          aria-label="Share school invite"
        >
          <p className="marketplace-share__sheet-title">Share</p>
          <div className="marketplace-share__channels" role="group" aria-label="Invite channels">
            <a className="marketplace-share__channel" href={buildSmsShareHref(payload)} onClick={() => setOpen(false)}>
              Message (SMS)
            </a>
            <button
              type="button"
              className="marketplace-share__channel"
              onClick={() => {
                window.open(buildWhatsAppShareHref(payload), '_blank', 'noopener,noreferrer');
                setOpen(false);
              }}
            >
              WhatsApp
            </button>
            <button type="button" className="marketplace-share__channel" onClick={() => { void copyLink(); }}>
              Copy link
            </button>
          </div>
          <button type="button" className="text-button marketplace-share__close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </aside>
  );
}
