import type { TrustBand } from './trust-policy';
import { trustBandFor } from './trust-policy';

/** Australian parent-reliability presentation labels. Peers never see numeric scores. */
export type ParentTrustBandLabel =
  | 'Gold Guardian'
  | 'Silver Partner'
  | 'Bronze Parent'
  | 'Suspended';

export type ParentTrustTone = 'gold' | 'silver' | 'bronze' | 'suspended';

export function parentTrustLabelForBand(band: string | null | undefined): ParentTrustBandLabel {
  switch ((band ?? '').trim()) {
    case 'Trusted':
    case 'Gold Guardian':
      return 'Gold Guardian';
    case 'Standard':
    case 'Silver Partner':
      return 'Silver Partner';
    case 'Suspended':
      return 'Suspended';
    case 'Caution':
    case 'Restricted':
    case 'Bronze Parent':
    default:
      return 'Bronze Parent';
  }
}

export function parentTrustTone(label: ParentTrustBandLabel): ParentTrustTone {
  if (label === 'Gold Guardian') return 'gold';
  if (label === 'Silver Partner') return 'silver';
  if (label === 'Suspended') return 'suspended';
  return 'bronze';
}

export function parentTrustLabelForScore(score: number, adminSuspended = false): ParentTrustBandLabel {
  return parentTrustLabelForBand(trustBandFor(score, adminSuspended));
}

export type ParentTrustProfile = {
  peerUserId: string;
  displayName: string;
  trustBand: TrustBand | string;
  parentTrustBand: ParentTrustBandLabel;
  schoolSuburb: string;
  verifiedSchool: boolean;
  successfulPickups: number;
  communityRelayShares: number;
};
