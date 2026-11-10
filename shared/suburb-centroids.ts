/**
 * Approximate AU suburb centres for browser-only distance sorting.
 * Never persisted, posted to the API, or stored on profiles/schools.
 */

export type SuburbCentroid = {
  suburb: string;
  lat: number;
  lng: number;
};

/** Default radius for “nearby” suburb prioritisation during onboarding. */
export const NEARBY_SUBURB_RADIUS_KM = 10;

/** Sample + common VIC/NSW suburb hints used during onboarding geolocation. */
export const AU_SUBURB_CENTROIDS: readonly SuburbCentroid[] = [
  { suburb: 'Harbourview', lat: -37.8136, lng: 144.9631 },
  { suburb: 'Docklands', lat: -37.8149, lng: 144.9480 },
  { suburb: 'Melbourne', lat: -37.8136, lng: 144.9631 },
  { suburb: 'Southbank', lat: -37.8230, lng: 144.9640 },
  { suburb: 'Carlton', lat: -37.8001, lng: 144.9671 },
  { suburb: 'Fitzroy', lat: -37.7985, lng: 144.9784 },
  { suburb: 'Richmond', lat: -37.8190, lng: 145.0020 },
  { suburb: 'South Yarra', lat: -37.8385, lng: 144.9920 },
  { suburb: 'Port Melbourne', lat: -37.8420, lng: 144.9400 },
  { suburb: 'West Melbourne', lat: -37.8090, lng: 144.9500 },
  { suburb: 'East Melbourne', lat: -37.8130, lng: 144.9840 },
  { suburb: 'North Melbourne', lat: -37.7990, lng: 144.9460 },
  { suburb: 'Parkville', lat: -37.7850, lng: 144.9510 },
  { suburb: 'Rivergum', lat: -37.8400, lng: 145.0200 },
  { suburb: 'Chatswood', lat: -33.7969, lng: 151.1832 },
  { suburb: 'Local suburb', lat: -37.8136, lng: 144.9631 },
];

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function centroidForSuburb(
  suburb: string,
  catalogue: readonly SuburbCentroid[] = AU_SUBURB_CENTROIDS,
): SuburbCentroid | null {
  const needle = suburb.trim().toLowerCase();
  if (!needle) return null;
  return catalogue.find((entry) => entry.suburb.toLowerCase() === needle) ?? null;
}

export function distanceKmToSuburb(
  lat: number,
  lng: number,
  suburb: string,
  catalogue: readonly SuburbCentroid[] = AU_SUBURB_CENTROIDS,
): number | null {
  const centre = centroidForSuburb(suburb, catalogue);
  if (!centre) return null;
  return haversineKm(lat, lng, centre.lat, centre.lng);
}

export type DistanceSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  lat?: number;
  lng?: number;
};

/** Sort schools nearest-first using optional school coords or suburb centroids. */
export function sortSchoolsByDistance<T extends DistanceSchoolOption>(
  schools: T[],
  lat: number,
  lng: number,
  catalogue: readonly SuburbCentroid[] = AU_SUBURB_CENTROIDS,
): Array<T & { distanceKm: number | null }> {
  return schools
    .map((school) => {
      let distanceKm: number | null = null;
      if (
        typeof school.lat === 'number'
        && typeof school.lng === 'number'
        && Number.isFinite(school.lat)
        && Number.isFinite(school.lng)
      ) {
        distanceKm = haversineKm(lat, lng, school.lat, school.lng);
      } else {
        distanceKm = distanceKmToSuburb(lat, lng, school.suburb, catalogue);
      }
      return { ...school, distanceKm };
    })
    .sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) {
        return a.displayName.localeCompare(b.displayName);
      }
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
}

/** Unique suburbs ordered by nearest school distance. */
export function suburbsByNearestSchool(
  schools: Array<{ suburb: string; distanceKm: number | null }>,
): string[] {
  const best = new Map<string, number>();
  for (const school of schools) {
    const key = school.suburb.trim();
    if (!key) continue;
    const current = best.get(key);
    const next = school.distanceKm;
    if (next == null) {
      if (current == null) best.set(key, Number.POSITIVE_INFINITY);
      continue;
    }
    if (current == null || next < current) best.set(key, next);
  }
  return Array.from(best.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([suburb]) => suburb);
}

export type RankedSuburb = {
  suburb: string;
  distanceKm: number | null;
  nearby: boolean;
};

/**
 * Rank unique school suburbs by centroid distance from the user.
 * Nearby suburbs (within radiusKm) come first; others follow alphabetically.
 * Coordinates are browser-only — never stored.
 */
export function rankSuburbsByDistance(
  suburbs: string[],
  lat: number,
  lng: number,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
  catalogue: readonly SuburbCentroid[] = AU_SUBURB_CENTROIDS,
): RankedSuburb[] {
  const unique = Array.from(
    new Set(suburbs.map((suburb) => suburb.trim()).filter(Boolean)),
  );

  const ranked: RankedSuburb[] = unique.map((suburb) => {
    const distanceKm = distanceKmToSuburb(lat, lng, suburb, catalogue);
    return {
      suburb,
      distanceKm,
      nearby: distanceKm != null && distanceKm <= radiusKm,
    };
  });

  ranked.sort((a, b) => {
    if (a.nearby !== b.nearby) return a.nearby ? -1 : 1;
    if (a.nearby && b.nearby) {
      const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
      return da - db || a.suburb.localeCompare(b.suburb);
    }
    return a.suburb.localeCompare(b.suburb);
  });

  return ranked;
}
