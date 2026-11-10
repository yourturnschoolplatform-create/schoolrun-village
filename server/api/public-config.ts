import type { Request, Response } from 'express';
import { readPublicRuntimeConfig } from '../config.js';

export type PublicConfigResponse = {
  appName: string;
  supabase: { url: string; anonKey: string } | null;
  configured: boolean;
};

export const PUBLIC_CONFIG_FALLBACK: PublicConfigResponse = {
  appName: 'SchoolRun Village',
  supabase: null,
  configured: false,
};

function noStore(response: Response): void {
  try {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
  } catch {
    /* ignore */
  }
}

function sendJson(response: Response, body: PublicConfigResponse): void {
  if (response.headersSent) return;
  noStore(response);
  response.status(200).json(body);
}

/** Safe payload for Express, serverless interceptors, and tests. */
export function buildPublicConfigPayload(): PublicConfigResponse {
  try {
    const config = readPublicRuntimeConfig();
    const supabase = config.supabase ?? null;
    return {
      appName: config.appName?.trim() || PUBLIC_CONFIG_FALLBACK.appName,
      supabase,
      configured: Boolean(supabase?.url && supabase?.anonKey),
    };
  } catch {
    return { ...PUBLIC_CONFIG_FALLBACK };
  }
}

/**
 * Browser-safe runtime config for the SPA boot path.
 * Always HTTP 200 — missing env yields { supabase: null, configured: false }.
 * Never calls next(error); never returns 5xx.
 */
export function handlePublicConfig(_request: Request, response: Response): void {
  try {
    sendJson(response, buildPublicConfigPayload());
  } catch (error) {
    console.error('public-config handler failed', {
      name: error instanceof Error ? error.name : 'Error',
    });
    sendJson(response, PUBLIC_CONFIG_FALLBACK);
  }
}
