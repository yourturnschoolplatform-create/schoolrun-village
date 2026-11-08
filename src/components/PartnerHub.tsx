import { useState, type FormEvent } from 'react';
import {
  PARTNER_INQUIRY_CATEGORIES,
  validatePartnerInquiry,
  type PartnerInquiryCategory,
} from '../../shared/hot-deals';
import { partnerApi } from '../lib/partner-api';

/**
 * B2B merchant inquiry modal — Partner with Us.
 */
export function PartnerHub({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [businessName, setBusinessName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [category, setCategory] = useState<PartnerInquiryCategory>('Goods Deal');
  const [proposedTerms, setProposedTerms] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<'teal' | 'red' | 'amber'>('teal');

  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      businessName,
      contactEmail,
      contactNumber,
      category,
      proposedTerms,
      message,
    };
    const invalid = validatePartnerInquiry(input);
    if (invalid) {
      setToastTone('amber');
      setToast(invalid);
      return;
    }
    setBusy(true);
    try {
      const result = await partnerApi.submitInquiry(input);
      setBusinessName('');
      setContactEmail('');
      setContactNumber('');
      setCategory('Goods Deal');
      setProposedTerms('');
      setMessage('');
      setToastTone('teal');
      setToast(result.message);
    } catch (error) {
      setToastTone('red');
      setToast(error instanceof Error ? error.message : 'Your partner inquiry could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="partner-hub-overlay" role="presentation" onClick={onClose}>
      <section
        className="partner-hub-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="partner-hub-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="partner-hub-modal__head">
          <div>
            <p className="eyebrow">Partner Hub</p>
            <h2 id="partner-hub-title">Partner with Us</h2>
            <p className="section-copy">
              Local businesses and brands can propose school-scoped deals, tutoring packs or sponsorships.
            </p>
          </div>
          <button type="button" className="text-button" onClick={onClose}>Close</button>
        </div>

        {toast ? (
          <p className={`notice notice--${toastTone} marketplace-toast`} role={toastTone === 'red' ? 'alert' : 'status'}>
            {toast}
          </p>
        ) : null}

        <form className="stack-form" onSubmit={(event) => void submit(event)}>
          <label>
            Business name
            <input
              required
              minLength={2}
              maxLength={120}
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              placeholder="e.g. Harbour Kids Co."
            />
          </label>
          <label>
            Contact email
            <input
              required
              type="email"
              maxLength={160}
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
              placeholder="partnerships@brand.com.au"
            />
          </label>
          <label>
            Contact number
            <input
              inputMode="tel"
              maxLength={20}
              value={contactNumber}
              onChange={(event) => setContactNumber(event.target.value)}
              placeholder="Optional AU business number"
            />
            <span className="field-help">Business contact only — not shown to parents.</span>
          </label>
          <label>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as PartnerInquiryCategory)}
            >
              {PARTNER_INQUIRY_CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>{entry}</option>
              ))}
            </select>
          </label>
          <label>
            Proposed deal / commission terms
            <textarea
              required
              minLength={8}
              maxLength={500}
              rows={3}
              value={proposedTerms}
              onChange={(event) => setProposedTerms(event.target.value)}
              placeholder="e.g. 15% school cohort rate + $2 referral credit"
            />
          </label>
          <label>
            Brief message
            <textarea
              required
              minLength={8}
              maxLength={2000}
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Tell us about your offer for verified school parents."
            />
          </label>
          <button className="commercial-cta" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Submit partner inquiry'}
          </button>
        </form>
      </section>
    </div>
  );
}
