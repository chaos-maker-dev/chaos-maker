import { describe, it, expect } from 'vitest';
import { chaosConfigSchemaStrict, prepareChaosConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';
import { formatZodIssue } from '../src/validation-format';
import { z } from 'zod';

function parseExpectIssues(input: unknown): ReturnType<typeof formatZodIssue>[] {
  const result = chaosConfigSchemaStrict.safeParse(input);
  if (result.success) return [];
  const issues = (result.error as z.ZodError).issues;
  return issues.map(formatZodIssue);
}

describe('Zod schema: advanced matcher fields', () => {
  it('accepts a rule with hostname + queryParams + requestHeaders + resourceTypes', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      network: {
        failures: [
          {
            urlPattern: '*',
            hostname: 'api.example.com',
            queryParams: { role: 'admin', debug: true },
            requestHeaders: { authorization: /^Bearer / },
            resourceTypes: ['fetch'],
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    expect(res.success).toBe(true);
  });

  it('rejects RegExp matcher with global flag', () => {
    const issues = parseExpectIssues({
      network: {
        failures: [
          {
            urlPattern: '/api',
            hostname: /example\.com/g,
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    expect(issues.some((i) => i.code === 'invalid_regex')).toBe(true);
  });

  it('rejects resourceTypes with unknown enum value', () => {
    const issues = parseExpectIssues({
      network: {
        failures: [
          {
            urlPattern: '/api',
            resourceTypes: ['document'],
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    expect(issues.some((i) => i.code === 'invalid_enum')).toBe(true);
  });

  it('rejects empty resourceTypes array', () => {
    const issues = parseExpectIssues({
      network: {
        failures: [
          {
            urlPattern: '/api',
            resourceTypes: [],
            statusCode: 503,
            probability: 1,
          },
        ],
      },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('Zod schema: matcher / inline mutual exclusion', () => {
  it('matcher_inline_conflict when both matcher and inline fields are set', () => {
    const issues = parseExpectIssues({
      network: {
        failures: [
          {
            matcher: 'customers',
            urlPattern: '/api',
            statusCode: 503,
            probability: 1,
          },
        ],
      },
      matchers: { customers: { urlPattern: '/api/customers' } },
    });
    expect(issues.some((i) => i.code === 'matcher_inline_conflict')).toBe(true);
  });

  it('errors when a rule sets neither matcher nor an inline matcher field', () => {
    const issues = parseExpectIssues({
      network: {
        failures: [
          { statusCode: 503, probability: 1 },
        ],
      },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].ruleType).toBe('network.failure');
  });

  it('accepts a rule that uses only `matcher` reference', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
      matchers: { customers: { urlPattern: '/api/customers' } },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a rule with only hostname (no urlPattern)', () => {
    const res = chaosConfigSchemaStrict.safeParse({
      network: {
        latencies: [
          {
            hostname: 'api.example.com',
            delayMs: 100,
            probability: 1,
          },
        ],
      },
    });
    expect(res.success).toBe(true);
  });
});

describe('Zod schema: matchers registry', () => {
  it('rejects an empty matcher entry', () => {
    const issues = parseExpectIssues({
      matchers: { customers: {} },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].ruleType).toBe('matcher');
  });

  it('matcher_cycle when a registry entry contains a matcher reference', () => {
    const issues = parseExpectIssues({
      matchers: { customers: { matcher: 'other' } },
    });
    expect(issues.some((i) => i.code === 'matcher_cycle')).toBe(true);
  });

  it('rejects matcher names that are empty after trim', () => {
    const issues = parseExpectIssues({
      matchers: { '   ': { urlPattern: '/api' } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('ChaosConfigError surfaces matcher codes', () => {
  it('throws ChaosConfigError with matcher_inline_conflict code via aggregator', () => {
    const result = chaosConfigSchemaStrict.safeParse({
      network: {
        failures: [
          { matcher: 'a', urlPattern: '/api', statusCode: 500, probability: 1 },
        ],
      },
      matchers: { a: { urlPattern: '/api' } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const aggregated = new ChaosConfigError(result.error.issues.map(formatZodIssue));
    expect(aggregated.issues.some((i) => i.code === 'matcher_inline_conflict')).toBe(true);
  });
});

describe('prepareChaosConfig: matcher resolution pipeline', () => {
  it('inlines a registered matcher into a rule and strips the matchers field', () => {
    const out = prepareChaosConfig({
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
      matchers: { customers: { urlPattern: '/api/customers', methods: ['GET'] } },
    });
    expect(out.matchers).toBeUndefined();
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/api/customers');
    expect(f.methods).toEqual(['GET']);
    expect(f.matcher).toBeUndefined();
    expect(f.statusCode).toBe(503);
  });

  it('matcher_not_found when a rule references an unregistered matcher', () => {
    let err: unknown;
    try {
      prepareChaosConfig({
        network: {
          failures: [
            { matcher: 'absent', statusCode: 500, probability: 1 },
          ],
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChaosConfigError);
    expect((err as ChaosConfigError).issues[0].code).toBe('matcher_not_found');
    expect((err as ChaosConfigError).issues[0].path).toBe('matchers.absent');
  });

  it('resolves matchers referenced by rules brought in by presets', () => {
    const out = prepareChaosConfig({
      presets: ['my-preset'],
      customPresets: {
        'my-preset': {
          network: {
            failures: [
              { matcher: 'shared', statusCode: 503, probability: 1 },
            ],
          },
        },
      },
      matchers: { shared: { urlPattern: '/api/shared' } },
    });
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/api/shared');
    expect(f.matcher).toBeUndefined();
  });

  it('resolves matchers referenced by rules brought in by a profile', () => {
    const out = prepareChaosConfig({
      profile: 'team-profile',
      customProfiles: {
        'team-profile': {
          network: {
            failures: [
              { matcher: 'shared', statusCode: 503, probability: 1 },
            ],
          },
        },
      },
      matchers: { shared: { urlPattern: '/api/team' } },
    });
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/api/team');
    expect(f.matcher).toBeUndefined();
  });

  it('resolves matchers referenced by rules brought in by profileOverrides', () => {
    const out = prepareChaosConfig({
      profileOverrides: {
        network: {
          failures: [
            { matcher: 'shared', statusCode: 503, probability: 1 },
          ],
        },
      },
      matchers: { shared: { urlPattern: '/api/override' } },
    });
    const f = out.network!.failures![0] as Record<string, unknown>;
    expect(f.urlPattern).toBe('/api/override');
    expect(f.matcher).toBeUndefined();
  });
});
