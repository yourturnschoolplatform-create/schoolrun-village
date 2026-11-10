import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPublicRuntimeConfig, isBrowserSafeSupabaseKey, isServerOnlySupabaseKey } from '../../server/config.js';
import { TRUST_POLICY_DEFAULTS, trustBandFor } from '../../shared/trust-policy.js';

describe('trust policy defaults', () => {
  it('retains all confirmed Day 1 threshold boundaries', () => {
    expect(TRUST_POLICY_DEFAULTS.startScore).toBe(70);
    expect(TRUST_POLICY_DEFAULTS.bands).toEqual({
      trusted: 85,
      standard: 60,
      caution: 40,
      restricted: 20,
      suspendedBelow: 20,
    });
    expect(TRUST_POLICY_DEFAULTS.changes.confirmedNoShow).toBe(-20);
    expect(TRUST_POLICY_DEFAULTS.changes.confirmedNoShowWithBackup).toBe(-10);
    expect(TRUST_POLICY_DEFAULTS.confirmedNoShowTripsOwed).toBe(2);
  });

  it('returns a band rather than exposing a score interpretation to other parents', () => {
    expect(trustBandFor(85)).toBe('Trusted');
    expect(trustBandFor(84)).toBe('Standard');
    expect(trustBandFor(59)).toBe('Caution');
    expect(trustBandFor(20)).toBe('Restricted');
    expect(trustBandFor(19)).toBe('Suspended');
    expect(trustBandFor(100, true)).toBe('Suspended');
  });
});

describe('Supabase key boundary', () => {
  it('accepts supported browser-safe and server-only key formats without confusing them', () => {
    const legacyAnonJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature';
    const legacyServiceJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature';
    expect(isBrowserSafeSupabaseKey(legacyAnonJwt)).toBe(true);
    expect(isServerOnlySupabaseKey(legacyAnonJwt)).toBe(false);
    expect(isBrowserSafeSupabaseKey(legacyServiceJwt)).toBe(false);
    expect(isServerOnlySupabaseKey(legacyServiceJwt)).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_abcdefghijklmnopqrstuv')).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_a+/bcdefghijklmno==')).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_key.with:current-format')).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_key with copy whitespace')).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_   ')).toBe(false);
    expect(isBrowserSafeSupabaseKey('sb_secret_abcdefghijklmnopqrstuv')).toBe(false);
    expect(isServerOnlySupabaseKey('sb_secret_abcdefghijklmnopqrstuv')).toBe(true);
    expect(isServerOnlySupabaseKey('sb_publishable_abcdefghijklmnopqrstuv')).toBe(false);
  });

  it('exposes only the explicitly public runtime shape to the browser', () => {
    const publicRuntime = readPublicRuntimeConfig();
    expect(publicRuntime.appName).toBe('SchoolRun Village');
    expect(Object.keys(publicRuntime).sort()).toEqual(['appName', 'configured', 'supabase'].sort());
    expect(typeof publicRuntime.configured).toBe('boolean');
    expect(JSON.stringify(publicRuntime)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('keeps the service-role key reference in the dedicated server admin module only', async () => {
    const serviceKeyName = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
    const clientFiles = [
      'src/App.tsx',
      'src/main.tsx',
      'src/lib/runtime-config.ts',
      'public/sw.js',
    ];
    const nonAdminServerFiles = ['server/config.ts', 'server/index.ts', 'server/supabase/request-client.ts'];
    const sourceFiles = [...clientFiles, ...nonAdminServerFiles];

    for (const file of sourceFiles) {
      const content = await readFile(resolve(file), 'utf8');
      expect(content).not.toContain(serviceKeyName);
    }

    const adminContent = await readFile(resolve('server/admin/service-role.ts'), 'utf8');
    expect(adminContent).toContain(serviceKeyName);

    const relayTransport = await readFile(resolve('server/admin/email-relay.ts'), 'utf8');
    expect(relayTransport).toContain("from './service-role.js'");
    expect(relayTransport).toContain('claim_email_relay_batch');
    expect(relayTransport).toContain('handover_reminder');
    expect(relayTransport).not.toContain('SMTP_PASSWORD');
    for (const file of clientFiles) {
      const content = await readFile(resolve(file), 'utf8');
      expect(content).not.toContain('email-relay');
      expect(content).not.toContain('claim_email_relay_batch');
    }
  });
});

describe('PWA cache contract', () => {
  it('declares a route manifest and rejects API/auth/cross-origin caching', async () => {
    const [routes, worker] = await Promise.all([
      readFile(resolve('public/manus-routes.json'), 'utf8'),
      readFile(resolve('public/sw.js'), 'utf8'),
    ]);
    expect(JSON.parse(routes)).toEqual({ routes: [{ path: '/', title: 'SchoolRun Village foundation' }] });
    expect(worker).toContain("url.origin !== self.location.origin");
    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).toContain("url.pathname.startsWith('/auth/')");
    expect(worker).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
