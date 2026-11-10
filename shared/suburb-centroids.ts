/**
 * Approximate AU suburb centres for browser-only distance sorting.
 * Never persisted, posted to the API, or stored on profiles/schools.
 */

export type SuburbCentroid = {
  suburb: string;
  lat: number;
  lng: number;
};

/** Sample + common VIC/NSW suburb hints used during onboarding geolocation. */
export const AU_SUBURB_CENTROIDS: readonly SuburbCentroid[] = [
  { suburb: 'Harbourview', lat: -37.8136, lng: 144.9631 },
  { suburb: 'Docklands', lat: -37.8149, lng: 144.9480 },
  { suburb: 'Carlton', lat: -37.8001, lng: 144.9671 },
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
