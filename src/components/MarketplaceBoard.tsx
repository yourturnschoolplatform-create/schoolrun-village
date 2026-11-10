import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MARKETPLACE_CATEGORY_FILTERS,
  MARKETPLACE_TRADE_FILTERS,
  type MarketplaceCategory,
  type MarketplaceTradeType,
} from '../../shared/marketplace';
import { isOwnListing } from '../../shared/listing-create';
import {
  buyNowLabel,
  NON_PAYMENT_HANDOVER_COPY,
} from '../../shared/payment-tracks';
import type { ChatRoom } from '../lib/chat-api';
import { listingsApi, type ItemListing } from '../lib/listings-api';
import { MarketplaceItemCard } from './MarketplaceItemCard';
import { MarketplaceItemCreateForm } from './MarketplaceItemCreateForm';
import { MarketplaceItemDetail } from './MarketplaceItemDetail';
import { PaymentCheckout, type PaymentCheckoutRequest } from './PaymentCheckout';

/**
 * Same-school marketplace with Sell (AUD ask), Free Share, and Swap.
 * Karrot-style compose + feed cards. Australian English. No phones.
 */
export function MarketplaceBoard({
  client,
  userId,
  onOpenChat,
  initialTradeFilter = 'all',
  boardMode = 'all',
}: {
  client: SupabaseClient;
  userId: string;
  onOpenChat?: (room: ChatRoom) => void;
  /** Prefill trade filter (e.g. Relay Share → free_share). */
  initialTradeFilter?: 'all' | MarketplaceTradeType;
  /** Visual mode for Marketplace vs Relay Share panels. */
  boardMode?: 'all' | 'market' | 'relay';
}) {
  const defaultTrade: MarketplaceTradeType = boardMode === 'relay'
    ? 'free_share'
    : boardMode === 'market'
      ? 'sale'
      : 'sale';
  const defaultFilter: 'all' | MarketplaceTradeType = boardMode === 'relay'
    ? (initialTradeFilter === 'all' ? 'free_share' : initialTradeFilter)
    : boardMode === 'market'
      ? (initialTradeFilter === 'all' ? 'sale' : initialTradeFilter)
      : initialTradeFilter;

  const [items, setItems] = useState<ItemListing[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<'all' | MarketplaceCategory>('all');
  const [tradeFilter, setTradeFilter] = useState<'all' | MarketplaceTradeType>(defaultFilter);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'teal' | 'red' | 'amber'>('teal');
  const [checkout, setCheckout] = useState<PaymentCheckoutRequest | null>(null);
  const [selected, setSelected] = useState<ItemListing | null>(null);
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);

  const suburbLabel = useMemo(() => {
    const fromFeed = items.find((entry) => entry.schoolSuburb?.trim())?.schoolSuburb?.trim();
    return fromFeed || 'Local suburb';
  }, [items]);

  function showNotice(text: string, tone: 'teal' | 'red' | 'amber' = 'teal') {
    setMessageTone(tone);
    setMessage(text);
  }

  function applyFavoriteState(listingId: string, favorited: boolean, favoriteCount: number) {
    setItems((current) => current.map((entry) => (
      entry.id === listingId
        ? { ...entry, viewerHasFavorited: favorited, favoriteCount }
        : entry
    )));
    setSelected((current) => (
      current && current.id === listingId
        ? { ...current, viewerHasFavorited: favorited, favoriteCount }
        : current
    ));
  }

  const refresh = useCallback(async () => {
    try {
      setItems(await listingsApi.search(client, {
        kind: tradeFilter === 'all' ? null : tradeFilter,
        category: categoryFilter === 'all' ? null : categoryFilter,
      }));
    } catch {
      setMessageTone('amber');
      setMessage('Marketplace listings are available after school verification.');
    }
  }, [categoryFilter, client, tradeFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  function guardOwnListing(authorId: string): boolean {
    if (!isOwnListing(authorId, userId)) return false;
    showNotice('This is your own listing.', 'amber');
    return true;
  }

  async function enquire(listing: ItemListing) {
    if (guardOwnListing(listing.author_id)) return;
    setBusy(true);
    try {
      await listingsApi.enquire(client, listing.id, 'Hi — is this still available for school pickup?');
      showNotice('Enquiry sent to the listing parent.', 'teal');
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : 'That enquiry could not be sent right now.',
        'red',
      );
    } finally {
      setBusy(false);
    }
  }

  async function chatWithParent(listing: ItemListing) {
    if (guardOwnListing(listing.author_id)) return;
    if (!onOpenChat) {
      await enquire(listing);
      return;
    }
    setBusy(true);
    try {
      const room = await listingsApi.openListingChat(client, listing.id, listing);
      onOpenChat(room);
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : 'Chat with that parent is not available right now. Try Enquire instead.',
        'red',
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite(listing: ItemListing) {
    if (guardOwnListing(listing.author_id)) return;
    if (favoriteBusyId) return;
    const previousFavorited = Boolean(listing.viewerHasFavorited);
    const previousCount = listing.favoriteCount ?? 0;
    const optimisticFavorited = !previousFavorited;
    const optimisticCount = Math.max(0, previousCount + (optimisticFavorited ? 1 : -1));
    applyFavoriteState(listing.id, optimisticFavorited, optimisticCount);
    setFavoriteBusyId(listing.id);
    try {
      const result = await listingsApi.toggleFavorite(client, listing.id);
      applyFavoriteState(result.listingId, result.favorited, result.favoriteCount);
    } catch (error) {
      applyFavoriteState(listing.id, previousFavorited, previousCount);
      showNotice(
        error instanceof Error ? error.message : 'That favourite could not be updated right now.',
        'red',
      );
    } finally {
      setFavoriteBusyId(null);
    }
  }

  return (
    <section className="feed-section marketplace-board" aria-labelledby="marketplace-title" data-board-mode={boardMode}>
      <div className="feed-section__intro">
        <p className="eyebrow">{boardMode === 'relay' ? 'Relay Share' : boardMode === 'market' ? 'Marketplace' : 'School marketplace'}</p>
        <h2 id="marketplace-title">
          {boardMode === 'relay'
            ? 'Free Share & Swap at your school.'
            : boardMode === 'market'
              ? 'Kids secondhand & paid Sell.'
              : 'Sell, share or swap at your school.'}
        </h2>
        <p className="section-copy">
          {boardMode === 'relay'
            ? `Relay track: Free Share and Swap stay ${NON_PAYMENT_HANDOVER_COPY}`
            : boardMode === 'market'
              ? 'Paid Sell listings use secure SchoolRun Village in-app payment (Stripe / PayID) with platform service shown at checkout.'
              : `Dual-track settlement: Sell listings use secure in-app payment (Stripe / PayID). Free Share and Swap stay ${NON_PAYMENT_HANDOVER_COPY}`}
        </p>
      </div>

      <div className="marketplace-filters" role="toolbar" aria-label="Marketplace categories">
        {MARKETPLACE_CATEGORY_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={
              categoryFilter === filter.id
                ? 'marketplace-filter marketplace-filter--active'
                : 'marketplace-filter'
            }
            aria-pressed={categoryFilter === filter.id}
            onClick={() => setCategoryFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div className="marketplace-filters marketplace-filters--trade" role="toolbar" aria-label="Trade type">
        {MARKETPLACE_TRADE_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={
              tradeFilter === filter.id
                ? 'marketplace-filter marketplace-filter--trade marketplace-filter--active'
                : 'marketplace-filter marketplace-filter--trade'
            }
            aria-pressed={tradeFilter === filter.id}
            onClick={() => setTradeFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {message ? (
        <p
          className={`notice notice--${messageTone} marketplace-toast`}
          role={messageTone === 'red' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}

      <MarketplaceItemCreateForm
        client={client}
        defaultTrade={defaultTrade}
        suburbLabel={suburbLabel}
        boardMode={boardMode}
        onNotice={showNotice}
        onCreated={refresh}
      />

      <ul className="feed-list marketplace-list karrot-feed">
        {items.length === 0 && (
          <li className="section-copy">No active listings for this filter at your school right now.</li>
        )}
        {items.map((item) => (
          <li key={item.id} className="karrot-feed__item">
            <MarketplaceItemCard
              item={item}
              favoriteBusy={favoriteBusyId === item.id}
              canFavorite={!isOwnListing(item.author_id, userId)}
              onOpen={setSelected}
              onToggleFavorite={(listing) => void toggleFavorite(listing)}
            />
          </li>
        ))}
      </ul>

      {selected ? (
        <MarketplaceItemDetail
          client={client}
          userId={userId}
          item={selected}
          busy={busy}
          favoriteBusy={favoriteBusyId === selected.id}
          onClose={() => setSelected(null)}
          onChat={(listing) => {
            setSelected(null);
            void chatWithParent(listing);
          }}
          onToggleFavorite={(listing) => void toggleFavorite(listing)}
          onBuyNow={(listing) => {
            setSelected(null);
            setCheckout({
              listingId: listing.id,
              title: listing.title,
              itemAskAudCents: listing.askAudCents ?? 0,
              kind: 'marketplace_sale',
              primaryLabel: buyNowLabel(listing.askAudCents),
            });
          }}
        />
      ) : null}

      <PaymentCheckout
        request={checkout}
        onClose={() => setCheckout(null)}
        onPaid={(receipt) => showNotice(receipt, 'teal')}
      />
    </section>
  );
}
