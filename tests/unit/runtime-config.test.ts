import { afterEach, describe, expect, it, vi } from 'vitest';

describe('fetchRuntimeConfig resilience', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns a config object when public-config fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const { fetchRuntimeConfig } = await import('../../src/lib/runtime-config');
    const config = await fetchRuntimeConfig();
    expect(config.appName).toBeTruthy();
    expect(config).toHaveProperty('supabase');
  });

  it('returns a config object when public-config responds non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })));
    const { fetchRuntimeConfig } = await import('../../src/lib/runtime-config');
    const config = await fetchRuntimeConfig();
    expect(config.appName).toBeTruthy();
    expect(config).toHaveProperty('supabase');
  });
});
