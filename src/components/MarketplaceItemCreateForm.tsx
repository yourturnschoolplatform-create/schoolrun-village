import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateMarketplaceAiDraft } from '../../shared/marketplace-ai-draft';
import {
  audDollarsToCents,
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CONDITIONS,
  MARKETPLACE_HOUSEHOLD_ENV,
  MARKETPLACE_SIZE_AGE_OPTIONS,
  offerLabelForTrade,
  tradeTypeToListingKind,
  type ListingImagePayload,
  type MarketplaceCategory,
  type MarketplaceCondition,
  type MarketplaceHouseholdEnv,
  type MarketplaceSizeAge,
  type MarketplaceTradeType,
} from '../../shared/marketplace';
import type { NeighbourhoodSuburbOption } from '../../shared/marketplace-neighbourhood';
import { nonPaymentNoticeForTrade } from '../../shared/payment-tracks';
import { listingsApi } from '../lib/listings-api';
import { ListingImageUploader } from './ListingImageUploader';

const TRADE_TABS: Array<{ id: MarketplaceTradeType; label: string; hint: string }> = [
  { id: 'sale', label: 'Sell', hint: 'AUD ask' },
  { id: 'free_share', label: 'Free', hint: 'Free Share' },
  { id: 'swap', label: 'Swap', hint: 'Barter' },
];

type WriteMode = 'ai' | 'manual';
type NoticeTone = 'teal' | 'red' | 'amber';

/**
 * Karrot-style marketplace compose form.
 * Keeps listings-api create + existing validation rules.
 */
export function MarketplaceItemCreateForm({
  client,
  defaultTrade = 'sale',
  suburbLabel = 'Local suburb',
  nearbySuburbs = [],
  boardMode = 'all',
  onNotice,
  onCreated,
}: {
  client: SupabaseClient;
  defaultTrade?: MarketplaceTradeType;
  suburbLabel?: string;
  nearbySuburbs?: NeighbourhoodSuburbOption[];
  boardMode?: 'all' | 'market' | 'relay';
  onNotice: (text: string, tone?: NoticeTone) => void;
  onCreated: () => void | Promise<void>;
}) {
  const [trade, setTrade] = useState<MarketplaceTradeType>(defaultTrade);
  const [askDollars, setAskDollars] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<MarketplaceCategory>('School & Nursery');
  const [images, setImages] = useState<ListingImagePayload[]>([]);
  const [condition, setCondition] = useState<MarketplaceCondition | ''>('Good');
  const [sizeAge, setSizeAge] = useState<MarketplaceSizeAge | ''>('');
  const [householdEnv, setHouseholdEnv] = useState<MarketplaceHouseholdEnv[]>([]);
  const [writeMode, setWriteMode] = useState<WriteMode>('manual');
  const [aiName, setAiName] = useState('');
  const [aiNotes, setAiNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedSuburb, setSelectedSuburb] = useState(suburbLabel);

  const suburbChoices = useMemo(() => {
    const map = new Map<string, NeighbourhoodSuburbOption | { suburb: string; distanceKm?: number }>();
    if (suburbLabel.trim()) {
      map.set(suburbLabel.trim().toLowerCase(), { suburb: suburbLabel.trim(), distanceKm: 0 });
    }
    for (const entry of nearbySuburbs) {
      map.set(entry.suburb.toLowerCase(), entry);
    }
    return [...map.values()];
  }, [nearbySuburbs, suburbLabel]);

  useEffect(() => {
    setTrade(defaultTrade);
  }, [defaultTrade]);

  useEffect(() => {
    if (!suburbLabel.trim()) return;
    setSelectedSuburb((current) => {
      if (!current.trim()) return suburbLabel;
      if (suburbChoices.some((entry) => entry.suburb.toLowerCase() === current.trim().toLowerCase())) {
        return current;
      }
      return suburbLabel;
    });
  }, [suburbChoices, suburbLabel]);

  const visibleTrades = TRADE_TABS.filter((tab) => {
    if (boardMode === 'relay') return tab.id !== 'sale';
    if (boardMode === 'market') return tab.id === 'sale';
    return true;
  });

  function toggleEnv(chip: MarketplaceHouseholdEnv) {
    setHouseholdEnv((current) => (
      current.includes(chip)
        ? current.filter((entry) => entry !== chip)
        : [...current, chip]
    ));
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    setAskDollars('');
    setImages([]);
    setCondition('Good');
    setSizeAge('');
    setHouseholdEnv([]);
    setAiName('');
    setAiNotes('');
    setWriteMode('manual');
  }

  function runAiDraft() {
    const name = aiName.trim() || title.trim();
    if (!name) {
      onNotice('Add an item name before generating a description.', 'amber');
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
    onNotice('AI Auto-Draft ready — review and edit before posting.', 'teal');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !description.trim() || busy) return;
    if (!condition) {
      onNotice('Choose a condition chip (New, Like New or Good).', 'amber');
      return;
    }
    const askAudCents = trade === 'sale' ? audDollarsToCents(askDollars) : null;
    if (trade === 'sale' && (askAudCents == null || askAudCents < 100)) {
      onNotice('Add a valid AUD ask of at least $1 (for example 50 or 50.00).', 'amber');
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
        areaLabel: selectedSuburb.trim() || suburbLabel.trim() || null,
      });
      resetForm();
      onNotice('Your listing is on the neighbourhood marketplace.', 'teal');
      await onCreated();
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : 'That listing could not be posted. Please try again.',
        'red',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="karrot-compose"
      onSubmit={(event) => void submit(event)}
      aria-labelledby="karrot-compose-title"
    >
      <div className="karrot-compose__head">
        <h3 id="karrot-compose-title">Write a listing</h3>
        <p>Photos, title, trade type and school pickup suburb.</p>
      </div>

      <ListingImageUploader
        images={images}
        onChange={setImages}
        disabled={busy}
        variant="karrot"
      />

      <label className="karrot-compose__field">
        <span>Title</span>
        <input
          required
          minLength={3}
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What are you listing?"
        />
      </label>

      <div className="karrot-compose__field">
        <span id="karrot-trade-label">Trade type</span>
        <div
          className="karrot-trade-tabs"
          role="tablist"
          aria-labelledby="karrot-trade-label"
        >
          {visibleTrades.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={trade === tab.id}
              className={
                trade === tab.id
                  ? 'karrot-trade-tab karrot-trade-tab--active'
                  : 'karrot-trade-tab'
              }
              onClick={() => {
                setTrade(tab.id);
                if (tab.id !== 'sale') setAskDollars('');
              }}
            >
              <strong>{tab.label}</strong>
              <small>{tab.hint}</small>
            </button>
          ))}
        </div>
        <p className="field-help">
          {trade === 'sale'
            ? 'Sell track: AUD ask shown on the card. Checkout opens from Buy Now.'
            : nonPaymentNoticeForTrade(trade)}
        </p>
      </div>

      {trade === 'sale' ? (
        <label className="karrot-compose__field karrot-compose__price">
          <span>Price (AUD)</span>
          <div className="karrot-compose__price-row">
            <span aria-hidden="true">$</span>
            <input
              required
              inputMode="decimal"
              min={1}
              step="1"
              value={askDollars}
              onChange={(event) => setAskDollars(event.target.value)}
              placeholder="0"
              aria-describedby="karrot-ask-help"
            />
          </div>
          <span id="karrot-ask-help" className="field-help">
            Whole dollars preferred. Shown as $50 AUD on the card.
          </span>
        </label>
      ) : (
        <div className="karrot-compose__offer" role="status">
          {trade === 'swap' ? 'Swap / barter — no AUD ask' : 'Free Share — no AUD ask'}
        </div>
      )}

      <label className="karrot-compose__field">
        <span>Category</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as MarketplaceCategory)}
        >
          {MARKETPLACE_CATEGORIES.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
      </label>

      <label className="karrot-compose__field">
        <span>Meetup suburb</span>
        <select
          value={selectedSuburb}
          onChange={(event) => setSelectedSuburb(event.target.value)}
          aria-label="Choose meetup suburb within 5 km"
        >
          {suburbChoices.map((entry) => (
            <option key={entry.suburb} value={entry.suburb}>
              {entry.suburb}
              {'distanceKm' in entry && entry.distanceKm != null && Number.isFinite(entry.distanceKm)
                ? ` · ${entry.distanceKm.toFixed(1)} km`
                : ''}
            </option>
          ))}
        </select>
        <span className="field-help">
          Defaults to your current suburb. Pick any neighbour within 5 km. Your school stays attached for Same school filters.
        </span>
      </label>

      <fieldset className="karrot-compose__field marketplace-spec-field">
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

      <fieldset className="karrot-compose__field marketplace-spec-field">
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

      <fieldset className="karrot-compose__field marketplace-spec-field">
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

      <div className="karrot-compose__field">
        <div className="karrot-compose__desc-head">
          <span>Description</span>
          <div className="marketplace-write-tabs" role="tablist" aria-label="Description writing mode">
            <button
              type="button"
              role="tab"
              aria-selected={writeMode === 'manual'}
              className={writeMode === 'manual' ? 'marketplace-write-tab marketplace-write-tab--active' : 'marketplace-write-tab'}
              onClick={() => setWriteMode('manual')}
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={writeMode === 'ai'}
              className={writeMode === 'ai' ? 'marketplace-write-tab marketplace-write-tab--active' : 'marketplace-write-tab'}
              onClick={() => setWriteMode('ai')}
            >
              AI draft
            </button>
          </div>
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
              Generate description
            </button>
          </div>
        ) : null}

        <textarea
          required
          maxLength={2000}
          rows={5}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Share condition, size and school pickup notes. Keep it phone-free."
        />
      </div>

      <button
        className="karrot-compose__submit"
        type="submit"
        disabled={busy || !title.trim() || !description.trim() || (trade === 'sale' && !askDollars.trim())}
      >
        {busy ? 'Posting…' : trade === 'sale' ? 'Post Sell listing' : 'Complete'}
      </button>
    </form>
  );
}
