import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AU_SUBURBS_DATA,
  NEARBY_SUBURB_RADIUS_KM,
  rankSuburbsNearLocation,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';

export type LocationSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  lat?: number;
  lng?: number;
};

type LocationStatus = 'detecting' | 'ready' | 'fallback';

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
 * Uses Melbourne-real AU_SUBURBS_DATA (no Harbourview / Rivergum mocks).
 * Coordinates are never stored or posted.
 */
export function LocationBasedSchoolSelect({
  value,
  onChange,
  disabled = false,
}: {
  /** @deprecated Catalogue comes from AU_SUBURBS_DATA; prop kept for call-site compat. */
  schools?: LocationSchoolOption[];
  value: string;
  onChange: (schoolId: string) => void;
  disabled?: boolean;
}) {
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('detecting');
  const [rankedSuburbs, setRankedSuburbs] = useState<RankedSuburbOption[] | null>(null);
  const [selectedSuburbId, setSelectedSuburbId] = useState('');
  const [statusMessage, setStatusMessage] = useState(DETECTING_MESSAGE);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const detectedOnce = useRef(false);

  const suburbList = useMemo(() => {
    if (rankedSuburbs) return rankedSuburbs;
    return AU_SUBURBS_DATA.map((suburb) => ({
      id: suburb.id,
      name: suburb.name,
      state: suburb.state,
      postcode: suburb.postcode,
      lat: suburb.lat,
      lng: suburb.lng,
      distanceKm: Number.POSITIVE_INFINITY,
      nearby: false,
      schools: suburb.schools,
    }));
  }, [rankedSuburbs]);

  const nearbySuburbs = useMemo(
    () => suburbList.filter((entry) => entry.nearby),
    [suburbList],
  );
  const otherSuburbs = useMemo(
    () => suburbList.filter((entry) => !entry.nearby),
    [suburbList],
  );

  const selectedSuburb = useMemo(
    () => suburbList.find((entry) => entry.id === selectedSuburbId) ?? null,
    [suburbList, selectedSuburbId],
  );

  const filteredSchools: SchoolItem[] = selectedSuburb?.schools ?? [];

  function syncSchoolSelection(schools: SchoolItem[], preferredId?: string) {
    if (!schools.length) {
      onChangeRef.current('');
      return;
    }
    if (preferredId && schools.some((school) => school.id === preferredId)) {
      onChangeRef.current(preferredId);
      return;
    }
    onChangeRef.current(schools[0].id);
  }

  function applyLocationSuccess(lat: number, lng: number) {
    const ranked = rankSuburbsNearLocation(lat, lng, NEARBY_SUBURB_RADIUS_KM);
    setRankedSuburbs(ranked);
    setLocationStatus('ready');

    const nearby = ranked.filter((entry) => entry.nearby);
    if (nearby.length > 0) {
      const nearest = nearby[0];
      setSelectedSuburbId(nearest.id);
      syncSchoolSelection(nearest.schools);
      setStatusMessage(
        nearby.length === 1
          ? `${READY_MESSAGE}. Showing schools in ${nearest.name} ${nearest.state}.`
          : `${READY_MESSAGE}. Nearest suburb selected: ${nearest.name} ${nearest.state}.`,
      );
      return;
    }

    setSelectedSuburbId('');
    onChangeRef.current('');
    setStatusMessage(
      `No suburbs within ${NEARBY_SUBURB_RADIUS_KM} km of your location. Choose a suburb below. Location is not stored.`,
    );
  }

  function applyLocationFallback(message: string) {
    setRankedSuburbs(null);
    setLocationStatus('fallback');
    setSelectedSuburbId('');
    onChangeRef.current('');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSuburbChange(nextSuburbId: string) {
    setSelectedSuburbId(nextSuburbId);
    if (!nextSuburbId) {
      onChange('');
      setStatusMessage(
        rankedSuburbs
          ? 'Choose a nearby suburb to see its schools.'
          : 'Select a suburb first to see schools.',
      );
      return;
    }

    const suburb = suburbList.find((entry) => entry.id === nextSuburbId);
    if (!suburb) {
      onChange('');
      setStatusMessage('No schools in this suburb. Try another suburb.');
      return;
    }

    syncSchoolSelection(suburb.schools);
    const distanceLabel = Number.isFinite(suburb.distanceKm) && suburb.distanceKm < Number.POSITIVE_INFINITY
      ? ` · ${suburb.distanceKm.toFixed(1)} km`
      : '';
    setStatusMessage(`Showing schools in ${suburb.name} ${suburb.state}${distanceLabel}.`);
  }

  function onSchoolChange(schoolId: string) {
    onChange(schoolId);
    if (!selectedSuburb) return;
    const school = selectedSuburb.schools.find((entry) => entry.id === schoolId);
    if (school) {
      setStatusMessage(`Selected ${school.name} in ${selectedSuburb.name} ${selectedSuburb.state}.`);
    }
  }

  const geoSupported = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  const showDistance = locationStatus === 'ready' && rankedSuburbs != null;
  const locateLabel = locationStatus === 'detecting'
    ? DETECTING_MESSAGE
    : locationStatus === 'ready'
      ? 'Update location'
      : 'Try detecting location again';

  const schoolSelectValue = filteredSchools.some((school) => school.id === value)
    ? value
    : '';

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
          value={selectedSuburbId}
          disabled={disabled || locationStatus === 'detecting'}
          onChange={(event) => onSuburbChange(event.target.value)}
          aria-label="Filter schools by suburb"
        >
          <option value="">All suburbs</option>
          {nearbySuburbs.length > 0 ? (
            <optgroup label={`Nearby (within ${NEARBY_SUBURB_RADIUS_KM} km)`}>
              {nearbySuburbs.map((suburb) => (
                <option key={`nearby-${suburb.id}`} value={suburb.id}>
                  {suburb.name} {suburb.state}
                  {showDistance ? ` · ${suburb.distanceKm.toFixed(1)} km` : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label={nearbySuburbs.length > 0 ? 'Other suburbs' : 'All suburbs'}>
            {(nearbySuburbs.length > 0 ? otherSuburbs : suburbList).map((suburb) => (
              <option key={`other-${suburb.id}`} value={suburb.id}>
                {suburb.name} {suburb.state}
                {showDistance && Number.isFinite(suburb.distanceKm) && suburb.distanceKm < Number.POSITIVE_INFINITY
                  ? ` · ${suburb.distanceKm.toFixed(1)} km`
                  : ''}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label>
        School
        <select
          required
          value={schoolSelectValue}
          disabled={disabled || locationStatus === 'detecting' || !selectedSuburbId || filteredSchools.length === 0}
          onChange={(event) => onSchoolChange(event.target.value)}
          aria-label="Choose your school"
        >
          {!selectedSuburbId ? (
            <option value="">Select a suburb first</option>
          ) : filteredSchools.length === 0 ? (
            <option value="">No schools in this suburb</option>
          ) : (
            filteredSchools.map((school) => (
              <option key={school.id} value={school.id}>
                {school.name}
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
