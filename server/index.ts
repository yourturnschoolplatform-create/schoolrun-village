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
import { createAdminRouter } from './admin-router.js';
import { createPartnerRouter } from './partner-router.js';
import { databaseErrorCode, logSafeServerError } from './safe-error-log.js';
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

  // Invitation claim RPCs raise P0002 when the token row is missing/expired/used.
  // Prefer a stable 404 over foundation_server_error (also handled in-router).
  const requestPath = _request.originalUrl.split('?')[0] ?? '';
  if (
    databaseErrorCode(error) === 'P0002'
    && (
      requestPath.endsWith('/invitations/claim')
      || requestPath.endsWith('/households/invitations/claim')
    )
  ) {
    noStore(response);
    response.status(404).json({ error: 'invitation_unavailable' });
    return;
  }

  // Parser/driver messages may contain submitted contact data. Log only safe
  // name/code to the server console; never message, details, stack, or bodies.
  logSafeServerError('foundation', error);
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
    try {
      response.status(200).json(readPublicRuntimeConfig());
    } catch {
      // Never fail the SPA boot path; browser will use env fallbacks if needed.
      response.status(200).json({ appName: 'SchoolRun Village', supabase: null });
    }
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
  app.use('/api/admin', createAdminRouter());
  app.use('/api/partner', createPartnerRouter());

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
    console.log(`SchoolRun Village foundation listening on port ${port}`);
  });
}
