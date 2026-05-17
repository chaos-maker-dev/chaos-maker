import { describe, it, expect } from 'vitest';
import type { ChaosConfig } from '../src/config';
import { prepareChaosConfig, validateChaosConfig } from '../src/validation';
import { ChaosConfigError } from '../src/errors';

function captureThrow(fn: () => unknown): ChaosConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ChaosConfigError) return e;
    throw e;
  }
  throw new Error('expected the call to throw ChaosConfigError');
}

describe('prepareChaosConfig with scenario profiles', () => {
  it('resolves the built-in mobileCheckout profile before preset expansion', () => {
    const out = prepareChaosConfig({ profile: 'mobile-checkout', seed: 1 });
    expect(out.profile).toBeUndefined();
    expect(out.profileOverrides).toBeUndefined();
    expect(out.customProfiles).toBeUndefined();
    expect(out.presets).toBeUndefined();
    expect(out.seed).toBe(1);
    expect(out.network).toBeDefined();
    expect(out.network!.latencies!.length).toBeGreaterThan(0);
    expect(out.network!.latencies!.some((l) => l.delayMs === 1500)).toBe(true);
  });

  it('throws unknown_profile when profile name is not registered', () => {
    const err = captureThrow(() => prepareChaosConfig({ profile: 'nope' }));
    expect(err.issues[0].code).toBe('unknown_profile');
    expect(err.issues[0].ruleType).toBe('profile');
  });

  it('throws profile_collision when customProfiles name shadows a built-in', () => {
    const err = captureThrow(() => prepareChaosConfig({
      customProfiles: { mobileCheckout: { presets: ['mobile-3g'] } },
      profile: 'mobileCheckout',
    }));
    expect(err.issues[0].code).toBe('profile_collision');
    expect(err.issues[0].ruleType).toBe('profile');
  });

  it('throws an actionable error when customProfiles slice tries to nest profile', () => {
    const err = captureThrow(() => prepareChaosConfig({
      customProfiles: { evil: { profile: 'mobileCheckout' } as never },
      profile: 'evil',
    }));
    // Zod strict pass 1 catches this as unknown_field before applyProfile gets
    // the chance to fire profile_chain. Either path produces an actionable
    // error - assert the strict rejection lists a useful code.
    expect(['unknown_field', 'profile_chain']).toContain(err.issues[0].code);
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it('profileOverrides applies on top of resolved profile rules', () => {
    const out = prepareChaosConfig({
      profile: 'mobile-checkout',
      profileOverrides: {
        network: {
          latencies: [{ urlPattern: '/api/extra', delayMs: 999, probability: 1 }],
        },
      },
    });
    expect(out.network!.latencies!.some((l) => l.urlPattern === '/api/extra' && l.delayMs === 999)).toBe(true);
  });

  it('seed precedence is preserved through the full pipeline', () => {
    const a = prepareChaosConfig({ profile: 'mobileCheckout', seed: 7, profileOverrides: { seed: 99 } });
    expect(a.seed).toBe(99);

    const b = prepareChaosConfig({ profile: 'mobileCheckout', seed: 7 });
    expect(b.seed).toBe(7);
  });

  it('configs without profile fields go through unchanged (back-compat)', () => {
    const out = prepareChaosConfig({
      network: { latencies: [{ urlPattern: '/api', delayMs: 50, probability: 1 }] },
      seed: 42,
    });
    expect(out.network!.latencies).toHaveLength(1);
    expect(out.seed).toBe(42);
  });

  it('mixes profile + presets + customPresets in one config without breaking', () => {
    const out = prepareChaosConfig({
      profile: 'mobile-checkout',
      presets: ['flaky-api'],
      customPresets: { 'team-flow': { network: { latencies: [{ urlPattern: '/team', delayMs: 100, probability: 1 }] } } },
    });
    // mobile-3g, checkout-degraded (from profile), flaky-api (from top-level), team-flow (custom) all flatten.
    expect(out.network!.latencies!.length).toBeGreaterThan(2);
  });

  it('passthrough mode strips unknown fields but still resolves the profile', () => {
    const input = { profile: 'mobile-checkout', unknownTopLevel: true } as unknown;
    const out = prepareChaosConfig(input, { unknownFields: 'ignore' });
    expect(out.profile).toBeUndefined();
    expect((out as Record<string, unknown>).unknownTopLevel).toBeUndefined();
    expect(out.network!.latencies!.length).toBeGreaterThan(0);
  });
});

describe('validateChaosConfig with scenario profiles', () => {
  it('brands the resolved config so re-validation is a cache hit', () => {
    const input: ChaosConfig = { profile: 'mobile-checkout', seed: 5 };
    const a = validateChaosConfig(input);
    const b = validateChaosConfig(a);
    expect(b).toBe(a);
  });

  it('two distinct inputs that resolve identically produce equal-shaped outputs', () => {
    const a = validateChaosConfig({ profile: 'mobile-checkout', seed: 1 });
    const b = validateChaosConfig({ profile: 'mobileCheckout', seed: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
