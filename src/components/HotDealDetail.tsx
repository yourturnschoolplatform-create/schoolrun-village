import { useEffect, useId } from 'react';
import {
  dealProgressCopy,
  dealProgressPercent,
  formatDealAskAud,
  type HotDeal,
} from '../../shared/hot-deals';
import { joinAndPayLabel } from '../../shared/payment-tracks';
import { HotDealShareButton } from './HotDealShareButton';
import { ListingImageCarousel } from './ListingImageCarousel';

/**
 * Marketplace-style Hot Deal detail sheet with Save, Share and Join & Pay.
 */
export function HotDealDetail({
  deal,
  busy = false,
  onClose,
  onSave,
  onJoinPay,
  onShareFeedback,
}: {
  deal: HotDeal & { viewerJoined?: boolean };
  busy?: boolean;
  onClose: () => void;
  onSave: (deal: HotDeal) => void;
  onJoinPay: (deal: HotDeal & { viewerJoined?: boolean }) => void;
  onShareFeedback?: (message: string) => void;
}) {
  const titleId = useId();
  const percent = dealProgressPercent(deal.joinedCount, deal.targetCount);
  const saved = Boolean(deal.viewerHasSaved);
  const joined = Boolean(deal.viewerJoined);
  const description = (deal.description || deal.summary || '').trim();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="karrot-detail-overlay" role="presentation" onClick={onClose}>
      <aside
        className="karrot-detail hot-deal-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="karrot-detail__top">
          <button type="button" className="text-button" onClick={onClose}>Close</button>
          <span className="karrot-detail__status">{deal.category}</span>
        </div>

        <div className="karrot-detail__media">
          <ListingImageCarousel
            images={deal.dealImages}
            title={deal.title}
            videoUrl={deal.videoUrl}
          />
        </div>

        <div className="karrot-detail__copy">
          <p className="hot-deal-card__brand-name">{deal.brandName}</p>
          <div className="hot-deal-detail__asks">
            <span className="hot-deal-card__ask-original">{formatDealAskAud(deal.originalAskAudCents)}</span>
            <span className="karrot-detail__price">{formatDealAskAud(deal.groupAskAudCents)}</span>
          </div>
          <h3 id={titleId}>{deal.title}</h3>
          <p className="karrot-detail__body">{description}</p>
          <p className="hot-deal-card__progress-copy">{dealProgressCopy(deal)}</p>
          <div
            className="hot-deal-card__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${deal.joinedCount} of ${deal.targetCount} parents joined`}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className="karrot-detail__bar hot-deal-detail__bar">
          <button
            type="button"
            className={saved ? 'karrot-detail__heart karrot-detail__heart--on' : 'karrot-detail__heart'}
            disabled={busy}
            aria-pressed={saved}
            aria-label={saved ? 'Remove from saved Hot Deals' : 'Save Hot Deal'}
            title={saved ? 'Saved' : 'Save'}
            onClick={() => onSave(deal)}
          >
            <span aria-hidden="true">{saved ? '♥' : '♡'}</span>
            <span className="hot-deal-detail__save-label">{saved ? 'Saved' : 'Save'}</span>
          </button>
          <HotDealShareButton
            deal={deal}
            stopPropagation
            onFeedback={onShareFeedback}
          />
          <button
            type="button"
            className="karrot-detail__chat hot-deal-detail__join"
            disabled={busy || joined}
            onClick={() => onJoinPay(deal)}
          >
            {joined ? 'Paid & joined' : joinAndPayLabel(deal.groupAskAudCents)}
          </button>
        </div>
      </aside>
    </div>
  );
}
