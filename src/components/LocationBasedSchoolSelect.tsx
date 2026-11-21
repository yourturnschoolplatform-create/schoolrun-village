import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AU_SUBURBS_DATA,
  NEARBY_SUBURB_RADIUS_KM,
  type RankedSuburbOption,
  type SchoolItem,
} from '../data/auSuburbsData';
import {
  createManualSchoolOption,
  fetchNearbySuburbsAndSchools,
  fetchSchoolsInSuburb,
  searchAustralianSuburbs,
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

export type SelectedSchoolDetails = {
  id: string;
  name: string;
  suburb: string;
  state: string;
};

type LocationStatus = 'detecting' | 'ready' | 'fallback';

const DETECTING_MESSAGE = 'Detecting your location & nearby suburbs...';
const FALLBACK_UNSUPPORTED =
  'Location is not supported in this browser. Search any Australian suburb or postcode below.';
const FALLBACK_DENIED =
  'Location permission was denied or unavailable. Search any Australian suburb or postcode below.';
const FALLBACK_GENERIC =
  'Could not detect your location. Search any Australian suburb or postcode below.';
const MANUAL_SCHOOL_HINT = "Can't find your school? Enter school name manually";

/**
 * Local AU suburb master (instant) → Overpass schools (multi-mirror, 5s timeout)
 * with manual school-name fallback so signup is never blocked.
 * Coordinates are never stored.
 */
export function LocationBasedSchoolSelect({
  value,
  onChange,
  onSchoolDetailsChange,
  disabled = false,
}: {
  schools?: LocationSchoolOption[];
  value: string;
  onChange: (schoolId: string) => void;
  onSchoolDetailsChange?: (details: SelectedSchoolDetails | null) => void;
  disabled?: boolean;
}) {
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('detecting');
  const [rankedSuburbs, setRankedSuburbs] = useState<RankedSuburbOption[] | null>(null);
  const [selectedSuburbId, setSelectedSuburbId] = useState('');
  const [suburbSearch, setSuburbSearch] = useState('');
  const [schoolOptions, setSchoolOptions] = useState<SchoolItem[]>([]);
  const [schoolQuery, setSchoolQuery] = useState('');
  const [manualSchoolName, setManualSchoolName] = useState('');
  const [showManualSchool, setShowManualSchool] = useState(false);
  const [loadingSchools, setLoadingSchools] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DETECTING_MESSAGE);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDetailsRef = useRef(onSchoolDetailsChange);
  onDetailsRef.current = onSchoolDetailsChange;
  const detectedOnce = useRef(false);
  const schoolFetchSeq = useRef(0);

  const searchHits = useMemo(
    () => searchAustralianSuburbs(suburbSearch),
    [suburbSearch],
  );

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

  const selectedSuburb = useMemo(
    () => suburbList.find((entry) => entry.id === selectedSuburbId) ?? null,
    [suburbList, selectedSuburbId],
  );

  const filteredSchools = useMemo(() => {
    const needle = schoolQuery.trim().toLowerCase();
    if (!needle) return schoolOptions;
    return schoolOptions.filter((school) => school.name.toLowerCase().includes(needle));
  }, [schoolOptions, schoolQuery]);

  function emitSchoolSelection(
    school: SchoolItem | null,
    suburb: RankedSuburbOption | LiveSuburb | null,
  ) {
    if (!school || !suburb) {
      onChangeRef.current('');
      onDetailsRef.current?.(null);
      return;
    }
    onChangeRef.current(school.id);
    onDetailsRef.current?.({
      id: school.id,
      name: school.name,
      suburb: suburb.name,
      state: suburb.state || 'VIC',
    });
  }

  function syncSchoolSelection(
    schools: SchoolItem[],
    suburb: RankedSuburbOption | LiveSuburb | null,
    preferredId?: string,
  ) {
    if (!schools.length || !suburb) {
      emitSchoolSelection(null, null);
      return;
    }
    const pick = preferredId
      ? schools.find((school) => school.id === preferredId) ?? schools[0]
      : schools[0];
    emitSchoolSelection(pick, suburb);
  }

  function statusForSuburb(suburb: RankedSuburbOption | LiveSuburb, schoolCount: number): string {
    const distance = Number.isFinite(suburb.distanceKm) && suburb.distanceKm < Number.POSITIVE_INFINITY
      ? suburb.distanceKm.toFixed(1)
      : '—';
    if (schoolCount === 0) {
      return `No schools listed for ${suburb.name} yet. Enter your school name below to continue.`;
    }
    return `Showing ${schoolCount} school${schoolCount === 1 ? '' : 's'} in ${suburb.name} • ${distance} km away`;
  }

  function mergeSuburbIntoList(suburb: LiveSuburb | RankedSuburbOption) {
    const nextEntry: RankedSuburbOption = {
      id: suburb.id,
      name: suburb.name,
      state: suburb.state,
      postcode: suburb.postcode,
      lat: suburb.lat,
      lng: suburb.lng,
      distanceKm: suburb.distanceKm,
      nearby: suburb.nearby,
      schools: [],
    };
    setRankedSuburbs((prev) => {
      const base = prev ?? AU_SUBURBS_DATA.map((entry) => ({
        id: entry.id,
        name: entry.name,
        state: entry.state,
        postcode: entry.postcode,
        lat: entry.lat,
        lng: entry.lng,
        distanceKm: Number.POSITIVE_INFINITY,
        nearby: false,
        schools: entry.schools,
      }));
      if (base.some((entry) => entry.id === suburb.id)) {
        return base.map((entry) => (entry.id === suburb.id ? { ...entry, ...nextEntry, schools: entry.schools } : entry));
      }
      return [nextEntry, ...base];
    });
  }

  async function loadSchoolsForSuburb(suburb: RankedSuburbOption | LiveSuburb) {
    const seq = ++schoolFetchSeq.current;
    setLoadingSchools(true);
    setSchoolQuery('');
    setSchoolOptions([]);
    setManualSchoolName('');
    setShowManualSchool(false);
    emitSchoolSelection(null, null);
    setStatusMessage(`Loading local schools in ${suburb.name}...`);

    try {
      const schools = await fetchSchoolsInSuburb(suburb.name, suburb.lat, suburb.lng);
      if (seq !== schoolFetchSeq.current) return;
      setSchoolOptions(schools);
      if (schools.length === 0) {
        setShowManualSchool(true);
        emitSchoolSelection(null, null);
      } else {
        syncSchoolSelection(schools, suburb);
      }
      setStatusMessage(statusForSuburb(suburb, schools.length));
    } catch {
      if (seq !== schoolFetchSeq.current) return;
      setSchoolOptions([]);
      setShowManualSchool(true);
      emitSchoolSelection(null, null);
      setStatusMessage(
        `Could not load schools for ${suburb.name}. Enter your school name below to continue.`,
      );
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
    setSuburbSearch('');

    const pick = result.currentSuburb
      ?? result.suburbs.find((entry) => entry.nearby)
      ?? result.suburbs[0]
      ?? null;

    if (!pick) {
      setSelectedSuburbId('');
      setSchoolOptions([]);
      emitSchoolSelection(null, null);
      setStatusMessage('Search any Australian suburb or postcode below. Location is not stored.');
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
    setManualSchoolName('');
    setShowManualSchool(false);
    setSuburbSearch('');
    emitSchoolSelection(null, null);
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
    setManualSchoolName('');
    setShowManualSchool(false);
    if (!nextSuburbId) {
      setSchoolOptions([]);
      emitSchoolSelection(null, null);
      setStatusMessage('Select a suburb first to load local schools.');
      return;
    }

    const suburb = suburbList.find((entry) => entry.id === nextSuburbId);
    if (!suburb) {
      setSchoolOptions([]);
      emitSchoolSelection(null, null);
      setStatusMessage('That suburb could not be loaded. Try another.');
      return;
    }

    void loadSchoolsForSuburb(suburb);
  }

  function onPickSearchSuburb(hit: LiveSuburb) {
    mergeSuburbIntoList(hit);
    setSelectedSuburbId(hit.id);
    setSuburbSearch('');
    setSchoolQuery('');
    setManualSchoolName('');
    setShowManualSchool(false);
    void loadSchoolsForSuburb(hit);
  }

  function onSchoolChange(schoolId: string) {
    if (!selectedSuburb) {
      emitSchoolSelection(null, null);
      return;
    }
    const school = schoolOptions.find((entry) => entry.id === schoolId) ?? null;
    emitSchoolSelection(school, selectedSuburb);
    if (school) {
      setManualSchoolName('');
      setStatusMessage(statusForSuburb(selectedSuburb, schoolOptions.length));
    }
  }

  function applyManualSchool() {
    if (!selectedSuburb) return;
    const trimmed = manualSchoolName.trim();
    if (trimmed.length < 2) return;
    const school = createManualSchoolOption(selectedSuburb.name, trimmed);
    setSchoolOptions((prev) => {
      if (prev.some((entry) => entry.id === school.id || entry.name.toLowerCase() === school.name.toLowerCase())) {
        return prev;
      }
      return [...prev, school];
    });
    emitSchoolSelection(school, selectedSuburb);
    setStatusMessage(`Using “${school.name}” in ${selectedSuburb.name}. You can continue.`);
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

  const manualReady = Boolean(selectedSuburb) && manualSchoolName.trim().length >= 2;
  const forceManual = showManualSchool || (!loadingSchools && Boolean(selectedSuburbId) && schoolOptions.length === 0);

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
        Search suburb or postcode
        <input
          type="search"
          value={suburbSearch}
          disabled={disabled || locationStatus === 'detecting'}
          onChange={(event) => setSuburbSearch(event.target.value)}
          placeholder="e.g. Craigieburn, 3030, Pakenham"
          aria-label="Search any Australian suburb or postcode"
          autoComplete="off"
        />
      </label>
      {suburbSearch.trim().length >= 2 && searchHits.length > 0 ? (
        <ul className="location-school-select__suburb-hits" role="listbox" aria-label="Suburb search results">
          {searchHits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPickSearchSuburb(hit)}
              >
                {hit.name} {hit.state} · {hit.postcode}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {suburbSearch.trim().length >= 2 && searchHits.length === 0 ? (
        <p className="field-help">No suburbs match that search.</p>
      ) : null}

      <label>
        Suburb
        <select
          value={selectedSuburbId}
          disabled={disabled || locationStatus === 'detecting'}
          onChange={(event) => onSuburbChange(event.target.value)}
          aria-label="Filter schools by suburb"
        >
          <option value="">Select a suburb</option>
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
          <optgroup label={nearbySuburbs.length > 0 ? 'Other selected suburbs' : 'Suburbs'}>
            {(nearbySuburbs.length > 0
              ? suburbList.filter((entry) => !entry.nearby)
              : suburbList
            ).map((suburb) => (
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
          required={!forceManual && !manualReady}
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

      {selectedSuburbId && !loadingSchools ? (
        <div className="location-school-select__manual">
          {!forceManual ? (
            <button
              type="button"
              className="location-school-select__manual-toggle"
              disabled={disabled}
              onClick={() => setShowManualSchool(true)}
            >
              {MANUAL_SCHOOL_HINT}
            </button>
          ) : null}
          {forceManual ? (
            <label>
              Enter your school name
              <input
                type="text"
                value={manualSchoolName}
                disabled={disabled}
                onChange={(event) => setManualSchoolName(event.target.value)}
                placeholder="Enter your school name"
                aria-label="Enter your school name manually"
                autoComplete="organization"
              />
            </label>
          ) : null}
          {forceManual ? (
            <button
              type="button"
              className="location-school-select__manual-apply"
              disabled={disabled || !manualReady}
              onClick={applyManualSchool}
            >
              Continue to SchoolRun Village
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="field-help" role="status" data-location-status={locationStatus}>
        {loadingSchools ? 'Loading local schools...' : statusMessage}
      </p>
    </div>
  );
}
