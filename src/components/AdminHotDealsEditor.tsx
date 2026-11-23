import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { audDollarsToCents, formatAudCents, type ListingImagePayload } from '../../shared/marketplace';
import {
  validateHotDealUpsert,
  type HotDeal,
  type HotDealUpsertInput,
} from '../../shared/hot-deals';
import { hotDealsApi } from '../lib/hot-deals-api';
import { uploadListingVideo } from '../lib/listing-media';
import { ListingImageUploader } from './ListingImageUploader';

function centsToDollarsInput(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '';
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

const EMPTY_FORM: HotDealUpsertInput = {
  id: null,
  brandName: '',
  brandMark: '',
  title: '',
  summary: '',
  description: '',
  category: 'School & Nursery',
  originalAskAudCents: 0,
  groupAskAudCents: 0,
  joinedCount: 0,
  targetCount: 50,
  bonusDiscountAudCents: 0,
  ctaLabel: 'Join Group Buy',
  dealImages: [],
  videoUrl: null,
  status: 'active',
};

/**
 * Admin editor for Hot Deals media + detailed description.
 */
export function AdminHotDealsEditor({
  client,
  userId,
}: {
  client: SupabaseClient;
  userId: string;
}) {
  const formId = useId();
  const [deals, setDeals] = useState<HotDeal[]>([]);
  const [form, setForm] = useState<HotDealUpsertInput>(EMPTY_FORM);
  const [originalAskInput, setOriginalAskInput] = useState('');
  const [groupAskInput, setGroupAskInput] = useState('');
  const [bonusAskInput, setBonusAskInput] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<'teal' | 'red'>('teal');

  const refresh = useCallback(async () => {
    try {
      const next = await hotDealsApi.adminList(client);
      setDeals(next);
      setTone('teal');
      setMessage(null);
    } catch (error) {
      setDeals([]);
      setTone('red');
      setMessage(error instanceof Error
        ? error.message
        : 'Hot Deals could not be loaded for admin. Check your admin role and try again.');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => {
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
  }, [videoObjectUrl]);

  function loadDeal(deal: HotDeal) {
    setForm({
      id: deal.id,
      brandName: deal.brandName,
      brandMark: deal.brandMark,
      title: deal.title,
      summary: deal.summary,
      description: deal.description || deal.summary,
      category: deal.category,
      originalAskAudCents: deal.originalAskAudCents,
      groupAskAudCents: deal.groupAskAudCents,
      joinedCount: deal.joinedCount,
      targetCount: deal.targetCount,
      bonusDiscountAudCents: deal.bonusDiscountAudCents,
      ctaLabel: deal.ctaLabel,
      dealImages: deal.dealImages ?? [],
      videoUrl: deal.videoUrl ?? null,
      status: deal.status ?? 'active',
    });
    setOriginalAskInput(centsToDollarsInput(deal.originalAskAudCents));
    setGroupAskInput(centsToDollarsInput(deal.groupAskAudCents));
    setBonusAskInput(centsToDollarsInput(deal.bonusDiscountAudCents));
    setVideoFile(null);
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    setVideoObjectUrl(null);
    setMessage(`Editing “${deal.title}”.`);
    setTone('teal');
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setOriginalAskInput('');
    setGroupAskInput('');
    setBonusAskInput('');
    setVideoFile(null);
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    setVideoObjectUrl(null);
  }

  function onVideoChange(file: File | null) {
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    setVideoFile(file);
    setVideoObjectUrl(file ? URL.createObjectURL(file) : null);
    if (file) {
      setForm((current) => ({ ...current, videoUrl: null }));
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const originalAskAudCents = audDollarsToCents(originalAskInput) ?? 0;
    const groupAskAudCents = audDollarsToCents(groupAskInput) ?? 0;
    const bonusDiscountAudCents = audDollarsToCents(bonusAskInput) ?? 0;
    const draft: HotDealUpsertInput = {
      ...form,
      originalAskAudCents,
      groupAskAudCents,
      bonusDiscountAudCents,
      dealImages: form.dealImages,
      videoUrl: form.videoUrl,
    };
    const invalid = validateHotDealUpsert(draft);
    if (invalid) {
      setTone('red');
      setMessage(invalid);
      return;
    }

    setBusy(true);
    try {
      let videoUrl = draft.videoUrl;
      if (videoFile) {
        videoUrl = await uploadListingVideo(client, userId, videoFile);
      }
      const saved = await hotDealsApi.upsert(client, { ...draft, videoUrl });
      await refresh();
      loadDeal(saved);
      setTone('teal');
      setMessage('Hot Deal saved. Photos, video and description are ready for parents.');
    } catch (error) {
      setTone('red');
      setMessage(error instanceof Error ? error.message : 'That Hot Deal could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pattern-panel admin-hot-deals" aria-labelledby={`${formId}-title`}>
      <h2 id={`${formId}-title`}>Hot Deals editor</h2>
      <p className="section-copy">
        Attach photos, one video, and a detailed product description. Parents open the deal card for a Marketplace-style detail view.
      </p>
      {message ? (
        <p className={`notice notice--${tone}`} role={tone === 'red' ? 'alert' : 'status'}>{message}</p>
      ) : null}

      <ul className="admin-hot-deals__list">
        {deals.map((deal) => (
          <li key={deal.id}>
            <button type="button" className="text-button" onClick={() => loadDeal(deal)}>
              Edit: {deal.title}
            </button>
            <small>
              {deal.brandName}
              {' · '}
              {formatAudCents(deal.groupAskAudCents) ?? '$0 AUD'}
              {' · '}
              {(deal.dealImages?.length ?? 0)} photo{(deal.dealImages?.length ?? 0) === 1 ? '' : 's'}
              {deal.videoUrl ? ' · video' : ''}
            </small>
          </li>
        ))}
      </ul>

      <form className="stack-form" onSubmit={(event) => { void onSubmit(event); }}>
        <div className="admin-hot-deals__row">
          <label>
            Brand / partner
            <input
              required
              value={form.brandName}
              onChange={(event) => setForm((current) => ({ ...current, brandName: event.target.value }))}
              maxLength={80}
            />
          </label>
          <label>
            Brand mark
            <input
              required
              value={form.brandMark}
              onChange={(event) => setForm((current) => ({ ...current, brandMark: event.target.value.slice(0, 4) }))}
              maxLength={4}
            />
          </label>
        </div>
        <label>
          Deal title
          <input
            required
            value={form.title}
            onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            maxLength={160}
          />
        </label>
        <label>
          Card summary
          <textarea
            required
            rows={2}
            value={form.summary}
            onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))}
            maxLength={500}
          />
        </label>
        <label>
          Detailed description
          <textarea
            required
            rows={5}
            value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            maxLength={8000}
            placeholder="Full product details for the Hot Deal modal."
          />
        </label>
        <label>
          Category
          <input
            required
            value={form.category}
            onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
            maxLength={80}
          />
        </label>
        <div className="admin-hot-deals__row">
          <label>
            Original AUD
            <input
              required
              inputMode="decimal"
              value={originalAskInput}
              onChange={(event) => setOriginalAskInput(event.target.value)}
              placeholder="89"
            />
          </label>
          <label>
            Deal AUD
            <input
              required
              inputMode="decimal"
              value={groupAskInput}
              onChange={(event) => setGroupAskInput(event.target.value)}
              placeholder="59"
            />
          </label>
          <label>
            Bonus discount AUD
            <input
              inputMode="decimal"
              value={bonusAskInput}
              onChange={(event) => setBonusAskInput(event.target.value)}
              placeholder="15"
            />
          </label>
        </div>
        <div className="admin-hot-deals__row">
          <label>
            Joined count
            <input
              type="number"
              min={0}
              value={form.joinedCount}
              onChange={(event) => setForm((current) => ({
                ...current,
                joinedCount: Math.max(0, Number(event.target.value) || 0),
              }))}
            />
          </label>
          <label>
            Group-buy target
            <input
              type="number"
              min={1}
              value={form.targetCount}
              onChange={(event) => setForm((current) => ({
                ...current,
                targetCount: Math.max(1, Number(event.target.value) || 1),
              }))}
            />
          </label>
          <label>
            CTA
            <select
              value={form.ctaLabel}
              onChange={(event) => setForm((current) => ({
                ...current,
                ctaLabel: event.target.value === 'Buy Deal' ? 'Buy Deal' : 'Join Group Buy',
              }))}
            >
              <option value="Join Group Buy">Join Group Buy</option>
              <option value="Buy Deal">Buy Deal</option>
            </select>
          </label>
        </div>

        <fieldset className="admin-hot-deals__media">
          <legend>Photos & video</legend>
          <ListingImageUploader
            images={form.dealImages}
            onChange={(dealImages: ListingImagePayload[]) => setForm((current) => ({ ...current, dealImages }))}
            videoFile={videoFile}
            videoPreviewUrl={videoObjectUrl || form.videoUrl}
            onVideoChange={onVideoChange}
            disabled={busy}
            variant="classic"
          />
          <label>
            Or paste video HTTPS URL
            <input
              type="url"
              value={form.videoUrl ?? ''}
              onChange={(event) => {
                setVideoFile(null);
                if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
                setVideoObjectUrl(null);
                setForm((current) => ({
                  ...current,
                  videoUrl: event.target.value.trim() || null,
                }));
              }}
              placeholder="https://…"
              disabled={busy || Boolean(videoFile)}
            />
          </label>
        </fieldset>

        <div className="admin-hot-deals__actions">
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? 'Saving…' : form.id ? 'Update Hot Deal' : 'Create Hot Deal'}
          </button>
          <button className="secondary-button" type="button" disabled={busy} onClick={resetForm}>
            New deal
          </button>
        </div>
      </form>
    </section>
  );
}
