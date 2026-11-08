/** Structured chat payload for one-time household confirmation codes. */
export const HOUSEHOLD_CODE_PREFIX = 'HOUSEHOLD_CONFIRM_CODE::';

export function encodeHouseholdCodeCard(code: string): string {
  const cleaned = code.trim();
  return `${HOUSEHOLD_CODE_PREFIX}${cleaned}`;
}

export function parseHouseholdCodeCard(body: string): string | null {
  const text = body.trim();
  if (!text.startsWith(HOUSEHOLD_CODE_PREFIX)) return null;
  const code = text.slice(HOUSEHOLD_CODE_PREFIX.length).trim();
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(code) && code.length !== 48) {
    // Accept the platform's fixed 48-char codes and a cautious alphanumeric range.
    if (code.length < 16 || code.length > 64) return null;
  }
  return code || null;
}

export function isHouseholdCodeCard(body: string): boolean {
  return parseHouseholdCodeCard(body) !== null;
}
