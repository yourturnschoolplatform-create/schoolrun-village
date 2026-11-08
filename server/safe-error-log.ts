/**
 * Server-console-only diagnostics. Never log message, details, stack, bodies,
 * tokens, or values that may contain phones / emails / PII.
 */
export function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown };
  if (typeof record.code === 'string' && record.code.length <= 64) return record.code;
  if (typeof record.code === 'number' && Number.isFinite(record.code)) return String(record.code);
  return null;
}

export function logSafeServerError(context: string, error: unknown): void {
  const attrs: { context: string; name?: string; code?: string } = { context };
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown };
    if (typeof record.name === 'string' && record.name.length <= 120) {
      attrs.name = record.name;
    }
  }
  const code = databaseErrorCode(error);
  if (code) attrs.code = code;
  console.error('Request failed; safe error attributes only.', attrs);
}
