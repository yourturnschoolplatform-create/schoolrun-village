import { formatDealAskAud, type HotDeal } from '../../shared/hot-deals';
import type { DiscussionSharePayload } from './discussion-share';

export type HotDealSharePayload = DiscussionSharePayload;

export function buildHotDealShareUrl(dealId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const params = new URLSearchParams({
    view: 'community',
    panel: 'deals',
    deal: dealId,
  });
  return `${origin}/?${params.toString()}`;
}

export function buildHotDealSharePayload(deal: Pick<
  HotDeal,
  'id' | 'title' | 'brandName' | 'groupAskAudCents' | 'summary'
>): HotDealSharePayload {
  const title = (deal.title || 'Hot Deal').trim().slice(0, 120);
  const price = formatDealAskAud(deal.groupAskAudCents);
  const brand = (deal.brandName || '').trim();
  const summary = (deal.summary || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const lines = [
    title,
    brand ? `${brand} · ${price}` : price,
    summary || null,
    'Exclusive SchoolRun Village Hot Deal',
  ].filter(Boolean) as string[];
  return {
    title,
    text: lines.join('\n'),
    url: buildHotDealShareUrl(deal.id),
  };
}

export {
  buildSmsShareHref,
  buildWhatsAppShareHref,
  copyTextToClipboard,
  formatDiscussionShareClipboard as formatHotDealShareClipboard,
  tryNativeShare,
} from './discussion-share';
