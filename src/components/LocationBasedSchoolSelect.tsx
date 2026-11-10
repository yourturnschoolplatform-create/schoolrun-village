import { useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * Location-aware school dropdown for onboarding.
 * Uses browser geolocation only to sort/auto-select — never posts coordinates.
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
  const autoAppliedRef = useRef(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('detecting');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationStatus('ready');
      },
      () => {
        setCoords(null);
        setLocationStatus('denied');
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  }, []);

  const rankedSchools = useMemo(() => {
    if (!coords) {
      return schools.map((school) => ({ ...school, distanceKm: null as number | null }));
    }
    return sortSchoolsByDistance(schools, coords.lat, coords.lng);
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

  const closestSchool = rankedSchools[0] ?? null;

  useEffect(() => {
    if (locationStatus !== 'ready' || !closestSchool || autoAppliedRef.current) return;
    autoAppliedRef.current = true;
    setSuburbFilter(closestSchool.suburb);
    onChange(closestSchool.id);
    // Intentionally omit onChange to avoid parent re-render loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationStatus, closestSchool?.id, closestSchool?.suburb]);

  useEffect(() => {
    if (locationStatus === 'detecting') return;
    if (!filteredSchools.length) return;
    if (!value || !filteredSchools.some((school) => school.id === value)) {
      onChange(filteredSchools[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSchools, value, locationStatus]);

  const statusCopy = (() => {
    if (locationStatus === 'detecting') {
      return 'Detecting your location…';
    }
    if (locationStatus === 'ready' && closestSchool) {
      return `Closest school auto-selected: ${closestSchool.displayName} (${closestSchool.suburb} VIC). Location is not stored.`;
    }
    if (locationStatus === 'ready') {
      return 'Detecting nearby schools…';
    }
    return 'Location unavailable. Choose a suburb and school from the full list. Location is optional and never saved.';
  })();

  return (
    <div
      className="location-school-select"
      data-location-school-select={locationStatus}
      aria-busy={locationStatus === 'detecting'}
    >
      {locationStatus === 'detecting' ? (
        <p className="notice notice--amber location-school-select__detecting" role="status">
          Detecting nearby schools…
        </p>
      ) : null}

      <label>
        Suburb
        <select
          value={suburbFilter}
          disabled={disabled || locationStatus === 'detecting'}
          onChange={(event) => {
            autoAppliedRef.current = true;
            setSuburbFilter(event.target.value);
          }}
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
          value={value}
          disabled={disabled || locationStatus === 'detecting' || filteredSchools.length === 0}
          onChange={(event) => {
            autoAppliedRef.current = true;
            onChange(event.target.value);
          }}
          aria-label="Choose your school"
        >
          {filteredSchools.length === 0 ? (
            <option value="">No schools in this suburb</option>
          ) : (
            filteredSchools.map((school) => (
              <option key={school.id} value={school.id}>
                {school.displayName}
                {school.distanceKm != null && locationStatus === 'ready'
                  ? ` · ${school.distanceKm < 10 ? `${school.distanceKm.toFixed(1)} km` : `${Math.round(school.distanceKm)} km`}`
                  : ''}
              </option>
            ))
          )}
        </select>
      </label>

      <p className="field-help" role="status">
        {statusCopy}
      </p>
    </div>
  );
}
