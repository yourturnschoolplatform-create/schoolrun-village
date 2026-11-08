import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  formatSchoolLocationChip,
  resolveSchoolLocation,
  schoolSectorBadge,
  statusLabelEnglish,
} from '../../shared/au-location';
import { generateMarketplaceAiDraft } from '../../shared/marketplace-ai-draft';
import {
  audDollarsToCents,
  formatAudCents,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_FILTERS,
  MARKETPLACE_CONDITIONS,
  MARKETPLACE_HOUSEHOLD_ENV,
  MARKETPLACE_SIZE_AGE_OPTIONS,
  MARKETPLACE_TRADE_FILTERS,
  offerLabelForTrade,
  tradeBadgeLabel,
  tradeTypeToListingKind,
  type ListingImagePayload,
  type MarketplaceCategory,
  type MarketplaceCondition,
  type MarketplaceHouseholdEnv,
  type MarketplaceSizeAge,
  type MarketplaceTradeType,
} from '../../shared/marketplace';
import { isOwnListing } from '../../shared/listing-create';
import {
  buyNowLabel,
  isInAppPayableListing,
  NON_PAYMENT_HANDOVER_COPY,
  nonPaymentNoticeForTrade,
} from '../../shared/payment-tracks';
import type { ChatRoom } from '../lib/chat-api';
import { listingsApi, type ItemListing } from '../lib/listings-api';
import { ListingImageCarousel } from './ListingImageCarousel';
import { ListingImageUploader } from './ListingImageUploader';
import { ParentTrustBadge } from './ParentTrustBadge';
import { PaymentCheckout, type PaymentCheckoutRequest } from './PaymentCheckout';

type WriteMode = 'ai' | 'manual';

/**
 * Same-school marketplace with Sell (AUD ask), Free Share, and Swap.
 * Listing images (up to 6), AI Auto-Draft, and smart feature chips.
 * Australian English. No in-app payments or phones.
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
  const [trade, setTrade] = useState<MarketplaceTradeType>(defaultTrade);
  const [askDollars, setAskDollars] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<MarketplaceCategory>('School & Nursery');
  const [images, setImages] = useState<ListingImagePayload[]>([]);
  const [condition, setCondition] = useState<MarketplaceCondition | ''>('Good');
  const [sizeAge, setSizeAge] = useState<MarketplaceSizeAge | ''>('');
  const [householdEnv, setHouseholdEnv] = useState<MarketplaceHouseholdEnv[]>([]);
  const [writeMode, setWriteMode] = useState<WriteMode>('ai');
  const [aiName, setAiName] = useState('');
  const [aiNotes, setAiNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'teal' | 'red' | 'amber'>('teal');
  const [checkout, setCheckout] = useState<PaymentCheckoutRequest | null>(null);

  function showNotice(text: string, tone: 'teal' | 'red' | 'amber' = 'teal') {
    setMessageTone(tone);
    setMessage(text);
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

  function toggleEnv(chip: MarketplaceHouseholdEnv) {
    setHouseholdEnv((current) => (
      current.includes(chip)
        ? current.filter((entry) => entry !== chip)
        : [...current, chip]
    ));
  }

  function runAiDraft() {
    const name = aiName.trim() || title.trim();
    if (!name) {
      showNotice('Add an item name before generating a description.', 'amber');
      return;
    }
    const draft = generateMarketplaceAiDraft({
      itemName: name,
      condition: condition || 'Good',
      keyNotes: aiNotes,
      sizeAge,
      householdEnv,
      category,
    });
    setDescription(draft);
    if (!title.trim()) setTitle(name.slice(0, 120));
    showNotice('AI Auto-Draft ready — review and edit before posting.', 'teal');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !description.trim() || busy) return;
    if (!condition) {
      showNotice('Choose a condition chip (New, Like New or Good).', 'amber');
      return;
    }
    const askAudCents = trade === 'sale' ? audDollarsToCents(askDollars) : null;
    if (trade === 'sale' && askAudCents == null) {
      showNotice('Add an AUD ask for Sell listings (for example 50).', 'amber');
      return;
    }
    setBusy(true);
    try {
      await listingsApi.create(client, {
        kind: tradeTypeToListingKind(trade),
        title: title.trim(),
        description: description.trim(),
        category,
        offerLabel: offerLabelForTrade(trade),
        askAudCents,
        listingImages: images,
        itemCondition: condition || 'Good',
        sizeAgeLabel: sizeAge || null,
        householdEnv: householdEnv ?? [],
      });
      setTitle('');
      setDescription('');
      setAskDollars('');
      setImages([]);
      setCondition('Good');
      setSizeAge('');
      setHouseholdEnv([]);
      setAiName('');
      setAiNotes('');
      showNotice('Your listing is on the school marketplace.', 'teal');
      await refresh();
    } catch (error) {
      showNotice(
        error instanceof Error ? error.message : 'That listing could not be posted. Please try again.',
        'red',
      );
    } finally {
      setBusy(false);
    }
  }

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
      const room = await listingsApi.openListingChat(client, listing.id);
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
      <p className="notice notice--amber" role="status">
        {trade === 'sale'
          ? 'Sell track: Buy Now opens checkout with platform service shown before PayID or Stripe.'
          : nonPaymentNoticeForTrade(trade)}
      </p>

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

      <form className="stack-form feed-compose" onSubmit={(event) => void submit(event)}>
        <ListingImageUploader images={images} onChange={setImages} disabled={busy} />

        <label>
          Trade type
          <select
            value={trade}
            onChange={(event) => {
              const next = event.target.value as MarketplaceTradeType;
              setTrade(next);
              if (next !== 'sale') setAskDollars('');
            }}
          >
            <option value="sale">Sell</option>
            <option value="free_share">Free Share (Relay)</option>
            <option value="swap">Swap / Barter</option>
          </select>
        </label>
        {trade === 'sale' ? (
          <label>
            Ask (AUD)
            <input
              required
              inputMode="decimal"
              min={1}
              step="1"
              value={askDollars}
              onChange={(event) => setAskDollars(event.target.value)}
              placeholder="e.g. 50"
              aria-describedby="marketplace-ask-help"
            />
            <span id="marketplace-ask-help" className="field-help">
              Whole dollars preferred. Shown as $50 AUD on the card. Settlement stays parent-to-parent.
            </span>
          </label>
        ) : null}
        <label>
          Category
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as MarketplaceCategory)}
          >
            {MARKETPLACE_CATEGORIES.map((entry) => (
              <option key={entry} value={entry}>{entry}</option>
            ))}
          </select>
        </label>

        <fieldset className="marketplace-spec-field">
          <legend>Condition</legend>
          <div className="marketplace-chip-row" role="group" aria-label="Condition">
            {MARKETPLACE_CONDITIONS.map((entry) => (
              <button
                key={entry}
                type="button"
                className={
                  condition === entry
                    ? 'marketplace-chip marketplace-chip--active'
                    : 'marketplace-chip'
                }
                aria-pressed={condition === entry}
                onClick={() => setCondition(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="marketplace-spec-field">
          <legend>Size / age</legend>
          <div className="marketplace-chip-row" role="group" aria-label="Size or age">
            {MARKETPLACE_SIZE_AGE_OPTIONS.map((entry) => (
              <button
                key={entry}
                type="button"
                className={
                  sizeAge === entry
                    ? 'marketplace-chip marketplace-chip--active'
                    : 'marketplace-chip'
                }
                aria-pressed={sizeAge === entry}
                onClick={() => setSizeAge((current) => (current === entry ? '' : entry))}
              >
                {entry}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="marketplace-spec-field">
          <legend>Household environment</legend>
          <div className="marketplace-chip-row" role="group" aria-label="Household environment">
            {MARKETPLACE_HOUSEHOLD_ENV.map((entry) => (
              <button
                key={entry}
                type="button"
                className={
                  householdEnv.includes(entry)
                    ? 'marketplace-chip marketplace-chip--active'
                    : 'marketplace-chip'
                }
                aria-pressed={householdEnv.includes(entry)}
                onClick={() => toggleEnv(entry)}
              >
                {entry}
              </button>
            ))}
          </div>
        </fieldset>

        <label>
          Title
          <input
            required
            minLength={3}
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Size 8 sports shorts"
          />
        </label>

        <div className="marketplace-write-tabs" role="tablist" aria-label="Description writing mode">
          <button
            type="button"
            role="tab"
            aria-selected={writeMode === 'ai'}
            className={writeMode === 'ai' ? 'marketplace-write-tab marketplace-write-tab--active' : 'marketplace-write-tab'}
            onClick={() => setWriteMode('ai')}
          >
            AI Auto-Draft
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={writeMode === 'manual'}
            className={writeMode === 'manual' ? 'marketplace-write-tab marketplace-write-tab--active' : 'marketplace-write-tab'}
            onClick={() => setWriteMode('manual')}
          >
            Write Myself
          </button>
        </div>

        {writeMode === 'ai' ? (
          <div className="marketplace-ai-panel" role="tabpanel">
            <label>
              Item name
              <input
                value={aiName}
                onChange={(event) => setAiName(event.target.value)}
                placeholder="e.g. Navy school jumper"
                maxLength={120}
              />
            </label>
            <label>
              Key notes
              <textarea
                rows={2}
                maxLength={400}
                value={aiNotes}
                onChange={(event) => setAiNotes(event.target.value)}
                placeholder="Fit, wear, accessories, pickup timing — keep it phone-free."
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={runAiDraft}
            >
              ✨ Generate Description with AI
            </button>
          </div>
        ) : null}

        <label>
          Description
          <textarea
            required
            maxLength={2000}
            rows={writeMode === 'ai' ? 5 : 3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={
              writeMode === 'ai'
                ? 'Generated draft appears here — edit freely before posting.'
                : 'Write a friendly AU marketplace description. Keep it phone-free.'
            }
          />
        </label>
        <button
          className="primary-button"
          type="submit"
          disabled={busy || !title.trim() || !description.trim() || (trade === 'sale' && !askDollars.trim())}
        >
          {busy ? 'Posting…' : trade === 'sale' ? 'Post Sell listing' : 'Post listing'}
        </button>
      </form>

      <ul className="feed-list marketplace-list">
        {items.length === 0 && (
          <li className="section-copy">No active listings for this filter at your school right now.</li>
        )}
        {items.map((item) => {
          const badge = tradeBadgeLabel(item.display_offer_label, item.listing_kind);
          const rawAsk = item.askAudDisplay || formatAudCents(item.askAudCents);
          const askDisplay = rawAsk && !/\bAUD\b/i.test(rawAsk) ? `${rawAsk} AUD` : rawAsk;
          const location = resolveSchoolLocation({
            displayName: item.schoolDisplayName || 'Your school',
            suburb: item.schoolSuburb,
            schoolSector: item.schoolSector,
          });
          const envChips = item.householdEnv ?? [];
          const ownListing = isOwnListing(item.author_id, userId);
          return (
            <li key={item.id} className="feed-card marketplace-card">
              <ListingImageCarousel images={item.listingImages} title={item.title} />
              <div className="marketplace-card__body">
                <div className="feed-card__top">
                  <strong>{item.title}</strong>
                  {askDisplay ? (
                    <span className="marketplace-ask">{askDisplay}</span>
                  ) : (
                    <span
                      className={
                        badge === 'FREE'
                          ? 'marketplace-badge marketplace-badge--free'
                          : badge === 'SWAP'
                            ? 'marketplace-badge marketplace-badge--swap'
                            : 'marketplace-badge marketplace-badge--sale'
                      }
                    >
                      {badge}
                    </span>
                  )}
                </div>
                <p className="marketplace-card__tags">
                  <span className="marketplace-tag">{item.category}</span>
                  {item.itemCondition ? (
                    <span className="marketplace-spec-badge">{item.itemCondition}</span>
                  ) : null}
                  {item.sizeAgeLabel ? (
                    <span className="marketplace-spec-badge">{item.sizeAgeLabel}</span>
                  ) : null}
                  {envChips.map((chip) => (
                    <span key={chip} className="marketplace-spec-badge marketplace-spec-badge--env">{chip}</span>
                  ))}
                  {askDisplay ? (
                    <span className="marketplace-badge marketplace-badge--sale">{badge}</span>
                  ) : null}
                  {ownListing ? <span className="marketplace-spec-badge">Your listing</span> : null}
                  <span className="feed-card__status">{statusLabelEnglish(item.status)}</span>
                </p>
                <p className="marketplace-card__seller">
                  <ParentTrustBadge
                    client={client}
                    peerUserId={item.author_id}
                    displayName={item.author_display_name}
                    band={item.authorParentTrustBand || item.authorTrustBand}
                    suburb={location.suburb}
                  />
                  <span className="marketplace-card__sector">{schoolSectorBadge(location.schoolSector)}</span>
                </p>
                <p className="feed-card__body">{item.description}</p>
                <small className="feed-card__byline">{formatSchoolLocationChip(location)}</small>
                <div className="feed-card__actions">
                  {ownListing ? (
                    <p className="field-help marketplace-own-hint">This is your own listing.</p>
                  ) : isInAppPayableListing(item.listing_kind) && (item.askAudCents ?? 0) > 0 ? (
                    <>
                      <button
                        className="commercial-cta feed-card__cta"
                        type="button"
                        disabled={busy}
                        onClick={() => setCheckout({
                          listingId: item.id,
                          title: item.title,
                          itemAskAudCents: item.askAudCents ?? 0,
                          kind: 'marketplace_sale',
                          primaryLabel: buyNowLabel(item.askAudCents),
                        })}
                      >
                        {buyNowLabel(item.askAudCents)}
                      </button>
                      <button
                        className="secondary-button feed-card__cta"
                        type="button"
                        disabled={busy || !onOpenChat}
                        onClick={() => void chatWithParent(item)}
                      >
                        Ask seller
                      </button>
                      <p className="field-help">In-app payment track · platform service shown at checkout</p>
                    </>
                  ) : (
                    <>
                      <button
                        className="secondary-button feed-card__cta"
                        type="button"
                        disabled={busy}
                        onClick={() => void enquire(item)}
                      >
                        Enquire
                      </button>
                      <button
                        className="primary-button feed-card__cta"
                        type="button"
                        disabled={busy || !onOpenChat}
                        onClick={() => void chatWithParent(item)}
                      >
                        Enquire / Chat
                      </button>
                      <p className="field-help">{NON_PAYMENT_HANDOVER_COPY}</p>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <PaymentCheckout
        request={checkout}
        onClose={() => setCheckout(null)}
        onPaid={(receipt) => showNotice(receipt, 'teal')}
      />
    </section>
  );
}
