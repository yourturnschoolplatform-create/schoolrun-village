import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NEARBY_SUBURB_RADIUS_KM } from '../data/auSuburbsData';
import {
  MARKETPLACE_CATEGORY_FILTERS,
  MARKETPLACE_TRADE_FILTERS,
  type MarketplaceCategory,
  type MarketplaceTradeType,
} from '../../shared/marketplace';
import {
  enrichListingNeighbourhood,
  filterListingsByScope,
  MARKETPLACE_SCOPE_FILTERS,
  nearbySuburbLabels,
  nearbySuburbOptions,
  resolveSuburbPlace,
  type MarketplaceScope,
  type NeighbourhoodSuburbOption,
  type ViewerMarketplacePlace,
} from '../../shared/marketplace-neighbourhood';
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
 * Neighbourhood marketplace (Karrot-style): Nearby 5 km default, My Suburb,
 * optional My School. Same-school badge + suburb distance on cards.
 */
export function MarketplaceBoard({
  client,
  userId,
  onOpenChat,
  initialTradeFilter = 'all',
  boardMode = 'all',
  viewerSuburb,
  initialListingId = null,
}: {
  client: SupabaseClient;
  userId: string;
  onOpenChat?: (room: ChatRoom) => void;
  /** Prefill trade filter (e.g. Relay Share → free_share). */
  initialTradeFilter?: 'all' | MarketplaceTradeType;
  /** Visual mode for Marketplace vs Relay Share panels. */
  boardMode?: 'all' | 'market' | 'relay';
  /** Optional suburb hint from school / profile (coords resolved locally). */
  viewerSuburb?: string | null;
  /** Deep-link into a specific listing detail sheet. */
  initialListingId?: string | null;
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
  const [scopeFilter, setScopeFilter] = useState<MarketplaceScope>('nearby');
  const [viewerPlace, setViewerPlace] = useState<ViewerMarketplacePlace | null>(null);
  const [nearbyOptions, setNearbyOptions] = useState<NeighbourhoodSuburbOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'teal' | 'red' | 'amber'>('teal');
  const [checkout, setCheckout] = useState<PaymentCheckoutRequest | null>(null);
  const [selected, setSelected] = useState<ItemListing | null>(null);
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  const [pendingListingId, setPendingListingId] = useState<string | null>(
    initialListingId && /^[0-9a-f-]{36}$/i.test(initialListingId) ? initialListingId : null,
  );

  const suburbLabel = useMemo(() => {
    if (viewerPlace?.suburb) return viewerPlace.suburb;
    const fromFeed = items.find((entry) => (entry.areaLabel || entry.schoolSuburb)?.trim());
    return (fromFeed?.areaLabel || fromFeed?.schoolSuburb || viewerSuburb || 'Local suburb').trim();
  }, [items, viewerPlace, viewerSuburb]);

  const areaLabels = useMemo(() => {
    if (viewerPlace) return nearbySuburbLabels(viewerPlace.lat, viewerPlace.lng, NEARBY_SUBURB_RADIUS_KM);
    if (suburbLabel && suburbLabel !== 'Local suburb') return [suburbLabel];
    return [];
  }, [viewerPlace, suburbLabel]);

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

  function enrichItems(raw: ItemListing[], place: ViewerMarketplacePlace | null): ItemListing[] {
    return raw.map((item) => {
      const meta = enrichListingNeighbourhood({
        areaLabel: item.areaLabel,
        schoolSuburb: item.schoolSuburb,
        sameSchool: item.sameSchool,
        schoolId: item.school_id,
        viewer: place,
      });
      return {
        ...item,
        areaLabel: meta.areaLabel,
        schoolSuburb: item.schoolSuburb || meta.areaLabel,
        sameSchool: meta.sameSchool,
        distanceKm: meta.distanceKm,
      };
    });
  }

  const refresh = useCallback(async () => {
    try {
      const raw = await listingsApi.search(client, {
        kind: tradeFilter === 'all' ? null : tradeFilter,
        category: categoryFilter === 'all' ? null : categoryFilter,
        scope: scopeFilter,
        areaLabels,
      });
      setItems(enrichItems(raw, viewerPlace));
    } catch {
      setMessageTone('amber');
      setMessage('Marketplace listings are available after school verification.');
    }
  }, [areaLabels, categoryFilter, client, scopeFilter, tradeFilter, viewerPlace]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!initialListingId || !/^[0-9a-f-]{36}$/i.test(initialListingId)) return;
    setPendingListingId(initialListingId);
    setCategoryFilter('all');
    setTradeFilter('all');
    setScopeFilter('nearby');
  }, [initialListingId]);

  useEffect(() => {
    if (!pendingListingId) return;
    const match = items.find((entry) => entry.id === pendingListingId);
    if (match) {
      setSelected(match);
      setPendingListingId(null);
      return;
    }
    if (items.length === 0) return;
    showNotice('Opened Marketplace. That listing may no longer be available nearby.', 'amber');
    setPendingListingId(null);
  }, [items, pendingListingId]);

  useEffect(() => {
    const fromHint = viewerSuburb ? resolveSuburbPlace(viewerSuburb) : null;
    if (fromHint) {
      setViewerPlace(fromHint);
      setNearbyOptions(nearbySuburbOptions(fromHint.lat, fromHint.lng));
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const nearby = nearbySuburbOptions(latitude, longitude);
        const current = nearby[0]
          ?? resolveSuburbPlace(viewerSuburb || '')
          ?? null;
        if (current) {
          const place: ViewerMarketplacePlace = {
            suburb: current.suburb,
            state: current.state,
            postcode: current.postcode,
            lat: current.lat,
            lng: current.lng,
          };
          setViewerPlace(place);
          setNearbyOptions(nearby.length ? nearby : nearbySuburbOptions(place.lat, place.lng));
        }
      },
      () => {
        // Keep suburb hint / feed-derived place; GPS is optional.
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 120_000 },
    );
  }, [viewerSuburb]);

  const visibleItems = useMemo(
    () => filterListingsByScope(items, scopeFilter, suburbLabel, NEARBY_SUBURB_RADIUS_KM),
    [items, scopeFilter, suburbLabel],
  );

  function guardOwnListing(authorId: string): boolean {
    if (!isOwnListing(authorId, userId)) return false;
    showNotice('This is your own listing.', 'amber');
    return true;
  }

  async function enquire(listing: ItemListing) {
    if (guardOwnListing(listing.author_id)) return;
    setBusy(true);
    try {
      await listingsApi.enquire(client, listing.id, 'Hi — is this still available for suburb pickup?');
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
        <p className="eyebrow">{boardMode === 'relay' ? 'Relay Share' : boardMode === 'market' ? 'Marketplace' : 'Neighbourhood marketplace'}</p>
        <h2 id="marketplace-title">
          {boardMode === 'relay'
            ? 'Free Share & Swap near you.'
            : boardMode === 'market'
              ? 'Kids secondhand near your suburb.'
              : 'Sell, share or swap in your neighbourhood.'}
        </h2>
        <p className="section-copy">
          {boardMode === 'relay'
            ? `Relay track: Free Share and Swap stay ${NON_PAYMENT_HANDOVER_COPY} Browse Nearby (5 km) first; use My School when you want same-school only.`
            : boardMode === 'market'
              ? 'Paid Sell listings use secure SchoolRun Village in-app payment (Stripe / PayID). Default feed is Nearby within 5 km of your suburb.'
              : `Dual-track settlement: Sell listings use secure in-app payment (Stripe / PayID). Free Share and Swap stay ${NON_PAYMENT_HANDOVER_COPY} Default scope is Nearby (5 km).`}
        </p>
      </div>

      <div className="marketplace-filters marketplace-filters--scope" role="toolbar" aria-label="Neighbourhood scope">
        {MARKETPLACE_SCOPE_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={
              scopeFilter === filter.id
                ? 'marketplace-filter marketplace-filter--scope marketplace-filter--active'
                : 'marketplace-filter marketplace-filter--scope'
            }
            aria-pressed={scopeFilter === filter.id}
            onClick={() => setScopeFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
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
        nearbySuburbs={nearbyOptions}
        boardMode={boardMode}
        onNotice={showNotice}
        onCreated={refresh}
      />

      <ul className="feed-list marketplace-list karrot-feed">
        {visibleItems.length === 0 && (
          <li className="section-copy">
            {scopeFilter === 'school'
              ? 'No active listings at your school for this filter right now.'
              : scopeFilter === 'suburb'
                ? `No active listings in ${suburbLabel} for this filter right now.`
                : `No active listings within ${NEARBY_SUBURB_RADIUS_KM} km of ${suburbLabel} right now.`}
          </li>
        )}
        {visibleItems.map((item) => (
          <li key={item.id} className="karrot-feed__item">
            <MarketplaceItemCard
              item={item}
              favoriteBusy={favoriteBusyId === item.id}
              canFavorite={!isOwnListing(item.author_id, userId)}
              onOpen={setSelected}
              onToggleFavorite={(listing) => void toggleFavorite(listing)}
              onShareFeedback={(text) => showNotice(text, 'teal')}
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
          onShareFeedback={(text) => showNotice(text, 'teal')}
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
