import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Plugin-side UMD resolver. Runs in Node (Cypress's `setupNodeEvents` process),
 * NOT in the browser. Called by the `chaos:getUmdSource` task to read the
 * `@chaos-maker/core` UMD bundle and hand its source string to the test runner,
 * which then injects it into the AUT window via a `<script>` tag.
 *
 * The path is resolved from `@chaos-maker/core` via `require.resolve` so we
 * always pick up the installed version  -  no hard-coded relative paths, and no
 * version drift between core and cypress adapter.
 */

let cachedSource: string | null = null;
let cachedPath: string | null = null;

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
}

/** Resolve the absolute path to `chaos-maker.umd.js` inside the installed core package. */
export function resolveCoreUmdPath(): string {
  if (cachedPath) return cachedPath;
  const req = createRequire(resolve(getCurrentDir(), 'package.json'));
  const coreEntry = req.resolve('@chaos-maker/core');
  const coreDistDir = dirname(coreEntry);
  cachedPath = resolve(coreDistDir, 'chaos-maker.umd.js');
  return cachedPath;
}

/** Read the UMD bundle as a string. Cached across calls within the same Node process. */
export function loadCoreUmdSource(): string {
  if (cachedSource !== null) return cachedSource;
  const path = resolveCoreUmdPath();
  cachedSource = readFileSync(path, 'utf8');
  return cachedSource;
}
