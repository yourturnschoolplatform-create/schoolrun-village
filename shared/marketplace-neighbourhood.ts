import { AU_ALL_SUBURBS } from '../src/data/auAllSuburbs';
import {
  calculateDistanceKm,
  NEARBY_SUBURB_RADIUS_KM,
} from '../src/data/auSuburbsData';

export type MarketplaceScope = 'nearby' | 'suburb' | 'school';

export const MARKETPLACE_SCOPE_FILTERS: Array<{ id: MarketplaceScope; label: string }> = [
  { id: 'nearby', label: 'Nearby (5 km)' },
  { id: 'suburb', label: 'My Suburb' },
  { id: 'school', label: 'My School' },
];

export type ViewerMarketplacePlace = {
  suburb: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
};

export type NeighbourhoodSuburbOption = ViewerMarketplacePlace & {
  id: string;
  distanceKm: number;
};

export type NeighbourhoodListingMeta = {
  areaLabel: string;
  distanceKm: number | null;
  sameSchool: boolean;
  nearby: boolean;
};

/** Resolve a suburb label to coordinates from the embedded AU master. */
export function resolveSuburbPlace(suburbName: string): ViewerMarketplacePlace | null {
  const needle = suburbName.trim().toLowerCase().replace(/\s*\(cbd\)\s*$/i, '').trim();
  if (!needle) return null;
  const exact = AU_ALL_SUBURBS.find((entry) => entry.name.toLowerCase() === needle);
  const fuzzy = exact
    ?? AU_ALL_SUBURBS.find((entry) => entry.name.toLowerCase().startsWith(needle))
    ?? AU_ALL_SUBURBS.find((entry) => needle.startsWith(entry.name.toLowerCase()));
  if (!fuzzy) return null;
  return {
    suburb: fuzzy.name,
    state: fuzzy.state,
    postcode: fuzzy.postcode,
    lat: fuzzy.lat,
    lng: fuzzy.lng,
  };
}

/** Nearby suburb options within radiusKm for create/search chips. */
export function nearbySuburbOptions(
  lat: number,
  lng: number,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
): NeighbourhoodSuburbOption[] {
  return AU_ALL_SUBURBS
    .map((entry) => {
      const distanceKm = calculateDistanceKm(lat, lng, entry.lat, entry.lng);
      return {
        id: entry.id,
        suburb: entry.name,
        state: entry.state,
        postcode: entry.postcode,
        lat: entry.lat,
        lng: entry.lng,
        distanceKm,
      };
    })
    .filter((entry) => entry.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.suburb.localeCompare(b.suburb))
    .slice(0, 40);
}

export function nearbySuburbLabels(
  lat: number,
  lng: number,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
): string[] {
  return nearbySuburbOptions(lat, lng, radiusKm).map((entry) => entry.suburb);
}

/** Distance from viewer pin to listing suburb centroid (null if unknown). */
export function listingDistanceKm(
  viewer: ViewerMarketplacePlace | null | undefined,
  areaLabel: string | null | undefined,
): number | null {
  if (!viewer) return null;
  const place = resolveSuburbPlace(areaLabel ?? '');
  if (!place) return null;
  return calculateDistanceKm(viewer.lat, viewer.lng, place.lat, place.lng);
}

export function enrichListingNeighbourhood(input: {
  areaLabel?: string | null;
  schoolSuburb?: string | null;
  sameSchool?: boolean | null;
  schoolId?: string | null;
  viewerSchoolId?: string | null;
  viewer?: ViewerMarketplacePlace | null;
  radiusKm?: number;
}): NeighbourhoodListingMeta {
  const areaLabel = (input.areaLabel || input.schoolSuburb || 'Local suburb').trim() || 'Local suburb';
  const distanceKm = listingDistanceKm(input.viewer, areaLabel);
  const radiusKm = input.radiusKm ?? NEARBY_SUBURB_RADIUS_KM;
  const sameSchool = Boolean(
    input.sameSchool
    ?? (input.viewerSchoolId && input.schoolId && input.viewerSchoolId === input.schoolId),
  );
  return {
    areaLabel,
    distanceKm,
    sameSchool,
    nearby: distanceKm != null && distanceKm <= radiusKm,
  };
}

export function filterListingsByScope<T extends {
  areaLabel?: string | null;
  schoolSuburb?: string | null;
  sameSchool?: boolean;
  distanceKm?: number | null;
}>(
  items: T[],
  scope: MarketplaceScope,
  viewerSuburb: string,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
): T[] {
  const suburbNeedle = viewerSuburb.trim().toLowerCase();
  if (scope === 'school') return items;
  if (scope === 'suburb') {
    return items.filter((item) => {
      const label = (item.areaLabel || item.schoolSuburb || '').trim().toLowerCase();
      return label === suburbNeedle;
    });
  }
  return items.filter((item) => {
    if (item.sameSchool) return true;
    if (item.distanceKm != null && Number.isFinite(item.distanceKm)) {
      return item.distanceKm <= radiusKm;
    }
    const label = (item.areaLabel || item.schoolSuburb || '').trim().toLowerCase();
    return label === suburbNeedle;
  });
}
