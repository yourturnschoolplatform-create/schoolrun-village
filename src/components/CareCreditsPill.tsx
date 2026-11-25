import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  careHelperTierLabel,
  feeWaiverProgressCopy,
  type CareCreditWallet,
  DEFAULT_CARE_WALLET,
} from '../../shared/care-credits';
import { careCreditsApi } from '../lib/care-credits-api';

/**
 * Compact Care Credits balance + Helper tier progress for the top bar / Today strip.
 */
export function CareCreditsPill({
  client,
  wallet: walletProp = null,
  compact = false,
}: {
  client: SupabaseClient | null;
  wallet?: CareCreditWallet | null;
  compact?: boolean;
}) {
  const [wallet, setWallet] = useState<CareCreditWallet>(walletProp ?? DEFAULT_CARE_WALLET);

  useEffect(() => {
    if (walletProp) {
      setWallet(walletProp);
      return;
    }
    if (!client) return;
    let cancelled = false;
    void careCreditsApi.getWallet(client).then((next) => {
      if (!cancelled) setWallet(next);
    });
    return () => { cancelled = true; };
  }, [client, walletProp]);

  const tier = careHelperTierLabel(wallet.helperTier);
  const progress = feeWaiverProgressCopy(wallet);

  return (
    <span
      className={compact ? 'care-credits-pill care-credits-pill--compact' : 'care-credits-pill'}
      title={progress}
      aria-label={`${wallet.careCredits} Care Credits. ${tier}. ${progress}`}
      data-care-credits={wallet.careCredits}
      data-helper-tier={wallet.helperTier}
    >
      <strong>{wallet.careCredits}</strong>
      <span className="care-credits-pill__label">Care Credits</span>
      <span className="care-credits-pill__tier">{tier}</span>
    </span>
  );
}
