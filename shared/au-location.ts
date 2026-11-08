/** Australian school location helpers. Suburb-only — never street address or coordinates. */

export type SchoolSector = 'primary' | 'secondary';

export type SchoolLocation = {
  suburb: string;
  schoolName: string;
  schoolSector: SchoolSector;
};

export function schoolSectorBadge(sector: SchoolSector): string {
  return sector === 'secondary' ? 'Secondary School' : 'Primary School';
}

export function formatSchoolLocationChip(location: SchoolLocation): string {
  return `${location.suburb} · ${location.schoolName}`;
}

/** Infer sector from common Australian school naming. */
export function inferSchoolSector(schoolName: string): SchoolSector {
  const lower = schoolName.toLowerCase();
  if (/\b(high|secondary|college)\b/.test(lower)) return 'secondary';
  return 'primary';
}

/**
 * Build a display location from school row fields, with English-safe fallbacks
 * when suburb/sector columns are not yet populated.
 */
export function resolveSchoolLocation(input: {
  displayName: string;
  suburb?: string | null;
  schoolSector?: string | null;
}): SchoolLocation {
  const schoolName = input.displayName.trim() || 'Your school';
  const suburb = (input.suburb ?? '').trim()
    || schoolName
      .replace(/\b(sample)\b/gi, '')
      .replace(/\b(public|primary|secondary|high|school|college)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    || 'Local suburb';
  const sectorRaw = (input.schoolSector ?? '').toLowerCase();
  const schoolSector: SchoolSector = sectorRaw === 'secondary'
    ? 'secondary'
    : sectorRaw === 'primary'
      ? 'primary'
      : inferSchoolSector(schoolName);
  return { suburb, schoolName, schoolSector };
}

export function statusLabelEnglish(status: string): string {
  const key = status.trim().toLowerCase();
  const map: Record<string, string> = {
    open: 'Open',
    matched: 'Matched',
    expired: 'Expired',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    proposed: 'Proposed',
    accepted: 'Accepted',
    declined: 'Declined',
    withdrawn: 'Withdrawn',
    active: 'Active',
    pending: 'Pending',
    confirmed: 'Confirmed',
    collected: 'Collected',
    fulfilled: 'Fulfilled',
    hidden: 'Hidden',
  };
  return map[key] ?? status.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function intentLabelEnglish(intent: 'need_help' | 'can_help'): string {
  return intent === 'need_help' ? 'I need help' : 'I can help';
}

export function directionLabelEnglish(direction: 'pickup' | 'dropoff'): string {
  return direction === 'pickup' ? 'Pickup' : 'Drop-off';
}
