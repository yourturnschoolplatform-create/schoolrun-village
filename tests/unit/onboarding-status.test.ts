import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../server/index';

describe('/api/onboarding/status', () => {
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    const app = await createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('is registered (not 404) and requires auth', async () => {
    const response = await fetch(`${origin}/api/onboarding/status`);
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
  });

  it('rejects non-GET methods with 405', async () => {
    const response = await fetch(`${origin}/api/onboarding/status`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
  });
});
