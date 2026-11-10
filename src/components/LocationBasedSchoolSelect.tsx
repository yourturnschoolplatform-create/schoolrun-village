import { useEffect, useMemo, useState } from 'react';

export type LocationSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  /** Optional approximate suburb centre for browser geolocation sorting only — never stored. */
  lat?: number;
  lng?: number;
};

const VIC_SUBURB_HINTS: Array<{ suburb: string; lat: number; lng: number }> = [
  { suburb: 'Harbourview', lat: -37.8136, lng: 144.9631 },
  { suburb: 'Docklands', lat: -37.8149, lng: 144.9480 },
  { suburb: 'Carlton', lat: -37.8001, lng: 144.9671 },
  { suburb: 'Rivergum', lat: -37.8400, lng: 145.0200 },
];

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestSuburb(lat: number, lng: number): string | null {
  let best: { suburb: string; km: number } | null = null;
  for (const hint of VIC_SUBURB_HINTS) {
    const km = haversineKm(lat, lng, hint.lat, hint.lng);
    if (!best || km < best.km) best = { suburb: hint.suburb, km };
  }
  return best?.suburb ?? null;
}

/**
 * Location-aware school dropdown for onboarding.
 * Uses browser geolocation only to sort/filter — never posts coordinates.
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
  const [locationHint, setLocationHint] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'pending' | 'ready' | 'denied'>('idle');

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationStatus('denied');
      return;
    }
    setLocationStatus('pending');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const suburb = nearestSuburb(position.coords.latitude, position.coords.longitude);
        setLocationHint(suburb);
        setLocationStatus(suburb ? 'ready' : 'denied');
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  }, []);

  const orderedSchools = useMemo(() => {
    if (!locationHint) return schools;
    const preferred = schools.filter((school) =>
      school.suburb.toLowerCase() === locationHint.toLowerCase()
      || school.displayName.toLowerCase().includes(locationHint.toLowerCase()),
    );
    const rest = schools.filter((school) => !preferred.includes(school));
    return [...preferred, ...rest];
  }, [schools, locationHint]);

  const suburbs = useMemo(
    () => Array.from(new Set(orderedSchools.map((school) => school.suburb))).sort((a, b) => a.localeCompare(b)),
    [orderedSchools],
  );

  const [suburbFilter, setSuburbFilter] = useState('');

  useEffect(() => {
    if (locationHint && suburbs.some((suburb) => suburb.toLowerCase() === locationHint.toLowerCase())) {
      setSuburbFilter(locationHint);
    }
  }, [locationHint, suburbs]);

  const filteredSchools = useMemo(() => {
    if (!suburbFilter) return orderedSchools;
    return orderedSchools.filter((school) => school.suburb.toLowerCase() === suburbFilter.toLowerCase());
  }, [orderedSchools, suburbFilter]);

  useEffect(() => {
    if (!filteredSchools.length) return;
    if (!value || !filteredSchools.some((school) => school.id === value)) {
      onChange(filteredSchools[0].id);
    }
    // Intentionally omit onChange from deps to avoid parent re-render loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSchools, value]);

  return (
    <div className="location-school-select" data-location-school-select="ready">
      <label>
        Suburb
        <select
          value={suburbFilter}
          disabled={disabled}
          onChange={(event) => setSuburbFilter(event.target.value)}
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
          disabled={disabled || filteredSchools.length === 0}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Choose your school"
        >
          {filteredSchools.length === 0 ? (
            <option value="">No schools in this suburb</option>
          ) : (
            filteredSchools.map((school) => (
              <option key={school.id} value={school.id}>
                {school.displayName}
              </option>
            ))
          )}
        </select>
      </label>

      <p className="field-help" role="status">
        {locationStatus === 'pending'
          ? 'Checking nearby suburbs…'
          : locationStatus === 'ready' && locationHint
            ? `Nearby suggestion: ${locationHint} VIC (location is not stored).`
            : 'Choose a suburb and school from the list. Location is optional and never saved.'}
      </p>
    </div>
  );
}
