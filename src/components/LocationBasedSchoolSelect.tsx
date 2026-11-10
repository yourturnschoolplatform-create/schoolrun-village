import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NEARBY_SUBURB_RADIUS_KM,
  rankSuburbsByDistance,
  sortSchoolsByDistance,
} from '../../shared/suburb-centroids';

export type LocationSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  /** Optional approximate point for browser geolocation sorting only — never stored. */
  lat?: number;
  lng?: number;
};

type LocationStatus = 'detecting' | 'ready' | 'fallback';

type RankedSchool = LocationSchoolOption & { distanceKm: number | null };

const DETECTING_MESSAGE = 'Detecting your location & nearby suburbs...';
const READY_MESSAGE = 'Nearby suburbs found based on your location';
const FALLBACK_UNSUPPORTED =
  'Location is not supported in this browser. Choose any suburb and school below.';
const FALLBACK_DENIED =
  'Location permission was denied or unavailable. You can still choose any suburb and school below.';
const FALLBACK_GENERIC =
  'Could not detect your location. Choose any suburb and school below.';

/**
 * Radius-based suburb → school picker for onboarding.
 * Auto-detects location on mount; coordinates are never stored or posted.
 */
export function LocationBasedSchoolSelect({
  schools,
  value,
  onChange,
  disabled = false,
}: {
  schools: LocationSchoolOption[];
  value: string;
  onChange: (schoolId: string) => void;
  disabled?: boolean;
}) {
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('detecting');
  const [suburbFilter, setSuburbFilter] = useState('');
  const [statusMessage, setStatusMessage] = useState(DETECTING_MESSAGE);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const schoolsRef = useRef(schools);
  schoolsRef.current = schools;
  const detectedOnce = useRef(false);

  const rankedSchools = useMemo<RankedSchool[]>(() => {
    if (coords) {
      return sortSchoolsByDistance(schools, coords.lat, coords.lng);
    }
    return [...schools]
      .map((school) => ({ ...school, distanceKm: null as number | null }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [schools, coords]);

  const rankedSuburbs = useMemo(() => {
    const labels = schools.map((school) => school.suburb);
    if (coords) {
      return rankSuburbsByDistance(labels, coords.lat, coords.lng, NEARBY_SUBURB_RADIUS_KM);
    }
    return Array.from(new Set(labels.map((suburb) => suburb.trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b))
      .map((suburb) => ({ suburb, distanceKm: null as number | null, nearby: false }));
  }, [schools, coords]);

  const nearbySuburbs = useMemo(
    () => rankedSuburbs.filter((entry) => entry.nearby),
    [rankedSuburbs],
  );
  const otherSuburbs = useMemo(
    () => rankedSuburbs.filter((entry) => !entry.nearby),
    [rankedSuburbs],
  );

  const filteredSchools = useMemo(() => {
    if (!suburbFilter) return rankedSchools;
    return rankedSchools.filter(
      (school) => school.suburb.toLowerCase() === suburbFilter.toLowerCase(),
    );
  }, [rankedSchools, suburbFilter]);

  function applyLocationSuccess(lat: number, lng: number) {
    const list = schoolsRef.current;
    const ranked = sortSchoolsByDistance(list, lat, lng);
    const suburbRanks = rankSuburbsByDistance(
      list.map((school) => school.suburb),
      lat,
      lng,
      NEARBY_SUBURB_RADIUS_KM,
    );
    const nearby = suburbRanks.filter((entry) => entry.nearby);
    setCoords({ lat, lng });
    setLocationStatus('ready');

    if (nearby.length > 0) {
      const nearestSuburb = nearby[0].suburb;
      setSuburbFilter(nearestSuburb);
      const inSuburb = ranked.filter(
        (school) => school.suburb.toLowerCase() === nearestSuburb.toLowerCase(),
      );
      const pick = inSuburb[0] ?? ranked[0];
      if (pick) onChangeRef.current(pick.id);
      setStatusMessage(
        nearby.length === 1
          ? `${READY_MESSAGE}. Showing schools in ${nearestSuburb} VIC.`
          : `${READY_MESSAGE}. Nearest suburb selected: ${nearestSuburb} VIC.`,
      );
      return;
    }

    setSuburbFilter('');
    if (ranked[0]) onChangeRef.current(ranked[0].id);
    setStatusMessage(
      'No suburbs within 10 km of your location. Showing all suburbs nearest first. Location is not stored.',
    );
  }

  function applyLocationFallback(message: string) {
    setCoords(null);
    setLocationStatus('fallback');
    setSuburbFilter('');
    setStatusMessage(message);
  }

  function detectLocation() {
    if (disabled) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      applyLocationFallback(FALLBACK_UNSUPPORTED);
      return;
    }

    setLocationStatus('detecting');
    setStatusMessage(DETECTING_MESSAGE);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        applyLocationSuccess(position.coords.latitude, position.coords.longitude);
      },
      (error) => {
        // 1 = PERMISSION_DENIED on GeolocationPositionError
        if (error?.code === 1) {
          applyLocationFallback(FALLBACK_DENIED);
          return;
        }
        applyLocationFallback(FALLBACK_GENERIC);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  useEffect(() => {
    if (detectedOnce.current) return;
    detectedOnce.current = true;
    detectLocation();
    // Mount-only auto detect; retry is available via the locate button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSuburbChange(nextSuburb: string) {
    setSuburbFilter(nextSuburb);

    const nextList = !nextSuburb
      ? rankedSchools
      : rankedSchools.filter(
        (school) => school.suburb.toLowerCase() === nextSuburb.toLowerCase(),
      );

    if (!nextList.length) {
      setStatusMessage('No schools in this suburb. Try another suburb or All suburbs.');
      return;
    }

    const stillValid = nextList.some((school) => school.id === value);
    if (!stillValid) {
      onChange(nextList[0].id);
    }

    if (!nextSuburb) {
      setStatusMessage(
        coords
          ? 'Showing all schools nearest first. Location is not stored.'
          : 'Showing all schools. Choose a suburb to narrow the list.',
      );
      return;
    }

    setStatusMessage(`Showing schools in ${nextSuburb} VIC only.`);
  }

  function onSchoolChange(schoolId: string) {
    const selected = rankedSchools.find((school) => school.id === schoolId)
      ?? schools.find((school) => school.id === schoolId);
    if (!selected) {
      onChange(schoolId);
      return;
    }
    setSuburbFilter(selected.suburb);
    onChange(selected.id);
    setStatusMessage(`Selected ${selected.displayName} in ${selected.suburb} VIC.`);
  }

  const geoSupported = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  const showDistance = locationStatus === 'ready' && coords != null;
  const locateLabel = locationStatus === 'detecting'
    ? DETECTING_MESSAGE
    : locationStatus === 'ready'
      ? 'Update location'
      : 'Try detecting location again';

  return (
    <div
      className="location-school-select"
      data-location-school-select={locationStatus}
      aria-busy={locationStatus === 'detecting'}
    >
      <button
        type="button"
        className="location-school-select__locate"
        disabled={disabled || locationStatus === 'detecting' || !geoSupported}
        onClick={detectLocation}
      >
        <span className="location-school-select__locate-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 21s6.5-5.2 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.8 12 21 12 21Z" />
            <circle cx="12" cy="10.5" r="2.2" />
          </svg>
        </span>
        <span>{locateLabel}</span>
      </button>

      <label>
        Suburb
        <select
          value={suburbFilter}
          disabled={disabled || locationStatus === 'detecting'}
          onChange={(event) => onSuburbChange(event.target.value)}
          aria-label="Filter schools by suburb"
        >
          <option value="">All suburbs</option>
          {nearbySuburbs.length > 0 ? (
            <optgroup label={`Nearby (within ${NEARBY_SUBURB_RADIUS_KM} km)`}>
              {nearbySuburbs.map((entry) => (
                <option key={`nearby-${entry.suburb}`} value={entry.suburb}>
                  {entry.suburb} VIC
                  {entry.distanceKm != null
                    ? ` · ${entry.distanceKm < 10
                      ? `${entry.distanceKm.toFixed(1)} km`
                      : `${Math.round(entry.distanceKm)} km`}`
                    : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otherSuburbs.length > 0 ? (
            <optgroup label={nearbySuburbs.length > 0 ? 'Other suburbs' : 'All suburbs'}>
              {otherSuburbs.map((entry) => (
                <option key={`other-${entry.suburb}`} value={entry.suburb}>
                  {entry.suburb} VIC
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>

      <label>
        School
        <select
          required
          value={filteredSchools.some((school) => school.id === value) ? value : (filteredSchools[0]?.id ?? '')}
          disabled={disabled || locationStatus === 'detecting' || filteredSchools.length === 0}
          onChange={(event) => onSchoolChange(event.target.value)}
          aria-label="Choose your school"
        >
          {filteredSchools.length === 0 ? (
            <option value="">No schools in this suburb</option>
          ) : (
            filteredSchools.map((school) => (
              <option key={school.id} value={school.id}>
                {school.displayName}
                {showDistance && school.distanceKm != null
                  ? ` · ${school.distanceKm < 10
                    ? `${school.distanceKm.toFixed(1)} km`
                    : `${Math.round(school.distanceKm)} km`}`
                  : ''}
              </option>
            ))
          )}
        </select>
      </label>

      <p className="field-help" role="status" data-location-status={locationStatus}>
        {statusMessage}
      </p>
    </div>
  );
}
