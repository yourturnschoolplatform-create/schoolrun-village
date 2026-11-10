import { useRef, useState, type DragEvent } from 'react';
import type { ListingImagePayload } from '../../shared/marketplace';
import {
  appendListingImages,
  LISTING_IMAGE_MAX,
  removeListingImage,
  setListingCoverImage,
} from '../lib/listing-image-compress';

/**
 * Listing image picker. `karrot` = horizontal camera + thumb strip;
 * `classic` keeps the dropzone grid for other surfaces.
 */
export function ListingImageUploader({
  images,
  onChange,
  disabled = false,
  variant = 'karrot',
}: {
  images: ListingImagePayload[];
  onChange: (next: ListingImagePayload[]) => void;
  disabled?: boolean;
  variant?: 'karrot' | 'classic';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = LISTING_IMAGE_MAX - images.length;

  async function ingest(files: FileList | File[] | null) {
    if (!files || remaining <= 0 || disabled) return;
    setError(null);
    try {
      onChange(await appendListingImages(images, files));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Those images could not be added.');
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void ingest(event.dataTransfer.files);
  }

  const fileInput = (
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      multiple
      disabled={disabled || remaining <= 0}
      onChange={(event) => {
        void ingest(event.target.files);
        event.target.value = '';
      }}
    />
  );

  if (variant === 'karrot') {
    return (
      <div className="listing-image-uploader listing-image-uploader--karrot">
        <div
          className={
            dragging
              ? 'listing-image-strip listing-image-strip--active'
              : 'listing-image-strip'
          }
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <button
            type="button"
            className="listing-image-camera"
            disabled={disabled || remaining <= 0}
            onClick={() => inputRef.current?.click()}
            aria-label={`Add listing photos, ${images.length} of ${LISTING_IMAGE_MAX}`}
          >
            <span className="listing-image-camera__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 8.5h2.2l1.3-2h9l1.3 2H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z" />
                <circle cx="12" cy="13.2" r="3.2" />
              </svg>
            </span>
            <span className="listing-image-camera__count">{images.length}/{LISTING_IMAGE_MAX}</span>
          </button>
          {fileInput}
          <ul className="listing-image-strip__list" aria-label="Listing image previews">
            {images.map((image, index) => (
              <li key={`${index}-${image.src.slice(0, 24)}`} className="listing-image-strip__item">
                <img src={image.src} alt="" className="listing-image-strip__preview" />
                {image.cover ? (
                  <span className="listing-image-strip__badge">Cover</span>
                ) : (
                  <button
                    type="button"
                    className="listing-image-strip__cover"
                    disabled={disabled}
                    onClick={() => onChange(setListingCoverImage(images, index))}
                  >
                    Set cover
                  </button>
                )}
                <button
                  type="button"
                  className="listing-image-strip__remove"
                  disabled={disabled}
                  aria-label={`Remove photo ${index + 1}`}
                  onClick={() => onChange(removeListingImage(images, index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
        {error ? <p className="notice notice--red" role="alert">{error}</p> : null}
        <p className="field-help">First photo is the cover. Tap × to remove.</p>
      </div>
    );
  }

  return (
    <div className="listing-image-uploader">
      <div className="listing-image-uploader__head">
        <strong>Listing images</strong>
        <span>{images.length}/{LISTING_IMAGE_MAX} · first or marked cover shows on the card</span>
      </div>

      <div
        className={
          dragging
            ? 'listing-image-dropzone listing-image-dropzone--active'
            : 'listing-image-dropzone'
        }
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drag &amp; drop up to {LISTING_IMAGE_MAX} images, or</p>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || remaining <= 0}
          onClick={() => inputRef.current?.click()}
        >
          Choose images
        </button>
        {fileInput}
      </div>

      {error ? <p className="notice notice--red" role="alert">{error}</p> : null}

      {images.length > 0 ? (
        <ul className="listing-image-grid" aria-label="Listing image previews">
          {images.map((image, index) => (
            <li key={`${index}-${image.src.slice(0, 24)}`} className="listing-image-grid__item">
              <img src={image.src} alt="" className="listing-image-grid__preview" />
              {image.cover ? (
                <span className="listing-image-grid__cover-badge">Cover</span>
              ) : null}
              <div className="listing-image-grid__actions">
                {!image.cover ? (
                  <button
                    type="button"
                    className="text-button"
                    disabled={disabled}
                    onClick={() => onChange(setListingCoverImage(images, index))}
                  >
                    Set cover
                  </button>
                ) : (
                  <span className="listing-image-grid__cover-label">Primary cover</span>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  onClick={() => onChange(removeListingImage(images, index))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
