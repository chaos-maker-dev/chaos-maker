#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { chaosConfigSchemaStrict } from '../dist/chaos-maker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });

const jsonSchema = zodToJsonSchema(chaosConfigSchemaStrict, {
  name: 'ChaosConfig',
  $refStrategy: 'root',
});

const jsonPath = resolve(distDir, 'chaos-config.schema.json');
writeFileSync(jsonPath, JSON.stringify(jsonSchema, null, 2) + '\n', 'utf8');
console.log(`[chaos-maker] wrote ${jsonPath}`);

const notes = `# Chaos Config JSON Schema  -  parity caveats

This file ships beside \`chaos-config.schema.json\`. The JSON Schema artifact is
generated from the canonical Zod schemas via \`zod-to-json-schema\`. Use it for:

- IDE autocomplete via \`"$schema": "./chaos-config.schema.json"\` in JSON
  configs.
- External pre-commit linters that consume JSON Schema.
- Reference documentation for tools that cannot import a JS module.

**The runtime canonical validator is always \`validateChaosConfig\` from
\`@chaos-maker/core\`.** Do not use the JSON Schema as the sole validator
before injecting a config  -  Zod refinements that cannot translate to JSON
Schema will silently pass under JSON Schema and throw at runtime.

## Refinements that do NOT translate

| Zod refinement | JSON Schema fate |
|---|---|
| \`groupConfigList.superRefine\` (duplicate group names after \`.trim()\`) | dropped  -  JSON Schema cannot express "duplicate after normalization". |
| \`mutuallyExclusiveCounting\` (\`onNth\` / \`everyNth\` / \`afterN\` mutual exclusion) | weakly approximated; some edge cases pass JSON Schema but fail Zod. |
| WebSocket close-code refinement (\`1000\` or \`3000-4999\`) | translated as ranges; verify with the runtime validator. |
| WebSocket \`reason\` UTF-8 byte length \`<= 123\` | dropped  -  JSON Schema string length counts code points, not UTF-8 bytes. |
| GraphQL operation RegExp \`/g\` / \`/y\` flag rejection | dropped  -  JSON Schema has no RegExp-flag introspection. |
| \`graphqlOperation\` accepting \`RegExp\` instances | rendered as \`string\` only; RegExp is not a JSON Schema type. |
| Preset-name \`.trim()\` deduplication (\`presets\` array transform) | dropped  -  schema represents input shape only. |

## Recommended workflow

1. Use the JSON Schema for IDE / \`"$schema"\` references and external linters.
2. Use \`validateChaosConfig\` for actual gating in CI and at runtime.
3. Treat any divergence as expected  -  fix the runtime, not the artifact.
`;

const notesPath = resolve(distDir, 'chaos-config.schema.notes.md');
writeFileSync(notesPath, notes, 'utf8');
console.log(`[chaos-maker] wrote ${notesPath}`);
