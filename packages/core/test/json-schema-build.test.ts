import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '../dist');
const schemaPath = resolve(distDir, 'chaos-config.schema.json');
const notesPath = resolve(distDir, 'chaos-config.schema.notes.md');

describe.skipIf(!existsSync(schemaPath))('JSON schema build artifact', () => {
  it('parses as valid JSON', () => {
    expect(() => JSON.parse(readFileSync(schemaPath, 'utf8'))).not.toThrow();
  });

  it("top-level properties match keyof ChaosConfig", () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const top = schema.definitions?.ChaosConfig ?? schema;
    const props = Object.keys(top.properties ?? {}).sort();
    const expected = [
      'customPresets',
      'customProfiles',
      'debug',
      'groups',
      'network',
      'presets',
      'profile',
      'profileOverrides',
      'schemaVersion',
      'sse',
      'seed',
      'ui',
      'websocket',
    ].sort();
    expect(props).toEqual(expected);
  });

  it('sidecar notes file ships alongside the schema', () => {
    expect(existsSync(notesPath)).toBe(true);
    const notes = readFileSync(notesPath, 'utf8');
    expect(notes).toMatch(/parity caveats/i);
    expect(notes).toMatch(/validateChaosConfig/);
  });

  it('schema JSON has no embedded comments (JSON forbids them)', () => {
    const raw = readFileSync(schemaPath, 'utf8');
    expect(raw).not.toMatch(/^\s*\/\//m);
    expect(raw).not.toMatch(/\/\*/);
  });
});
