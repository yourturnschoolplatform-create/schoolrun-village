import {
  AU_SUBURBS_DATA,
  calculateDistanceKm,
  NEARBY_SUBURB_RADIUS_KM,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';
import { AU_ALL_SUBURBS, type AuSuburbRecord } from '../data/auAllSuburbs';

const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
] as const;

const SCHOOL_RADIUS_M = 3500;
/** Per-mirror fetch budget. Mobile browsers sometimes ignore AbortSignal — race a hard reject. */
const SCHOOL_FETCH_TIMEOUT_MS = 4_000;
/** Hard ceiling for the whole school lookup (all mirrors). */
const SCHOOL_LOOKUP_OVERALL_MS = 5_000;
const MAX_NEARBY_SUBURBS = 40;
const MAX_SEARCH_RESULTS = 40;

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

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'place';
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String((error as { name?: string }).name) : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Reject after timeoutMs even if fetch/AbortSignal hangs (common on mobile). */
function rejectAfter(timeoutMs: number, label: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new DOMException(`${label} timed out after ${timeoutMs}ms`, 'AbortError'));
    }, timeoutMs);
  });
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SCHOOL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      reject(new DOMException(`Request timed out after ${timeoutMs}ms`, 'AbortError'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function queryOverpassMirror(url: string, query: string): Promise<OverpassElement[]> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: `data=${encodeURIComponent(query)}`,
  }, SCHOOL_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Overpass request failed (${response.status}) at ${url}`);
  }
  const payload = await response.json() as { elements?: OverpassElement[] };
  return payload.elements ?? [];
}

/** Query Overpass mirrors with a hard timeout each; first success wins. */
async function queryOverpass(query: string): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      return await queryOverpassMirror(mirror, query);
    } catch (error) {
      lastError = error;
      console.warn(`Overpass mirror failed (${mirror}):`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('All Overpass mirrors failed');
}

function mapOverpassSchools(suburbName: string, elements: OverpassElement[]): SchoolItem[] {
  const byName = new Map<string, SchoolItem>();
  for (const element of elements) {
    const name = (element.tags?.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, {
      id: `${slugify(suburbName)}-${slugify(name)}`,
      name,
    });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Live schools near a suburb centre via Overpass (multi-mirror + hard timeouts).
 * Always resolves — never hangs. Falls back to static catalogue / empty for manual entry.
 */
export async function lookupSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): Promise<SchoolLookupResult> {
  const fallback = offlineSchoolsForSuburb(suburbName);
  const query = `
[out:json][timeout:3];
(
  node["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
  way["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
  relation["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
);
out center tags;
`.trim();

  try {
    const elements = await Promise.race([
      queryOverpass(query),
      rejectAfter(SCHOOL_LOOKUP_OVERALL_MS, 'School lookup'),
    ]);
    const schools = mapOverpassSchools(suburbName, elements);
    if (schools.length) {
      return { schools, source: 'live', timedOut: false };
    }
    return {
      schools: fallback,
      source: fallback.length ? 'fallback' : 'empty',
      timedOut: false,
    };
  } catch (error) {
    const timedOut = isAbortError(error);
    console.warn(
      timedOut
        ? 'School live lookup timed out; using offline catalogue.'
        : 'School live lookup failed; using offline catalogue.',
      error,
    );
    return {
      schools: fallback,
      source: fallback.length ? 'fallback' : 'empty',
      timedOut,
    };
  }
}

/** @deprecated Prefer lookupSchoolsInSuburb for timeout / source metadata. */
export async function fetchSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): Promise<SchoolItem[]> {
  const result = await lookupSchoolsInSuburb(suburbName, lat, lng);
  return result.schools;
}

function offlineSchoolsForSuburb(suburbName: string): SchoolItem[] {
  const needle = suburbName.trim().toLowerCase().replace(/\s*\(cbd\)\s*$/i, '').trim();
  const match = AU_SUBURBS_DATA.find((suburb) => {
    const name = suburb.name.toLowerCase().replace(/\s*\(cbd\)\s*$/i, '').trim();
    return name === needle || name.startsWith(needle) || needle.startsWith(name);
  });
  return match ? [...match.schools] : [];
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
