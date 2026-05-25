import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Dedicated build for the Service-Worker subpath entry (`@chaos-maker/core/sw`).
 *
 * Separate config because:
 *   - The SW bundle must emit a classic IIFE for `importScripts(...)` usage
 *     (the main `ChaosMaker` bundle is UMD/ESM  -  UMD's `module`/`exports`
 *     detection breaks classic SW scopes).
 *   - We leave the main bundle's `dist/` output intact (`emptyOutDir: false`)
 *     so users can run `vite build` (main) and `vite build -c vite.config.sw.ts`
 *     (SW) sequentially during `bun run build`.
 */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/sw.ts'),
      name: 'ChaosMakerSW',
      formats: ['iife', 'es'],
      fileName: (format) => (format === 'es' ? 'sw.mjs' : 'sw.js'),
    },
    outDir: 'dist',
  },
});
