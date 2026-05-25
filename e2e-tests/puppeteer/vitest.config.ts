import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    globalSetup: resolve(__dirname, 'setup/global-setup.ts'),
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run files serially  -  each test file launches its own browser; parallel
    // launches on CI exhaust memory and create race conditions on ports.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
