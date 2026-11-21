import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AU_SUBURBS_DATA,
  NEARBY_SUBURB_RADIUS_KM,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';
import {
  fetchNearbySuburbsAndSchools,
  fetchSchoolsInSuburb,
  toRankedSuburbOptions,
  type LiveSuburb,
} from '../utils/auLocationService';

export type LocationSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  lat?: number;
  lng?: number;
};

type LocationStatus = 'detecting' | 'ready' | 'fallback';

const DETECTING_MESSAGE = 'Detecting your location & nearby suburbs...';
const FALLBACK_UNSUPPORTED =
  'Location is not supported in this browser. Choose any suburb and school below.';
const FALLBACK_DENIED =
  'Location permission was denied or unavailable. You can still choose any suburb and school below.';
const FALLBACK_GENERIC =
  'Could not detect your location. Choose any suburb and school below.';

/**
 * Dynamic AU suburb → school picker (Overpass + Nominatim).
 * Offline fallback: src/data/auSuburbsData.ts. Coordinates are never stored.
 */
export function LocationBasedSchoolSelect({
  value,
  onChange,
  disabled = false,
}: {
  schools?: LocationSchoolOption[];
  value: string;
  onChange: (schoolId: string) => void;
  disabled?: boolean;
}) {
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('detecting');
  const [rankedSuburbs, setRankedSuburbs] = useState<RankedSuburbOption[] | null>(null);
  const [selectedSuburbId, setSelectedSuburbId] = useState('');
  const [schoolOptions, setSchoolOptions] = useState<SchoolItem[]>([]);
  const [schoolQuery, setSchoolQuery] = useState('');
  const [loadingSchools, setLoadingSchools] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DETECTING_MESSAGE);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const detectedOnce = useRef(false);
  const schoolFetchSeq = useRef(0);

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

  const filteredSchools = useMemo(() => {
    const needle = schoolQuery.trim().toLowerCase();
    if (!needle) return schoolOptions;
    return schoolOptions.filter((school) => school.name.toLowerCase().includes(needle));
  }, [schoolOptions, schoolQuery]);

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

  function statusForSuburb(suburb: RankedSuburbOption | LiveSuburb, schoolCount: number): string {
    const distance = Number.isFinite(suburb.distanceKm) && suburb.distanceKm < Number.POSITIVE_INFINITY
      ? suburb.distanceKm.toFixed(1)
      : '—';
    return `Showing ${schoolCount} school${schoolCount === 1 ? '' : 's'} in ${suburb.name} • ${distance} km away`;
  }

  async function loadSchoolsForSuburb(suburb: RankedSuburbOption | LiveSuburb) {
    const seq = ++schoolFetchSeq.current;
    setLoadingSchools(true);
    setSchoolQuery('');
    setSchoolOptions([]);
    onChangeRef.current('');
    setStatusMessage(`Loading local schools in ${suburb.name}...`);

    try {
      const schools = await fetchSchoolsInSuburb(suburb.name, suburb.lat, suburb.lng);
      if (seq !== schoolFetchSeq.current) return;
      setSchoolOptions(schools);
      syncSchoolSelection(schools);
      setStatusMessage(statusForSuburb(suburb, schools.length));
    } catch {
      if (seq !== schoolFetchSeq.current) return;
      setSchoolOptions([]);
      onChangeRef.current('');
      setStatusMessage(`Could not load schools for ${suburb.name}. Try another suburb.`);
    } finally {
      if (seq === schoolFetchSeq.current) setLoadingSchools(false);
    }
  }

  async function applyLocationSuccess(lat: number, lng: number) {
    setStatusMessage('Finding suburbs near you...');
    const result = await fetchNearbySuburbsAndSchools(lat, lng);
    const ranked = toRankedSuburbOptions(result.suburbs);
    setRankedSuburbs(ranked);
    setLocationStatus(result.source === 'live' ? 'ready' : 'fallback');

    const pick = result.currentSuburb
      ?? result.suburbs.find((entry) => entry.nearby)
      ?? result.suburbs[0]
      ?? null;

    if (!pick) {
      setSelectedSuburbId('');
      setSchoolOptions([]);
      onChangeRef.current('');
      setStatusMessage('Choose a suburb below to load local schools. Location is not stored.');
      return;
    }

    setSelectedSuburbId(pick.id);
    await loadSchoolsForSuburb(pick);
  }

  function applyLocationFallback(message: string) {
    setRankedSuburbs(
      AU_SUBURBS_DATA.map((suburb) => ({
        id: suburb.id,
        name: suburb.name,
        state: suburb.state,
        postcode: suburb.postcode,
        lat: suburb.lat,
        lng: suburb.lng,
        distanceKm: Number.POSITIVE_INFINITY,
        nearby: false,
        schools: suburb.schools,
      })),
    );
    setLocationStatus('fallback');
    setSelectedSuburbId('');
    setSchoolOptions([]);
    setSchoolQuery('');
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
        void applyLocationSuccess(position.coords.latitude, position.coords.longitude);
      },
      (error) => {
        if (error?.code === 1) {
          applyLocationFallback(FALLBACK_DENIED);
          return;
        }
        applyLocationFallback(FALLBACK_GENERIC);
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 },
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
    setSchoolQuery('');
    if (!nextSuburbId) {
      setSchoolOptions([]);
      onChange('');
      setStatusMessage('Select a suburb first to load local schools.');
      return;
    }

    const suburb = suburbList.find((entry) => entry.id === nextSuburbId);
    if (!suburb) {
      setSchoolOptions([]);
      onChange('');
      setStatusMessage('That suburb could not be loaded. Try another.');
      return;
    }

    void loadSchoolsForSuburb(suburb);
  }

  function onSchoolChange(schoolId: string) {
    onChange(schoolId);
    if (!selectedSuburb) return;
    const school = schoolOptions.find((entry) => entry.id === schoolId);
    if (school) {
      setStatusMessage(statusForSuburb(selectedSuburb, schoolOptions.length));
    }
  }

  const geoSupported = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  const showDistance = rankedSuburbs != null
    && rankedSuburbs.some((entry) => Number.isFinite(entry.distanceKm) && entry.distanceKm < Number.POSITIVE_INFINITY);
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
      aria-busy={locationStatus === 'detecting' || loadingSchools}
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
                  {showDistance && Number.isFinite(suburb.distanceKm)
                    ? ` · ${suburb.distanceKm.toFixed(1)} km`
                    : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label={nearbySuburbs.length > 0 ? 'Other suburbs' : 'All suburbs'}>
            {(nearbySuburbs.length > 0 ? otherSuburbs : suburbList).map((suburb) => (
              <option key={`other-${suburb.id}`} value={suburb.id}>
                {suburb.name} {suburb.state}
                {showDistance
                  && Number.isFinite(suburb.distanceKm)
                  && suburb.distanceKm < Number.POSITIVE_INFINITY
                  ? ` · ${suburb.distanceKm.toFixed(1)} km`
                  : ''}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label>
        Search schools
        <input
          type="search"
          value={schoolQuery}
          disabled={disabled || !selectedSuburbId || loadingSchools || schoolOptions.length === 0}
          onChange={(event) => setSchoolQuery(event.target.value)}
          placeholder={loadingSchools ? 'Loading local schools...' : 'Type to filter schools'}
          aria-label="Search schools in the selected suburb"
        />
      </label>

      <label>
        School
        <select
          required
          value={schoolSelectValue}
          disabled={
            disabled
            || locationStatus === 'detecting'
            || loadingSchools
            || !selectedSuburbId
            || filteredSchools.length === 0
          }
          onChange={(event) => onSchoolChange(event.target.value)}
          aria-label="Choose your school"
        >
          {!selectedSuburbId ? (
            <option value="">Select a suburb first</option>
          ) : loadingSchools ? (
            <option value="">Loading local schools...</option>
          ) : filteredSchools.length === 0 ? (
            <option value="">
              {schoolQuery.trim() ? 'No schools match your search' : 'No schools found nearby'}
            </option>
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
        {loadingSchools ? `Loading local schools...` : statusMessage}
      </p>
    </div>
  );
}
