import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNearbySuburbsAndSchools,
  fetchSchoolsInSuburb,
} from '../../src/utils/auLocationService';

describe('auLocationService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to offline Melbourne schools when Overpass fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const schools = await fetchSchoolsInSuburb('Docklands', -37.815, 144.946);
    expect(schools.some((school) => /Docklands Primary/i.test(school.name))).toBe(true);
  });

  it('falls back to offline nearby suburbs when live lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const result = await fetchNearbySuburbsAndSchools(-37.815, 144.946);
    expect(result.source).toBe('fallback');
    expect(result.suburbs.length).toBeGreaterThan(0);
    expect(result.suburbs.some((suburb) => suburb.name === 'Docklands')).toBe(true);
  });
});
