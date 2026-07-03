import { describe, it, expect } from 'vitest';
import { stripUnknownKeys, collectUnknownPaths } from '../src/validation-strip';
import { chaosConfigSchemaStrict } from '../src/validation';

describe('stripUnknownKeys', () => {
  it('removes unknown top-level keys', () => {
    const out = stripUnknownKeys({ network: {}, foo: 'x', bar: 1 });
    expect(out).not.toHaveProperty('foo');
    expect(out).not.toHaveProperty('bar');
    expect(out).toHaveProperty('network');
  });

  it('removes unknown nested rule fields under network.failures[i]', () => {
    const out = stripUnknownKeys({
      network: {
        failures: [
          { urlPattern: '/api', statusCode: 500, probability: 1, weird: 'x' },
        ],
      },
    });
    const f = (out.network!.failures as { weird?: string }[])[0];
    expect(f).not.toHaveProperty('weird');
    expect(f.statusCode).toBe(500);
  });

  it('preserves all known optional keys when present', () => {
    const out = stripUnknownKeys({
      network: {
        failures: [{
          urlPattern: '/api',
          statusCode: 503,
          probability: 1,
          body: 'b',
          statusText: 's',
          headers: { 'x-test': 'y' },
          methods: ['GET'],
          onNth: 2,
        }],
      },
    });
    expect(out.network!.failures![0]).toMatchObject({
      urlPattern: '/api',
      statusCode: 503,
      probability: 1,
      body: 'b',
      statusText: 's',
      headers: { 'x-test': 'y' },
      methods: ['GET'],
      onNth: 2,
    });
  });

  it('preserves matcher and counting fields on network rules', () => {
    const out = stripUnknownKeys({
      network: {
        failures: [{
          hostname: 'api.example.com',
          queryParams: { tenant: 'a' },
          requestHeaders: { 'x-env': 'ci' },
          resourceTypes: ['fetch'],
          statusCode: 429,
          probability: 1,
          firstN: 2,
        }],
        latencies: [{ matcher: 'apiRequests', matcherName: 'apiRequests', delayMs: 100, probability: 1 }],
      },
    });
    expect(out.network!.failures![0]).toMatchObject({
      hostname: 'api.example.com',
      queryParams: { tenant: 'a' },
      requestHeaders: { 'x-env': 'ci' },
      resourceTypes: ['fetch'],
      firstN: 2,
    });
    expect(out.network!.latencies![0]).toMatchObject({ matcher: 'apiRequests', matcherName: 'apiRequests' });
  });

  it('preserves transport matcher fields and firstN on ws, sse, and fetch-stream rules', () => {
    const out = stripUnknownKeys({
      websocket: {
        drops: [{ hostname: 'ws.example.com', direction: 'both', probability: 1, firstN: 1 }],
      },
      sse: {
        delays: [{ queryParams: { stream: true }, delayMs: 50, probability: 1 }],
      },
      fetchStream: {
        drops: [{ matcher: 'apiRequests', chunkIndex: 0, probability: 1, firstN: 3 }],
      },
    });
    expect(out.websocket!.drops![0]).toMatchObject({ hostname: 'ws.example.com', firstN: 1 });
    expect(out.sse!.delays![0]).toMatchObject({ queryParams: { stream: true } });
    expect(out.fetchStream!.drops![0]).toMatchObject({ matcher: 'apiRequests', firstN: 3 });
  });

  it('preserves chunkPattern and phase on fetch-stream corruptions', () => {
    const pattern = /"tool_calls"/;
    const out = stripUnknownKeys({
      fetchStream: {
        corruptions: [{
          urlPattern: '*',
          chunkPattern: pattern,
          strategy: 'malformed-json',
          probability: 1,
          phase: 'ai:tool-call-failed',
        }],
      },
    });
    expect(out.fetchStream!.corruptions![0]).toMatchObject({
      chunkPattern: pattern,
      phase: 'ai:tool-call-failed',
    });
  });

  it('does not mutate input', () => {
    const input = { network: { failures: [{ urlPattern: '/a', statusCode: 500, probability: 1, foo: 1 }] }, weirdTop: 'y' };
    const inputCopy = JSON.parse(JSON.stringify(input));
    stripUnknownKeys(input);
    expect(input).toEqual(inputCopy);
  });

  it('round-trip: strip(passthrough-parsed) deep-equals strict-parsed minus unknowns', () => {
    const cfg = {
      network: {
        failures: [
          { urlPattern: '/api', statusCode: 500, probability: 1.0 },
        ],
      },
      groups: [{ name: 'a', enabled: true }],
    };
    const stripped = stripUnknownKeys(cfg);
    const strictParsed = chaosConfigSchemaStrict.parse(cfg);
    expect(stripped).toEqual(strictParsed);
  });
});

describe('collectUnknownPaths', () => {
  it('returns deterministic sorted paths for unknown keys', () => {
    const paths = collectUnknownPaths({
      foo: 1,
      bar: 'x',
      network: {
        failures: [{ urlPattern: '/a', statusCode: 500, probability: 1, hello: 'y', world: 'z' }],
        weird: 'k',
      },
    });
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
    expect(paths).toContain('foo');
    expect(paths).toContain('bar');
    expect(paths).toContain('network.weird');
    expect(paths).toContain('network.failures[0].hello');
    expect(paths).toContain('network.failures[0].world');
  });

  it('returns empty array for clean config', () => {
    expect(collectUnknownPaths({ network: { failures: [] } })).toEqual([]);
  });

  it('detects unknown keys inside groups', () => {
    const paths = collectUnknownPaths({
      groups: [{ name: 'a', enabled: true, mystery: 1 }],
    });
    expect(paths).toContain('groups[0].mystery');
  });

  it('detects unknown keys inside customPresets slice', () => {
    const paths = collectUnknownPaths({
      customPresets: {
        myPreset: {
          network: {
            latencies: [{ urlPattern: '/a', delayMs: 10, probability: 1, alien: true }],
          },
          extraTopInside: 'x',
        },
      },
    });
    expect(paths).toContain('customPresets.myPreset.extraTopInside');
    expect(paths).toContain('customPresets.myPreset.network.latencies[0].alien');
  });
});
