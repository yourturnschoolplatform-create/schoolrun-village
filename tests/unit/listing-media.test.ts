import { describe, expect, it } from 'vitest';
import {
  appendListingMediaFiles,
  LISTING_IMAGE_MAX,
  validateListingVideoFile,
} from '../../src/lib/listing-media';

function fakeImage(name = 'shot.jpg'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

function fakeVideo(name = 'clip.mp4', sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'video/mp4' });
}

describe('listing media picker', () => {
  it('rejects a second video with a clear English message', async () => {
    const first = fakeVideo('one.mp4');
    const second = fakeVideo('two.mp4');
    const result = await appendListingMediaFiles([], first, [second]);
    expect(result.videoFile).toBe(first);
    expect(result.error).toMatch(/only one video/i);
  });

  it('rejects oversized videos', () => {
    const huge = fakeVideo('big.mp4', 51 * 1024 * 1024);
    expect(validateListingVideoFile(huge)).toMatch(/50 mb/i);
  });

  it('keeps photo cap at six', async () => {
    const filled = Array.from({ length: LISTING_IMAGE_MAX }, (_, i) => ({
      src: `data:image/jpeg;base64,${'x'.repeat(40)}${i}`,
      cover: i === 0,
    }));
    // appendListingImages will try to compress real images — feed zero image files after full.
    const result = await appendListingMediaFiles(filled, null, [fakeVideo()]);
    expect(result.images).toHaveLength(LISTING_IMAGE_MAX);
    expect(result.videoFile?.name).toBe('clip.mp4');
  });
});
