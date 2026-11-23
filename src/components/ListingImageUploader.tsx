import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { ListingImagePayload } from '../../shared/marketplace';
import {
  appendListingMediaFiles,
  LISTING_IMAGE_MAX,
  LISTING_MEDIA_ACCEPT,
  LISTING_VIDEO_MAX,
  removeListingImage,
  setListingCoverImage,
} from '../lib/listing-media';

/**
 * Listing media picker. Photos (max 6) + optional 1 video.
 * `karrot` = horizontal camera + thumb strip; `classic` keeps the dropzone grid.
 */
export function ListingImageUploader({
  images,
  onChange,
  videoFile = null,
  videoPreviewUrl = null,
  onVideoChange,
  disabled = false,
  variant = 'karrot',
}: {
  images: ListingImagePayload[];
  onChange: (next: ListingImagePayload[]) => void;
  videoFile?: File | null;
  /** Object URL or saved HTTPS URL for the attached video preview. */
  videoPreviewUrl?: string | null;
  onVideoChange?: (file: File | null) => void;
  disabled?: boolean;
  variant?: 'karrot' | 'classic';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoSlots = LISTING_IMAGE_MAX - images.length;
  const videoSlots = videoFile || videoPreviewUrl ? 0 : LISTING_VIDEO_MAX;
  const canAddMore = photoSlots > 0 || videoSlots > 0;

  useEffect(() => () => {
    /* parent owns object URL lifecycle */
  }, []);

  async function ingest(files: FileList | File[] | null) {
    if (!files || disabled) return;
    setError(null);
    const result = await appendListingMediaFiles(images, videoFile, files);
    if (result.images !== images) onChange(result.images);
    if (onVideoChange && result.videoFile !== videoFile) {
      onVideoChange(result.videoFile);
    }
    if (result.error) setError(result.error);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void ingest(event.dataTransfer.files);
  }

  function clearVideo() {
    onVideoChange?.(null);
    setError(null);
  }

  const fileInput = (
    <input
      ref={inputRef}
      className="visually-hidden"
      type="file"
      accept={LISTING_MEDIA_ACCEPT}
      multiple
      disabled={disabled || !canAddMore}
      onChange={(event) => {
        void ingest(event.target.files);
        event.target.value = '';
      }}
    />
  );

  const videoTile = (videoFile || videoPreviewUrl) ? (
    <li className="listing-image-strip__item listing-image-strip__item--video">
      <video
        className="listing-image-strip__preview listing-image-strip__preview--video"
        src={videoPreviewUrl || undefined}
        controls
        playsInline
        preload="metadata"
        aria-label="Listing video preview"
      />
      <span className="listing-image-strip__badge listing-image-strip__badge--video">Video</span>
      <button
        type="button"
        className="listing-image-strip__remove"
        disabled={disabled || !onVideoChange}
        aria-label="Remove video"
        onClick={clearVideo}
      >
        ×
      </button>
    </li>
  ) : null;

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
            disabled={disabled || !canAddMore}
            onClick={() => inputRef.current?.click()}
            aria-label={`Add listing photos and video, ${images.length} of ${LISTING_IMAGE_MAX} photos${videoFile || videoPreviewUrl ? ', video attached' : ''}`}
          >
            <span className="listing-image-camera__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 8.5h2.2l1.3-2h9l1.3 2H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z" />
                <circle cx="12" cy="13.2" r="3.2" />
              </svg>
            </span>
            <span className="listing-image-camera__count">
              {images.length}/{LISTING_IMAGE_MAX}
              {videoFile || videoPreviewUrl ? ' · 1 video' : ''}
            </span>
          </button>
          {fileInput}
          <ul className="listing-image-strip__list" aria-label="Listing media previews">
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
            {videoTile}
          </ul>
        </div>
        {error ? <p className="notice notice--red" role="alert">{error}</p> : null}
        <p className="field-help">
          Up to {LISTING_IMAGE_MAX} photos and 1 video (MP4/MOV/WebM, max 50 MB). First photo is the cover.
        </p>
      </div>
    );
  }

  return (
    <div className="listing-image-uploader">
      <div className="listing-image-uploader__head">
        <strong>Listing media</strong>
        <span>
          {images.length}/{LISTING_IMAGE_MAX} photos
          {videoFile || videoPreviewUrl ? ' · 1 video' : ''}
          {' · first or marked cover shows on the card'}
        </span>
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
        <p>Drag &amp; drop up to {LISTING_IMAGE_MAX} photos and 1 video, or</p>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !canAddMore}
          onClick={() => inputRef.current?.click()}
        >
          Choose photos or video
        </button>
        {fileInput}
      </div>

      {error ? <p className="notice notice--red" role="alert">{error}</p> : null}

      {images.length > 0 || videoFile || videoPreviewUrl ? (
        <ul className="listing-image-grid" aria-label="Listing media previews">
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
          {(videoFile || videoPreviewUrl) ? (
            <li className="listing-image-grid__item listing-image-grid__item--video">
              <video
                className="listing-image-grid__preview"
                src={videoPreviewUrl || undefined}
                controls
                playsInline
                preload="metadata"
                aria-label="Listing video preview"
              />
              <span className="listing-image-grid__cover-badge">Video</span>
              <div className="listing-image-grid__actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled || !onVideoChange}
                  onClick={clearVideo}
                >
                  Delete video
                </button>
              </div>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
