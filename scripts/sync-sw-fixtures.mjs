#!/usr/bin/env node
/**
 * Copies the built core SW bundles into the e2e fixture directory so the
 * static file server (python http.server / http-server on CI) can serve them
 * as `/sw-app/chaos-maker-sw.js` and `/sw-app/chaos-maker-sw.mjs`.
 *
 * Both copies are gitignored  -  run `bun run build:core` (or the root `bun run build`)
 * before an e2e run to refresh them.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'packages/core/dist');
const dst = resolve(root, 'e2e-tests/fixtures/sw-app');

await mkdir(dst, { recursive: true });

const pairs = [
  ['sw.js', 'chaos-maker-sw.js'],
  ['sw.mjs', 'chaos-maker-sw.mjs'],
];

for (const [from, to] of pairs) {
  const source = resolve(src, from);
  const target = resolve(dst, to);
  await copyFile(source, target);
  console.log(`[sync-sw-fixtures] ${from} → e2e-tests/fixtures/sw-app/${to}`);
}
