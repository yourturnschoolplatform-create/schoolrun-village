import { useRef, useState, type DragEvent } from 'react';
import type { ListingImagePayload } from '../../shared/marketplace';
import {
  appendListingImages,
  LISTING_IMAGE_MAX,
  removeListingImage,
  setListingCoverImage,
} from '../lib/listing-image-compress';

/**
 * Mobile-friendly up-to-6 listing image grid with drag-and-drop,
 * preview, delete, and primary cover selection.
 */
export function ListingImageUploader({
  images,
  onChange,
  disabled = false,
}: {
  images: ListingImagePayload[];
  onChange: (next: ListingImagePayload[]) => void;
  disabled?: boolean;
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
