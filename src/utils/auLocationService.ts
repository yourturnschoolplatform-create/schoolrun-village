import {
  AU_SUBURBS_DATA,
  calculateDistanceKm,
  NEARBY_SUBURB_RADIUS_KM,
  rankSuburbsNearLocation,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const SUBURB_RADIUS_M = 5000;
const SCHOOL_RADIUS_M = 3500;
const FETCH_TIMEOUT_MS = 18_000;

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

function elementPoint(element: OverpassElement): { lat: number; lng: number } | null {
  if (typeof element.lat === 'number' && typeof element.lon === 'number') {
    return { lat: element.lat, lng: element.lon };
  }
  if (element.center && typeof element.center.lat === 'number' && typeof element.center.lon === 'number') {
    return { lat: element.center.lat, lng: element.center.lon };
  }
  return null;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function queryOverpass(query: string): Promise<OverpassElement[]> {
  const response = await fetchWithTimeout(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!response.ok) {
    throw new Error(`Overpass request failed (${response.status})`);
  }
  const payload = await response.json() as { elements?: OverpassElement[] };
  return payload.elements ?? [];
}

function australianState(raw?: string | null): string {
  const value = (raw ?? '').trim();
  if (!value) return 'AU';
  const map: Record<string, string> = {
    'New South Wales': 'NSW',
    Victoria: 'VIC',
    Queensland: 'QLD',
    'South Australia': 'SA',
    'Western Australia': 'WA',
    Tasmania: 'TAS',
    'Australian Capital Territory': 'ACT',
    'Northern Territory': 'NT',
  };
  if (map[value]) return map[value];
  if (/^(NSW|VIC|QLD|SA|WA|TAS|ACT|NT)$/i.test(value)) return value.toUpperCase();
  return value;
}

/**
 * Reverse-geocode the user's pin to a suburb/locality label (Nominatim).
 * Coordinates stay in-memory only — never persisted.
 */
export async function reverseGeocodeSuburb(
  lat: number,
  lng: number,
): Promise<{ name: string; state: string; postcode: string } | null> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '16');
  url.searchParams.set('addressdetails', '1');

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      // Nominatim asks for a clear app identity; browsers may omit custom User-Agent.
      'Accept-Language': 'en-AU,en;q=0.9',
    },
  });
  if (!response.ok) return null;

  const payload = await response.json() as {
    address?: Record<string, string>;
  };
  const address = payload.address ?? {};
  const name = (
    address.suburb
    || address.town
    || address.village
    || address.city_district
    || address.municipality
    || address.city
    || address.locality
    || ''
  ).trim();
  if (!name) return null;

  return {
    name,
    state: australianState(address.state),
    postcode: (address.postcode ?? '').trim(),
  };
}

function offlineFallbackSuburbs(lat: number, lng: number): LiveSuburb[] {
  return rankSuburbsNearLocation(lat, lng, NEARBY_SUBURB_RADIUS_KM).map((entry) => ({
    id: entry.id,
    name: entry.name,
    state: entry.state,
    postcode: entry.postcode,
    lat: entry.lat,
    lng: entry.lng,
    distanceKm: entry.distanceKm,
    nearby: entry.nearby,
  }));
}

/**
 * Live nearby Australian suburbs within 5 km via Overpass + Nominatim.
 * Falls back to Melbourne catalogue in auSuburbsData.ts on network failure.
 */
export async function fetchNearbySuburbsAndSchools(
  lat: number,
  lng: number,
): Promise<NearbyLocationResult> {
  try {
    const [reverse, elements] = await Promise.all([
      reverseGeocodeSuburb(lat, lng).catch(() => null),
      queryOverpass(`
[out:json][timeout:25];
(
  node["place"~"suburb|town|locality|village"](around:${SUBURB_RADIUS_M},${lat},${lng});
  way["place"~"suburb|town|locality|village"](around:${SUBURB_RADIUS_M},${lat},${lng});
  relation["place"~"suburb|town|locality|village"](around:${SUBURB_RADIUS_M},${lat},${lng});
);
out center tags;
`.trim()),
    ]);

    const byName = new Map<string, LiveSuburb>();
    for (const element of elements) {
      const name = (element.tags?.name ?? '').trim();
      if (!name) continue;
      const point = elementPoint(element);
      if (!point) continue;
      const distanceKm = calculateDistanceKm(lat, lng, point.lat, point.lng);
      if (distanceKm > NEARBY_SUBURB_RADIUS_KM) continue;

      const key = name.toLowerCase();
      const next: LiveSuburb = {
        id: slugify(name),
        name,
        state: australianState(element.tags?.['addr:state'] || element.tags?.is_in),
        postcode: (element.tags?.['addr:postcode'] ?? '').trim(),
        lat: point.lat,
        lng: point.lng,
        distanceKm,
        nearby: true,
      };
      const existing = byName.get(key);
      if (!existing || next.distanceKm < existing.distanceKm) {
        byName.set(key, next);
      }
    }

    let suburbs = Array.from(byName.values()).sort(
      (a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name),
    );

    let currentSuburb: LiveSuburb | null = null;
    if (reverse?.name) {
      const match = suburbs.find(
        (entry) => entry.name.toLowerCase() === reverse.name.toLowerCase(),
      );
      currentSuburb = match
        ? { ...match, distanceKm: 0, nearby: true }
        : {
          id: slugify(reverse.name),
          name: reverse.name,
          state: reverse.state || 'AU',
          postcode: reverse.postcode,
          lat,
          lng,
          distanceKm: 0,
          nearby: true,
        };

      suburbs = [
        currentSuburb,
        ...suburbs.filter(
          (entry) => entry.name.toLowerCase() !== currentSuburb!.name.toLowerCase(),
        ),
      ];
    } else if (suburbs[0]) {
      currentSuburb = suburbs[0];
    }

    if (!suburbs.length) {
      const fallback = offlineFallbackSuburbs(lat, lng);
      const nearby = fallback.filter((entry) => entry.nearby);
      return {
        currentSuburb: nearby[0] ?? fallback[0] ?? null,
        suburbs: nearby.length ? nearby : fallback,
        source: 'fallback',
      };
    }

    return { currentSuburb, suburbs, source: 'live' };
  } catch (error) {
    console.warn('Nearby suburb live lookup failed; using offline catalogue.', error);
    const fallback = offlineFallbackSuburbs(lat, lng);
    const nearby = fallback.filter((entry) => entry.nearby);
    return {
      currentSuburb: nearby[0] ?? fallback[0] ?? null,
      suburbs: nearby.length ? nearby : fallback,
      source: 'fallback',
    };
  }
}

/**
 * Live schools near a suburb centre (3.5 km) via Overpass amenity=school.
 * Falls back to static auSuburbsData schools for that suburb name when offline.
 */
export async function fetchSchoolsInSuburb(
  suburbName: string,
  lat: number,
  lng: number,
): Promise<SchoolItem[]> {
  try {
    const elements = await queryOverpass(`
[out:json][timeout:25];
(
  node["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
  way["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
  relation["amenity"="school"](around:${SCHOOL_RADIUS_M},${lat},${lng});
);
out center tags;
`.trim());

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

    const schools = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (schools.length) return schools;
    return offlineSchoolsForSuburb(suburbName);
  } catch (error) {
    console.warn('School live lookup failed; using offline catalogue.', error);
    return offlineSchoolsForSuburb(suburbName);
  }
}

function offlineSchoolsForSuburb(suburbName: string): SchoolItem[] {
  const needle = suburbName.trim().toLowerCase();
  const match = AU_SUBURBS_DATA.find((suburb) => {
    const name = suburb.name.toLowerCase();
    return name === needle
      || name.startsWith(needle)
      || needle.startsWith(name.replace(/\s*\(cbd\)\s*$/i, '').trim());
  });
  return match ? [...match.schools] : [];
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
