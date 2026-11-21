import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNearbySuburbsAndSchools,
  fetchSchoolsInSuburb,
  getNearbySuburbs,
  searchAustralianSuburbs,
} from '../../src/utils/auLocationService';

describe('auLocationService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves nearby suburbs in-memory for Docklands without fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchNearbySuburbsAndSchools(-37.815, 144.946);
    expect(result.source).toBe('live');
    expect(result.suburbs.length).toBeGreaterThan(0);
    expect(result.currentSuburb?.name).toMatch(/Docklands|Melbourne|Southbank|West Melbourne/i);
    expect(result.suburbs.every((suburb) => suburb.distanceKm <= 5 || suburb === result.suburbs[0])).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('finds outer-Melbourne suburbs (Craigieburn) within 5 km locally', () => {
    // ~40 km north of CBD — must not fall back to Docklands/Fitzroy/St Kilda only
    const result = getNearbySuburbs(-37.594, 144.934, 5);
    expect(result.source).toBe('live');
    expect(result.currentSuburb?.name).toMatch(/Craigieburn/i);
    expect(result.suburbs.some((suburb) => /Docklands|Fitzroy|St Kilda/i.test(suburb.name))).toBe(false);
    expect(result.suburbs.every((suburb) => suburb.nearby)).toBe(true);
  });

  it('searches Australian suburbs and postcodes locally', () => {
    const hits = searchAustralianSuburbs('3030');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.postcode === '3030')).toBe(true);

    const byName = searchAustralianSuburbs('Pakenham');
    expect(byName.some((hit) => /Pakenham/i.test(hit.name))).toBe(true);
  });

  it('falls back to offline Melbourne schools when Overpass mirrors fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const schools = await fetchSchoolsInSuburb('Docklands', -37.815, 144.946);
    expect(schools.some((school) => /Docklands Primary/i.test(school.name))).toBe(true);
  });

  it('tries secondary Overpass mirror after the first times out', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('overpass.kumi.systems')) {
        throw new Error('timeout');
      }
      return {
        ok: true,
        json: async () => ({
          elements: [
            { type: 'node', id: 1, tags: { name: 'Mirror High School' } },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const schools = await fetchSchoolsInSuburb('Craigieburn', -37.594, 144.934);
    expect(schools.some((school) => school.name === 'Mirror High School')).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('overpass.kumi.systems');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('overpass-api.de');
  });
});
