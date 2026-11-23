import type { SupabaseClient } from '@supabase/supabase-js';
import type { ListingImagePayload } from '../../shared/marketplace';
import {
  appendListingImages,
  LISTING_IMAGE_MAX,
  removeListingImage,
  setListingCoverImage,
} from './listing-image-compress';

export const LISTING_VIDEO_MAX = 1;
export const LISTING_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export const LISTING_VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm';
export const LISTING_MEDIA_ACCEPT =
  'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm';

const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export type ListingMediaPickResult = {
  images: ListingImagePayload[];
  videoFile: File | null;
  error: string | null;
};

export function isListingVideoFile(file: File): boolean {
  if (VIDEO_MIME.has(file.type)) return true;
  const name = file.name.toLowerCase();
  return name.endsWith('.mp4') || name.endsWith('.mov') || name.endsWith('.webm');
}

export function validateListingVideoFile(file: File): string | null {
  if (!isListingVideoFile(file)) {
    return 'Choose a video file (MP4, MOV or WebM).';
  }
  if (file.size > LISTING_VIDEO_MAX_BYTES) {
    return 'That video is larger than 50 MB. Choose a shorter clip.';
  }
  return null;
}

/**
 * Merge newly picked files into photo + optional video slots.
 * Photos: max 6. Video: max 1. Clear English errors; never throws for validation.
 */
export async function appendListingMediaFiles(
  currentImages: ListingImagePayload[],
  currentVideo: File | null,
  files: FileList | File[],
): Promise<ListingMediaPickResult> {
  const picked = Array.from(files);
  let images = [...currentImages];
  let videoFile = currentVideo;
  let error: string | null = null;

  const imageFiles: File[] = [];
  for (const file of picked) {
    if (isListingVideoFile(file)) {
      const videoError = validateListingVideoFile(file);
      if (videoError) {
        error = videoError;
        continue;
      }
      if (videoFile) {
        error = 'Only one video can be attached to a listing.';
        continue;
      }
      videoFile = file;
      continue;
    }
    if (file.type.startsWith('image/')) {
      imageFiles.push(file);
      continue;
    }
    error = 'Choose image files (JPEG, PNG or WebP) or one video (MP4, MOV or WebM).';
  }

  const photoSlots = LISTING_IMAGE_MAX - images.length;
  if (imageFiles.length > photoSlots) {
    error = `You can add up to ${LISTING_IMAGE_MAX} photos.`;
  }
  if (imageFiles.length > 0 && photoSlots > 0) {
    try {
      images = await appendListingImages(images, imageFiles.slice(0, photoSlots));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Those photos could not be added.';
    }
  }

  return { images, videoFile, error };
}

export {
  LISTING_IMAGE_MAX,
  removeListingImage,
  setListingCoverImage,
};

/** Upload one listing video to the public listing-media bucket; returns HTTPS URL. */
export async function uploadListingVideo(
  client: SupabaseClient,
  userId: string,
  file: File,
): Promise<string> {
  const videoError = validateListingVideoFile(file);
  if (videoError) throw new Error(videoError);

  const ext = file.name.toLowerCase().endsWith('.mov')
    ? 'mov'
    : file.name.toLowerCase().endsWith('.webm')
      ? 'webm'
      : 'mp4';
  const path = `${userId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const { error } = await client.storage.from('listing-media').upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'video/mp4',
    upsert: false,
  });
  if (error) {
    console.error('listing-media upload', error.message);
    throw new Error(
      'The video could not be uploaded. Check that listing media storage is set up, then try again.',
    );
  }

  const { data } = client.storage.from('listing-media').getPublicUrl(path);
  const url = data.publicUrl?.trim() ?? '';
  if (!/^https:\/\//i.test(url)) {
    throw new Error('The video upload finished but no public URL was returned.');
  }
  return url;
}
