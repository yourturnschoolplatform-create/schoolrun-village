import { describe, expect, it } from 'vitest';
import {
  calculateDistanceKm,
  NEARBY_SUBURB_RADIUS_KM,
  rankSuburbsNearLocation,
} from '../../src/data/auSuburbsData';
import {
  haversineKm,
  NEARBY_SUBURB_RADIUS_KM as CENTROID_RADIUS,
  rankSuburbsByDistance,
  sortSchoolsByDistance,
  suburbsByNearestSchool,
} from '../../shared/suburb-centroids';

describe('suburb centroids (browser-only distance helpers)', () => {
  it('ranks Docklands nearer than distant labels from Melbourne CBD', () => {
    const melbourne = { lat: -37.8136, lng: 144.9631 };
    const ranked = sortSchoolsByDistance(
      [
        { id: 'a', displayName: 'Far High School', suburb: 'St Kilda' },
        { id: 'b', displayName: 'Docklands Primary', suburb: 'Docklands' },
        { id: 'c', displayName: 'CBD Campus', suburb: 'Melbourne (CBD)' },
      ],
      melbourne.lat,
      melbourne.lng,
    );
    expect(ranked[0].suburb).toMatch(/Melbourne|Docklands/);
    expect(ranked[0].distanceKm).not.toBeNull();
    expect(ranked[0].distanceKm!).toBeLessThan(ranked.at(-1)!.distanceKm!);
  });

  it('orders suburbs by nearest school distance', () => {
    const suburbs = suburbsByNearestSchool([
      { suburb: 'St Kilda', distanceKm: 12 },
      { suburb: 'Docklands', distanceKm: 2 },
      { suburb: 'Southbank', distanceKm: 0.5 },
      { suburb: 'Docklands', distanceKm: 3 },
    ]);
    expect(suburbs[0]).toBe('Southbank');
    expect(suburbs[1]).toBe('Docklands');
    expect(suburbs[2]).toBe('St Kilda');
  });

  it('computes a short Melbourne Docklands hop', () => {
    const km = haversineKm(-37.8136, 144.9631, -37.8149, 144.9480);
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(3);
  });

  it(`flags Docklands/Carlton/Southbank within ${CENTROID_RADIUS} km from Docklands`, () => {
    const docklands = { lat: -37.8149, lng: 144.9480 };
    const ranked = rankSuburbsByDistance(
      ['St Kilda', 'Docklands', 'Carlton', 'Southbank', 'Melbourne'],
      docklands.lat,
      docklands.lng,
    );
    const nearbyNames = ranked.filter((entry) => entry.nearby).map((entry) => entry.suburb);
    expect(nearbyNames[0]).toBe('Docklands');
    expect(nearbyNames).toEqual(
      expect.arrayContaining(['Docklands', 'Carlton', 'Southbank', 'Melbourne']),
    );
    // St Kilda is ~6 km from Docklands — outside the 5 km nearby band.
    expect(nearbyNames).not.toContain('St Kilda');
    expect(ranked.find((entry) => entry.suburb === 'St Kilda')?.nearby).toBe(false);
  });
});

describe('auSuburbsData Melbourne catalogue', () => {
  it(`uses a ${NEARBY_SUBURB_RADIUS_KM} km nearby radius`, () => {
    expect(NEARBY_SUBURB_RADIUS_KM).toBe(5);
  });

  it('ranks Docklands first from a Docklands GPS pin', () => {
    const ranked = rankSuburbsNearLocation(-37.8150, 144.9460);
    expect(ranked[0].name).toBe('Docklands');
    expect(ranked[0].nearby).toBe(true);
    expect(ranked[0].distanceKm).toBeLessThanOrEqual(NEARBY_SUBURB_RADIUS_KM);
  });

  it('keeps St Kilda out of the 5 km band from Docklands', () => {
    const ranked = rankSuburbsNearLocation(-37.8150, 144.9460);
    const stKilda = ranked.find((entry) => entry.id === 'st-kilda');
    expect(stKilda).toBeTruthy();
    expect(stKilda!.nearby).toBe(false);
    expect(stKilda!.distanceKm).toBeGreaterThan(5);
  });

  it('matches calculateDistanceKm to a short Docklands hop', () => {
    const km = calculateDistanceKm(-37.8136, 144.9631, -37.8150, 144.9460);
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(3);
  });
});
