import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Request, type Response } from 'express';
import serverless from 'serverless-http';

type ServerlessHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => unknown | Promise<unknown>;

const PUBLIC_CONFIG_FALLBACK = {
  appName: 'SchoolRun Village',
  supabase: null as null,
  configured: false as const,
};

function requestPath(req: IncomingMessage): string {
  try {
    const raw = req.url ?? '';
    return raw.split('?')[0] ?? '';
  } catch {
    return '';
  }
}

function isPublicConfigRequest(req: IncomingMessage): boolean {
  const path = requestPath(req);
  return path === '/api/public-config'
    || path.endsWith('/api/public-config')
    || path === '/public-config';
}

/** Never throw — public-config must always answer 200 on Vercel. */
function writePublicConfig(res: ServerResponse, body: unknown = PUBLIC_CONFIG_FALLBACK): void {
  try {
    if (res.headersSent) return;
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  } catch {
    try {
      if (!res.headersSent) {
        res.statusCode = 200;
        res.end(JSON.stringify(PUBLIC_CONFIG_FALLBACK));
      }
    } catch {
      /* ignore */
    }
  }
}

function createFallbackApp() {
  const app = express();
  app.disable('x-powered-by');

  app.get(['/api/health', '/health'], (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.status(200).json({ status: 'degraded', service: 'yourturn-foundation' });
  });

  app.get(['/api/public-config', '/public-config'], (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.status(200).json(PUBLIC_CONFIG_FALLBACK);
  });

  app.use('/api', (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.status(503).json({ error: 'api_unavailable' });
  });

  return app;
}

let cachedHandler: ServerlessHandler | null = null;
let cachedFallback: ServerlessHandler | null = null;

function getFallbackHandler(): ServerlessHandler {
  if (!cachedFallback) {
    cachedFallback = serverless(createFallbackApp()) as ServerlessHandler;
  }
  return cachedFallback;
}

async function getFullHandler(): Promise<ServerlessHandler> {
  if (cachedHandler) return cachedHandler;
  try {
    const { createApp } = await import('../server/index.js');
    const app = await createApp({ serveClient: false });
    cachedHandler = serverless(app) as ServerlessHandler;
    return cachedHandler;
  } catch (error) {
    console.error('serverless createApp failed; using fallback API surface', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
    return getFallbackHandler();
  }
}

/**
 * Vercel entry: intercept /api/public-config before Express boot can 500.
 * Full app is lazy-loaded; boot failures never block the config fallback.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown> {
  if (isPublicConfigRequest(req)) {
    try {
      const { buildPublicConfigPayload } = await import('../server/api/public-config.js');
      writePublicConfig(res, buildPublicConfigPayload());
    } catch {
      writePublicConfig(res, PUBLIC_CONFIG_FALLBACK);
    }
    return undefined;
  }

  try {
    const run = await getFullHandler();
    return await run(req, res);
  } catch (error) {
    console.error('serverless handler failed', {
      name: error instanceof Error ? error.name : 'Error',
    });
    if (isPublicConfigRequest(req)) {
      writePublicConfig(res, PUBLIC_CONFIG_FALLBACK);
      return undefined;
    }
    try {
      return await getFallbackHandler()(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'api_unavailable' }));
      }
      return undefined;
    }
  }
}
