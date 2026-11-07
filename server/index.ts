import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { readPublicRuntimeConfig } from './config.js';
import { createOnboardingRouter, OnboardingInputError } from './onboarding-router.js';
import { createSchedulesRouter, ScheduleInputError } from './schedules-router.js';
import { createMatchesRouter, MatchInputError } from './matches-router.js';
import { createContactsRouter } from './contacts-router.js';
import { createHandoverRouter } from './handover-router.js';
import { createNotificationsRouter } from './notifications-router.js';
import { loadVerifiedSchoolScope, RequestAuthenticationError } from './supabase/request-client.js';

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);
const projectRoot = process.cwd();

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
}

function hasDatabaseCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof RequestAuthenticationError) {
    noStore(response);
    response.status(401).json({ error: 'authentication_required' });
    return;
  }
  if (error instanceof OnboardingInputError || error instanceof ScheduleInputError || error instanceof MatchInputError) {
    noStore(response);
    response.status(400).json({ error: 'invalid_onboarding_input' });
    return;
  }
  if (hasDatabaseCode(error, 'P0001')) {
    noStore(response);
    response.status(429).json({ error: 'rate_limited' });
    return;
  }

  // Parser/driver messages may contain submitted contact data. Log no bodies,
  // message/details, tokens or numbers, including malformed JSON requests.
  console.error('Request failed; sensitive error details suppressed.');
  noStore(response);
  response.status(500).json({ error: 'foundation_server_error' });
}

export async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));
  app.use((_request, response, next) => {
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // No X-Frame-Options / frame-ancestors restriction: Preview is embedded cross-site.
    next();
  });

  app.get('/api/health', (_request, response) => {
    noStore(response);
    response.status(200).json({ status: 'ok', service: 'yourturn-foundation' });
  });

  app.get('/api/public-config', (_request, response) => {
    noStore(response);
    response.status(200).json(readPublicRuntimeConfig());
  });

  // Foundation-only proof that ordinary Express data access carries the caller JWT.
  app.get('/api/foundation/school-scope', async (request, response, next) => {
    try {
      const memberships = await loadVerifiedSchoolScope(request);
      noStore(response);
      response.status(200).json({ memberships });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/onboarding', createOnboardingRouter());
  app.use('/api/schedules', createSchedulesRouter());
  app.use('/api/matches', createMatchesRouter());
  app.use('/api/contacts', createContactsRouter());
  app.use('/api/handover', createHandoverRouter());
  app.use('/api/notifications', createNotificationsRouter());

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const clientDirectory = path.resolve(projectRoot, 'dist/client');
    app.use(express.static(clientDirectory, { index: false, immutable: true, maxAge: '1y' }));
    app.use((request, response, next) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') return next();
      if (request.path.startsWith('/api/')) return response.sendStatus(404);
      response.setHeader('Cache-Control', 'no-cache');
      return response.sendFile(path.join(clientDirectory, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}

if (process.env.VITEST !== 'true') {
  const app = await createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`YourTurn foundation listening on port ${port}`);
  });
}
