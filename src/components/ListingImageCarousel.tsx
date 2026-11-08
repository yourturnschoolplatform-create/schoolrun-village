import { useState } from 'react';
import type { ListingImagePayload } from '../../shared/marketplace';
import { coverListingImage } from '../../shared/marketplace';

/**
 * Compact listing gallery: cover thumbnail with optional multi-image carousel.
 */
export function ListingImageCarousel({
  images,
  title,
}: {
  images: ListingImagePayload[] | null | undefined;
  title: string;
}) {
  const list = images?.length ? images : [];
  const cover = coverListingImage(list);
  const [index, setIndex] = useState(() => {
    if (!list.length) return 0;
    const coverIdx = list.findIndex((entry) => entry.cover);
    return coverIdx >= 0 ? coverIdx : 0;
  });

  if (!cover) {
    return (
      <div className="marketplace-card__media marketplace-card__media--empty" aria-hidden="true">
        <span className="marketplace-card__thumb">Item</span>
      </div>
    );
  }

  const current = list[Math.min(index, list.length - 1)] ?? cover;
  const showControls = list.length > 1;

  return (
    <div className="marketplace-card__media marketplace-carousel">
      <img
        className="marketplace-carousel__image"
        src={current.src}
        alt={`${title} listing image ${Math.min(index, list.length - 1) + 1} of ${list.length}`}
      />
      {showControls ? (
        <div className="marketplace-carousel__controls">
          <button
            type="button"
            className="marketplace-carousel__nav"
            aria-label="Previous listing image"
            onClick={() => setIndex((value) => (value - 1 + list.length) % list.length)}
          >
            ‹
          </button>
          <span className="marketplace-carousel__count">{Math.min(index, list.length - 1) + 1}/{list.length}</span>
          <button
            type="button"
            className="marketplace-carousel__nav"
            aria-label="Next listing image"
            onClick={() => setIndex((value) => (value + 1) % list.length)}
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}
