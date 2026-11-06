import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/rls/**/*.test.ts'],
    environment: 'node',
    globals: true,
    reporters: ['default'],
    testTimeout: 20_000,
  },
});
