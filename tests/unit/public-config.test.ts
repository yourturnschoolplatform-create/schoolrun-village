import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../server/index';

describe('/api/public-config', () => {
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

  it('returns 200 JSON with appName, supabase, and configured fields', async () => {
    const response = await fetch(`${origin}/api/public-config`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toMatch(/no-store/i);
    const body = await response.json() as {
      appName?: string;
      supabase?: unknown;
      configured?: boolean;
    };
    expect(typeof body.appName).toBe('string');
    expect(body.appName?.length).toBeGreaterThan(0);
    expect(body).toHaveProperty('supabase');
    expect(typeof body.configured).toBe('boolean');
    expect(body.configured).toBe(Boolean(body.supabase));
  });
});
