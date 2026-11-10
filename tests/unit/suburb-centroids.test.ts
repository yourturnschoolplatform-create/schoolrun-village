import { describe, expect, it } from 'vitest';
import {
  haversineKm,
  NEARBY_SUBURB_RADIUS_KM,
  rankSuburbsByDistance,
  sortSchoolsByDistance,
  suburbsByNearestSchool,
} from '../../shared/suburb-centroids';

describe('suburb centroids (browser-only distance helpers)', () => {
  it('ranks Docklands nearer than Chatswood from Melbourne CBD', () => {
    const melbourne = { lat: -37.8136, lng: 144.9631 };
    const ranked = sortSchoolsByDistance(
      [
        { id: 'a', displayName: 'Chatswood High School', suburb: 'Chatswood' },
        { id: 'b', displayName: 'Docklands Primary', suburb: 'Docklands' },
        { id: 'c', displayName: 'Harbourview Primary', suburb: 'Harbourview' },
      ],
      melbourne.lat,
      melbourne.lng,
    );
    expect(ranked[0].suburb).toMatch(/Harbourview|Docklands|Melbourne/);
    expect(ranked.at(-1)?.suburb).toBe('Chatswood');
    expect(ranked[0].distanceKm).not.toBeNull();
    expect(ranked[0].distanceKm!).toBeLessThan(ranked.at(-1)!.distanceKm!);
  });

  it('orders suburbs by nearest school distance', () => {
    const suburbs = suburbsByNearestSchool([
      { suburb: 'Chatswood', distanceKm: 700 },
      { suburb: 'Docklands', distanceKm: 2 },
      { suburb: 'Harbourview', distanceKm: 0.5 },
      { suburb: 'Docklands', distanceKm: 3 },
    ]);
    expect(suburbs[0]).toBe('Harbourview');
    expect(suburbs[1]).toBe('Docklands');
    expect(suburbs[2]).toBe('Chatswood');
  });

  it('computes a short Melbourne Docklands hop', () => {
    const km = haversineKm(-37.8136, 144.9631, -37.8149, 144.9480);
    expect(km).toBeGreaterThan(0);
    expect(km).toBeLessThan(3);
  });

  it(`flags Docklands/Carlton/Southbank within ${NEARBY_SUBURB_RADIUS_KM} km from Docklands`, () => {
    const docklands = { lat: -37.8149, lng: 144.9480 };
    const ranked = rankSuburbsByDistance(
      ['Chatswood', 'Docklands', 'Carlton', 'Southbank', 'Melbourne', 'Harbourview'],
      docklands.lat,
      docklands.lng,
    );
    const nearbyNames = ranked.filter((entry) => entry.nearby).map((entry) => entry.suburb);
    expect(nearbyNames[0]).toBe('Docklands');
    expect(nearbyNames).toEqual(
      expect.arrayContaining(['Docklands', 'Carlton', 'Southbank', 'Melbourne', 'Harbourview']),
    );
    expect(nearbyNames).not.toContain('Chatswood');
    expect(ranked.at(-1)?.suburb).toBe('Chatswood');
    expect(ranked.at(-1)?.nearby).toBe(false);
  });
});
