import { describe, it, expect } from 'vitest';
import { ChaosConfigBuilder } from '../src/builder';
import { validateChaosConfig } from '../src/validation';

describe('ChaosConfigBuilder.defineMatcher', () => {
  it('registers a matcher on the matchers field', () => {
    const cfg = new ChaosConfigBuilder()
      .defineMatcher('customers', { urlPattern: '/api/customers', methods: ['GET'] })
      .build();
    expect(cfg.matchers).toEqual({
      customers: { urlPattern: '/api/customers', methods: ['GET'] },
    });
  });

  it('throws on duplicate name within the same builder', () => {
    const b = new ChaosConfigBuilder().defineMatcher('a', { urlPattern: '/x' });
    expect(() => b.defineMatcher('a', { urlPattern: '/y' })).toThrow(
      /already defined/,
    );
  });

  it('rejects empty / whitespace-only names', () => {
    expect(() =>
      new ChaosConfigBuilder().defineMatcher('   ', { urlPattern: '/x' }),
    ).toThrow(/matcher name cannot be empty/);
  });

  it('preserves RegExp matcher fields through cloneValue', () => {
    const cfg = new ChaosConfigBuilder()
      .defineMatcher('graphql', { urlPattern: '/graphql', graphqlOperation: /^Get/ })
      .build();
    expect(cfg.matchers!.graphql.graphqlOperation).toBeInstanceOf(RegExp);
    expect((cfg.matchers!.graphql.graphqlOperation as RegExp).source).toBe('^Get');
  });

  it('resulting config passes full validation when paired with a referencing rule', () => {
    const cfg = new ChaosConfigBuilder()
      .defineMatcher('customers', { urlPattern: '/api/customers' })
      .build();
    cfg.network = {
      failures: [
        // matcher reference, validated and resolved by validateChaosConfig.
        { matcher: 'customers', statusCode: 503, probability: 1 } as never,
      ],
    };
    const resolved = validateChaosConfig(cfg);
    const failure = resolved.network!.failures![0] as Record<string, unknown>;
    expect(failure.urlPattern).toBe('/api/customers');
    expect(failure.matcher).toBeUndefined();
    expect(resolved.matchers).toBeUndefined();
  });
});
