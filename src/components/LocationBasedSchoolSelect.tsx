import { useMemo, useState } from 'react';
import {
  sortSchoolsByDistance,
  suburbsByNearestSchool,
} from '../../shared/suburb-centroids';

export type LocationSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  /** Optional approximate point for browser geolocation sorting only — never stored. */
  lat?: number;
  lng?: number;
};

type LocationStatus = 'idle' | 'detecting' | 'ready' | 'denied';

type RankedSchool = LocationSchoolOption & { distanceKm: number | null };

/**
 * User-friendly suburb → school picker for onboarding.
 * Location is opt-in via button; coordinates are never stored or posted.
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
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle');
  const [suburbFilter, setSuburbFilter] = useState('');
  const [statusMessage, setStatusMessage] = useState(
    'Choose a suburb and school, or use your current location to find nearby schools. Location is never stored.',
  );

  const rankedSchools = useMemo<RankedSchool[]>(() => {
    if (coords) {
      return sortSchoolsByDistance(schools, coords.lat, coords.lng);
    }
    return [...schools]
      .map((school) => ({ ...school, distanceKm: null as number | null }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [schools, coords]);

  const suburbs = useMemo(() => {
    if (coords) return suburbsByNearestSchool(rankedSchools);
    return Array.from(new Set(schools.map((school) => school.suburb.trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
  }, [coords, rankedSchools, schools]);

  const filteredSchools = useMemo(() => {
    if (!suburbFilter) return rankedSchools;
    return rankedSchools.filter(
      (school) => school.suburb.toLowerCase() === suburbFilter.toLowerCase(),
    );
  }, [rankedSchools, suburbFilter]);

  function applyClosestFromCoords(lat: number, lng: number) {
    const ranked = sortSchoolsByDistance(schools, lat, lng);
    const closest = ranked[0];
    if (!closest) {
      setStatusMessage('No schools available yet. Please try again shortly.');
      return;
    }
    setSuburbFilter(closest.suburb);
    onChange(closest.id);
    setStatusMessage(
      `Closest school auto-selected: ${closest.displayName} (${closest.suburb} VIC). Location is not stored.`,
    );
  }

  function useCurrentLocation() {
    if (disabled) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('denied');
      setCoords(null);
      setStatusMessage(
        'Location is not supported in this browser. You can still choose any suburb and school below.',
      );
      return;
    }

    setLocationStatus('detecting');
    setStatusMessage('Detecting nearby schools…');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setCoords({ lat, lng });
        setLocationStatus('ready');
        applyClosestFromCoords(lat, lng);
      },
      () => {
        setCoords(null);
        setLocationStatus('denied');
        setStatusMessage(
          'Could not access your location. Choose a suburb and school from the list below.',
        );
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  }

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

    setStatusMessage(
      nextSuburb
        ? `Showing schools in ${nextSuburb} VIC.`
        : coords
          ? 'Showing all schools nearest first.'
          : 'Showing all schools in alphabetical order.',
    );
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
        onClick={useCurrentLocation}
      >
        <span className="location-school-select__locate-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 21s6.5-5.2 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.8 12 21 12 21Z" />
            <circle cx="12" cy="10.5" r="2.2" />
          </svg>
        </span>
        <span>
          {locationStatus === 'detecting'
            ? 'Detecting nearby schools…'
            : 'Use current location to find nearby schools'}
        </span>
      </button>

      <label>
        Suburb
        <select
          value={suburbFilter}
          disabled={disabled}
          onChange={(event) => onSuburbChange(event.target.value)}
          aria-label="Filter schools by suburb"
        >
          <option value="">All suburbs</option>
          {suburbs.map((suburb) => (
            <option key={suburb} value={suburb}>{suburb} VIC</option>
          ))}
        </select>
      </label>

      <label>
        School
        <select
          required
          value={filteredSchools.some((school) => school.id === value) ? value : (filteredSchools[0]?.id ?? '')}
          disabled={disabled || filteredSchools.length === 0}
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

      <p className="field-help" role="status">
        {statusMessage}
      </p>
    </div>
  );
}
