import { useEffect, useId, useState } from 'react';
import {
  formatSchoolLocationChip,
  schoolSectorBadge,
  type SchoolLocation,
} from '../../shared/au-location';

/** Safe AU pilot fallback so the ready dashboard never hides the location chip. */
export const FALLBACK_SCHOOL_LOCATION: SchoolLocation = {
  suburb: 'Harbourview',
  schoolName: 'Sample Harbourview Primary School',
  schoolSector: 'primary',
};

/** Compact suburb selector label, e.g. "Harbourview VIC, AU". */
export function formatSuburbSelector(location: SchoolLocation): string {
  const suburb = location.suburb.trim() || 'Local suburb';
  return `${suburb} VIC, AU`;
}

/** Single-line header pill: "Harbourview VIC • Primary School". */
export function formatLocationPill(location: SchoolLocation): string {
  const suburb = location.suburb.trim() || 'Local suburb';
  return `${suburb} VIC • ${schoolSectorBadge(location.schoolSector)}`;
}

const SAMPLE_SCHOOLS: SchoolLocation[] = [
  FALLBACK_SCHOOL_LOCATION,
  {
    suburb: 'Docklands',
    schoolName: 'Sample Docklands Primary School',
    schoolSector: 'primary',
  },
  {
    suburb: 'Carlton',
    schoolName: 'Sample Carlton Secondary College',
    schoolSector: 'secondary',
  },
];

/**
 * Compact single-line suburb/school pill for the header.
 * Opens a selector modal on click — never expands multi-line text in the bar.
 */
export function LocationChip({
  location = FALLBACK_SCHOOL_LOCATION,
  onSelect,
}: {
  location?: SchoolLocation | null;
  onSelect?: (next: SchoolLocation) => void;
}) {
  const resolved = location ?? FALLBACK_SCHOOL_LOCATION;
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function choose(next: SchoolLocation) {
    onSelect?.(next);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="location-chip"
        data-location-chip="au"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Location ${formatLocationPill(resolved)}. Open suburb and school selector.`}
        title={formatSchoolLocationChip(resolved)}
        onClick={() => setOpen(true)}
      >
        <span className="location-chip__pin" aria-hidden="true">📍</span>
        <span className="location-chip__place">{formatLocationPill(resolved)}</span>
      </button>

      {open ? (
        <div className="location-selector-overlay" role="presentation" onClick={() => setOpen(false)}>
          <section
            className="location-selector-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="location-selector-modal__head">
              <div>
                <p className="eyebrow">Suburb &amp; school</p>
                <h2 id={titleId}>Choose your school area</h2>
                <p className="section-copy">
                  Suburb-level only — never a street address. Verified school membership stays authoritative.
                </p>
              </div>
              <button type="button" className="text-button" onClick={() => setOpen(false)}>Close</button>
            </div>

            <p className="location-selector-modal__current">
              Current: <strong>{formatSchoolLocationChip(resolved)}</strong>
            </p>

            <ul className="location-selector-list" aria-label="Sample school areas">
              {SAMPLE_SCHOOLS.map((school) => {
                const active = school.suburb === resolved.suburb && school.schoolName === resolved.schoolName;
                return (
                  <li key={`${school.suburb}-${school.schoolName}`}>
                    <button
                      type="button"
                      className={active ? 'location-selector-option location-selector-option--active' : 'location-selector-option'}
                      onClick={() => choose(school)}
                    >
                      <span>
                        <strong>{formatLocationPill(school)}</strong>
                        <small>{school.schoolName}</small>
                      </span>
                      {active ? <em>Selected</em> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      ) : null}
    </>
  );
}
