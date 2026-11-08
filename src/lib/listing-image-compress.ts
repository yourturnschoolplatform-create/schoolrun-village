import type { ListingImagePayload } from '../../shared/marketplace';
import { normalizeListingImages } from '../../shared/marketplace';

const MAX_IMAGES = 6;
const MAX_EDGE = 960;
const JPEG_QUALITY = 0.72;

/** Compress a File into a JPEG data URL suitable for listing_images. */
export async function compressListingImageFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file (JPEG, PNG or WebP).');
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Image preview is not available in this browser.');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  if (dataUrl.length > 220000) {
    throw new Error('That image is still too large after compression. Try a simpler shot.');
  }
  return dataUrl;
}

export async function appendListingImages(
  current: ListingImagePayload[],
  files: FileList | File[],
): Promise<ListingImagePayload[]> {
  const list = Array.from(files).slice(0, MAX_IMAGES - current.length);
  const next = [...current];
  for (const file of list) {
    const src = await compressListingImageFile(file);
    next.push({ src, cover: next.length === 0 });
  }
  return normalizeListingImages(next);
}

export function removeListingImage(
  current: ListingImagePayload[],
  index: number,
): ListingImagePayload[] {
  return normalizeListingImages(current.filter((_, i) => i !== index));
}

export function setListingCoverImage(
  current: ListingImagePayload[],
  index: number,
): ListingImagePayload[] {
  return normalizeListingImages(
    current.map((entry, i) => ({ ...entry, cover: i === index })),
  );
}

export { MAX_IMAGES as LISTING_IMAGE_MAX };
