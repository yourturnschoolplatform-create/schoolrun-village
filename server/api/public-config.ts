import type { Request, Response } from 'express';
import { readPublicRuntimeConfig } from '../config.js';

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
}

/**
 * Browser-safe runtime config for the SPA boot path.
 * Always returns HTTP 200 JSON so the client can fall back to env when supabase is null.
 */
export function handlePublicConfig(_request: Request, response: Response): void {
  noStore(response);
  try {
    response.status(200).json(readPublicRuntimeConfig());
  } catch {
    response.status(200).json({ appName: 'SchoolRun Village', supabase: null });
  }
}
