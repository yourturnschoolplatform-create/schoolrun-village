import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNearbySuburbsAndSchools,
  fetchSchoolsInSuburb,
  getNearbySuburbs,
  getSchoolsInSuburb,
  lookupSchoolsInSuburb,
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

  it('returns Cranbourne North schools instantly from the local ACARA master', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const lookup = await lookupSchoolsInSuburb('Cranbourne North', -38.074, 145.302);
    expect(lookup.source).toBe('live');
    expect(lookup.timedOut).toBe(false);
    expect(lookup.schools.length).toBeGreaterThanOrEqual(3);
    expect(lookup.schools.some((school) => /Alkira|Courtenay|Tulliallan/i.test(school.name))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns Narre Warren South, Craigieburn and Pakenham schools locally', () => {
    expect(getSchoolsInSuburb('Narre Warren South', -38.05, 145.3).schools.length).toBeGreaterThan(0);
    expect(getSchoolsInSuburb('Craigieburn', -37.594, 144.934).schools.some((s) => /Craigieburn/i.test(s.name))).toBe(true);
    expect(getSchoolsInSuburb('Pakenham', -38.073, 145.485).schools.length).toBeGreaterThan(0);
  });

  it('expands to nearby schools within 5 km when the suburb has fewer than 3', () => {
    // Docklands has 2 exact campuses; nearby expansion should fill past MIN_SUBURB_SCHOOLS.
    const result = getSchoolsInSuburb('Docklands', -37.817, 144.942);
    expect(result.source).toBe('live');
    expect(result.schools.length).toBeGreaterThanOrEqual(3);
    expect(result.schools.some((school) => /Docklands Primary/i.test(school.name))).toBe(true);
  });

  it('keeps fetchSchoolsInSuburb sync with local lookup and never calls network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const schools = await fetchSchoolsInSuburb('Docklands', -37.815, 144.946);
    expect(schools.some((school) => /Docklands Primary/i.test(school.name))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
