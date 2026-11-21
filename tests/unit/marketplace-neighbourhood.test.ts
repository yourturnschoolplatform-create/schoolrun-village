import { describe, expect, it } from 'vitest';
import {
  enrichListingNeighbourhood,
  filterListingsByScope,
  MARKETPLACE_SCOPE_FILTERS,
  nearbySuburbLabels,
  resolveSuburbPlace,
} from '../../shared/marketplace-neighbourhood';

describe('marketplace neighbourhood helpers', () => {
  it('exposes Nearby / My Suburb / My School scope chips', () => {
    expect(MARKETPLACE_SCOPE_FILTERS.map((entry) => entry.id)).toEqual([
      'nearby',
      'suburb',
      'school',
    ]);
  });

  it('resolves AU suburb coordinates and nearby labels for Craigieburn', () => {
    const place = resolveSuburbPlace('Craigieburn');
    expect(place?.suburb).toMatch(/Craigieburn/i);
    expect(place?.lat).toBeLessThan(-30);
    const labels = nearbySuburbLabels(place!.lat, place!.lng, 5);
    expect(labels.some((label) => /Craigieburn/i.test(label))).toBe(true);
    expect(labels.every((label) => label.trim().length >= 2)).toBe(true);
  });

  it('enriches listings with distance and same-school metadata', () => {
    const viewer = resolveSuburbPlace('Docklands');
    expect(viewer).toBeTruthy();
    const meta = enrichListingNeighbourhood({
      areaLabel: 'Southbank',
      sameSchool: true,
      viewer,
    });
    expect(meta.areaLabel).toBe('Southbank');
    expect(meta.sameSchool).toBe(true);
    expect(meta.distanceKm).not.toBeNull();
    expect(meta.distanceKm!).toBeLessThan(5);
    expect(meta.nearby).toBe(true);
  });

  it('filters feed by neighbourhood scope', () => {
    const items = [
      { areaLabel: 'Docklands', sameSchool: true, distanceKm: 0.2 },
      { areaLabel: 'Southbank', sameSchool: false, distanceKm: 1.4 },
      { areaLabel: 'Craigieburn', sameSchool: false, distanceKm: 28 },
      { areaLabel: 'Docklands', sameSchool: false, distanceKm: 0.5 },
    ];

    expect(filterListingsByScope(items, 'school', 'Docklands')).toHaveLength(4);
    expect(filterListingsByScope(items, 'suburb', 'Docklands').map((item) => item.areaLabel))
      .toEqual(['Docklands', 'Docklands']);
    const nearby = filterListingsByScope(items, 'nearby', 'Docklands');
    expect(nearby.every((item) => item.sameSchool || (item.distanceKm ?? 99) <= 5)).toBe(true);
    expect(nearby.some((item) => item.areaLabel === 'Craigieburn')).toBe(false);
  });
});
