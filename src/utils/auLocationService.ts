import {
  AU_SUBURBS_DATA,
  calculateDistanceKm,
  NEARBY_SUBURB_RADIUS_KM,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';
import { AU_ALL_SUBURBS, type AuSuburbRecord } from '../data/auAllSuburbs';
import { AU_ALL_SCHOOLS, type AuSchoolRecord } from '../data/auAllSchools';

const MAX_NEARBY_SUBURBS = 40;
const MAX_SEARCH_RESULTS = 40;
const MIN_SUBURB_SCHOOLS = 3;
const NEARBY_SCHOOL_RADIUS_KM = NEARBY_SUBURB_RADIUS_KM;
const MAX_NEARBY_SCHOOLS = 40;

export type SchoolLookupResult = {
  schools: SchoolItem[];
  source: 'live' | 'fallback' | 'empty';
  timedOut: boolean;
};

export type LiveSuburb = {
  id: string;
  name: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
  distanceKm: number;
  nearby: boolean;
};

export type NearbyLocationResult = {
  currentSuburb: LiveSuburb | null;
  suburbs: LiveSuburb[];
  source: 'live' | 'fallback';
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'place';
}

function normaliseSuburbName(value: string): string {
  return value.trim().toLowerCase().replace(/\s*\(cbd\)\s*$/i, '').trim();
}

function toLiveSuburb(record: AuSuburbRecord, distanceKm: number, nearby: boolean): LiveSuburb {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    postcode: record.postcode,
    lat: record.lat,
    lng: record.lng,
    distanceKm,
    nearby,
  };
}

function toSchoolItem(record: AuSchoolRecord): SchoolItem {
  return {
    id: record.id || `${slugify(record.suburb)}-${slugify(record.name)}`,
    name: record.name,
  };
}

/**
 * Instant in-memory nearby suburbs (no network).
 * Closest suburb is marked 0.0 km when within radius; all within radiusKm listed by distance.
 */
export function getNearbySuburbs(
  lat: number,
  lng: number,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
): NearbyLocationResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || AU_ALL_SUBURBS.length === 0) {
    return offlineFallbackNearby(lat, lng, radiusKm);
  }

  const ranked = AU_ALL_SUBURBS
    .map((record) => {
      const distanceKm = calculateDistanceKm(lat, lng, record.lat, record.lng);
      return { record, distanceKm, nearby: distanceKm <= radiusKm };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm || a.record.name.localeCompare(b.record.name));

  const nearby = ranked.filter((entry) => entry.nearby).slice(0, MAX_NEARBY_SUBURBS);
  const pool = nearby.length > 0 ? nearby : ranked.slice(0, Math.min(12, ranked.length));

  if (!pool.length) {
    return offlineFallbackNearby(lat, lng, radiusKm);
  }

  const current = pool[0];
  const currentSuburb = toLiveSuburb(
    current.record,
    nearby.length > 0 ? 0 : current.distanceKm,
    nearby.length > 0,
  );

  const suburbs = pool.map((entry, index) => {
    if (index === 0 && nearby.length > 0) {
      return { ...currentSuburb };
    }
    return toLiveSuburb(entry.record, entry.distanceKm, entry.nearby);
  });

  return {
    currentSuburb,
    suburbs,
    source: 'live',
  };
}

/** Search any Australian suburb / postcode from the embedded master (instant). */
export function searchAustralianSuburbs(query: string, limit = MAX_SEARCH_RESULTS): LiveSuburb[] {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length < 2) return [];

  const matches: LiveSuburb[] = [];
  for (const record of AU_ALL_SUBURBS) {
    const hay = `${record.name} ${record.state} ${record.postcode}`.toLowerCase();
    if (!hay.includes(needle) && !record.postcode.startsWith(needle)) continue;
    matches.push(toLiveSuburb(record, Number.POSITIVE_INFINITY, false));
    if (matches.length >= limit) break;
  }
  return matches;
}

function offlineFallbackNearby(
  lat: number,
  lng: number,
  radiusKm: number,
): NearbyLocationResult {
  const ranked = AU_SUBURBS_DATA
    .map((suburb) => {
      const distanceKm = Number.isFinite(lat) && Number.isFinite(lng)
        ? calculateDistanceKm(lat, lng, suburb.lat, suburb.lng)
        : Number.POSITIVE_INFINITY;
      return {
        id: suburb.id,
        name: suburb.name,
        state: suburb.state,
        postcode: suburb.postcode,
        lat: suburb.lat,
        lng: suburb.lng,
        distanceKm,
        nearby: Number.isFinite(distanceKm) && distanceKm <= radiusKm,
      } satisfies LiveSuburb;
    })
    .sort((a, b) => {
      if (a.nearby !== b.nearby) return a.nearby ? -1 : 1;
      if (a.nearby && b.nearby) {
        return a.distanceKm - b.distanceKm || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

  const nearby = ranked.filter((entry) => entry.nearby);
  const suburbs = nearby.length ? nearby : ranked;
  return {
    currentSuburb: suburbs[0] ?? null,
    suburbs,
    source: 'fallback',
  };
}

/**
 * Local-only nearby suburbs (replaces Overpass/Nominatim suburb lookup).
 * Kept async for call-site compatibility.
 */
export async function fetchNearbySuburbsAndSchools(
  lat: number,
  lng: number,
): Promise<NearbyLocationResult> {
  return getNearbySuburbs(lat, lng, NEARBY_SUBURB_RADIUS_KM);
}

function offlineSchoolsForSuburb(suburbName: string): SchoolItem[] {
  const needle = normaliseSuburbName(suburbName);
  const match = AU_SUBURBS_DATA.find((suburb) => {
    const name = normaliseSuburbName(suburb.name);
    return name === needle || name.startsWith(needle) || needle.startsWith(name);
  });
  return match ? [...match.schools] : [];
}

/**
 * Instant local Australian school lookup (ACARA master) — no Overpass / network.
 * Exact suburb first; if fewer than 3, expand to schools within 5 km of the pin.
 */
export function getSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): SchoolLookupResult {
  const needle = normaliseSuburbName(suburbName);
  const byName = new Map<string, SchoolItem>();

  const exact: Array<{ record: AuSchoolRecord; distanceKm: number }> = [];
  for (const record of AU_ALL_SCHOOLS) {
    if (normaliseSuburbName(record.suburb) !== needle) continue;
    const distanceKm = Number.isFinite(lat) && Number.isFinite(lng)
      ? calculateDistanceKm(lat, lng, record.lat, record.lng)
      : 0;
    exact.push({ record, distanceKm });
  }
  exact.sort((a, b) => a.distanceKm - b.distanceKm || a.record.name.localeCompare(b.record.name));
  for (const entry of exact) {
    byName.set(entry.record.name.toLowerCase(), toSchoolItem(entry.record));
  }

  if (byName.size < MIN_SUBURB_SCHOOLS && Number.isFinite(lat) && Number.isFinite(lng)) {
    const nearby = AU_ALL_SCHOOLS
      .map((record) => ({
        record,
        distanceKm: calculateDistanceKm(lat, lng, record.lat, record.lng),
      }))
      .filter((entry) => entry.distanceKm <= NEARBY_SCHOOL_RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm || a.record.name.localeCompare(b.record.name));

    for (const entry of nearby) {
      const key = entry.record.name.toLowerCase();
      if (byName.has(key)) continue;
      byName.set(key, toSchoolItem(entry.record));
      if (byName.size >= MAX_NEARBY_SCHOOLS) break;
    }
  }

  // Merge tiny onboarding catalogue extras (e.g. branded campus labels).
  for (const school of offlineSchoolsForSuburb(suburbName)) {
    const key = school.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, school);
  }

  const schools = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  if (schools.length) {
    return { schools, source: 'live', timedOut: false };
  }
  return { schools: [], source: 'empty', timedOut: false };
}

/**
 * Async wrapper kept for call-site compatibility — resolves immediately from local data.
 */
export async function lookupSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): Promise<SchoolLookupResult> {
  return getSchoolsInSuburb(suburbName, lat, lng);
}

/** @deprecated Prefer lookupSchoolsInSuburb / getSchoolsInSuburb. */
export async function fetchSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): Promise<SchoolItem[]> {
  return getSchoolsInSuburb(suburbName, lat, lng).schools;
}

/** Build a manual school option parents can type themselves. */
export function createManualSchoolOption(suburbName: string, schoolName: string): SchoolItem {
  const trimmed = schoolName.trim();
  return {
    id: `manual-${slugify(suburbName)}-${slugify(trimmed)}`,
    name: trimmed,
  };
}

/** Map live suburbs into RankedSuburbOption shape (schools filled later). */
export function toRankedSuburbOptions(suburbs: LiveSuburb[]): RankedSuburbOption[] {
  return suburbs.map((suburb) => ({
    id: suburb.id,
    name: suburb.name,
    state: suburb.state,
    postcode: suburb.postcode,
    lat: suburb.lat,
    lng: suburb.lng,
    distanceKm: suburb.distanceKm,
    nearby: suburb.nearby,
    schools: [],
  }));
}
