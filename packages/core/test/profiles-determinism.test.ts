import { describe, it, expect } from 'vitest';
import type { ChaosConfig } from '../src/config';
import { applyProfile, ProfileRegistry } from '../src/profiles';
import { prepareChaosConfig, validateChaosConfig } from '../src/validation';

describe('scenario profile determinism', () => {
  it('applyProfile is pure functional: same (config, registry) -> identical output', () => {
    const input: ChaosConfig = {
      profile: 'mobile-checkout',
      seed: 42,
      profileOverrides: {
        network: { latencies: [{ urlPattern: '/api', delayMs: 99, probability: 1 }] },
      },
    };
    const a = applyProfile(input, new ProfileRegistry());
    const b = applyProfile(input, new ProfileRegistry());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('prepareChaosConfig is pure functional: same input -> identical resolved output', () => {
    const input: ChaosConfig = {
      profile: 'mobile-checkout',
      seed: 7,
      profileOverrides: { network: { aborts: [{ urlPattern: '/extra', probability: 0.5 }] } },
    };
    const a = prepareChaosConfig(input);
    const b = prepareChaosConfig(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('two distinct inputs that resolve identically produce equal-JSON outputs', () => {
    const a = prepareChaosConfig({ profile: 'mobileCheckout', seed: 1 });
    const b = prepareChaosConfig({ profile: 'mobile-checkout', seed: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('profile-only config produces same rule event ordering across calls', () => {
    const a = prepareChaosConfig({ profile: 'mobile-checkout', seed: 99 });
    const b = prepareChaosConfig({ profile: 'mobile-checkout', seed: 99 });
    // Rule arrays must be in identical order - that determines event sequence under PRNG.
    // mobile-checkout composes mobile-3g + checkout-degraded, so both latencies and
    // failures slices are guaranteed present in the resolved config.
    expect(a.network!.latencies!.map((l) => l.urlPattern)).toEqual(b.network!.latencies!.map((l) => l.urlPattern));
    expect(a.network!.failures!.map((f) => `${f.urlPattern}:${f.statusCode}`))
      .toEqual(b.network!.failures!.map((f) => `${f.urlPattern}:${f.statusCode}`));
  });
});

describe('scenario profile brand-cache behavior', () => {
  it('validateChaosConfig brands the resolved config so a re-validation returns the same object', () => {
    const input: ChaosConfig = { profile: 'mobile-checkout', seed: 5 };
    const stamped = validateChaosConfig(input);
    const second = validateChaosConfig(stamped);
    expect(second).toBe(stamped);
  });

  it('two equivalently-resolved inputs receive distinct brand-stamped objects (object identity per call)', () => {
    const a = validateChaosConfig({ profile: 'mobile-checkout', seed: 5 });
    const b = validateChaosConfig({ profile: 'mobileCheckout', seed: 5 });
    expect(a).not.toBe(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('re-validating with different opts (custom validators) bypasses the brand cache', () => {
    const input: ChaosConfig = { profile: 'mobile-checkout', seed: 5 };
    const stamped = validateChaosConfig(input);
    const reValidated = validateChaosConfig(stamped, { customValidators: { 'top-level': () => undefined } });
    // Cache only short-circuits when opts are empty; with customValidators the
    // pipeline runs end-to-end, producing a fresh validated object that
    // equals the previously stamped shape but is not the same reference.
    expect(reValidated).not.toBe(stamped);
    expect(JSON.stringify(reValidated)).toBe(JSON.stringify(stamped));
  });
});

describe('public exports', () => {
  it('exports the scenario profile surface from @chaos-maker/core', async () => {
    const mod = await import('../src/index');
    expect(typeof mod.ProfileRegistry).toBe('function');
    expect(Array.isArray(mod.BUILT_IN_PROFILES)).toBe(true);
    expect(typeof mod.applyProfile).toBe('function');
    expect(mod.BUILT_IN_PROFILES.length).toBe(2);
    expect(mod.BUILT_IN_PROFILES.map((p) => p.name)).toEqual(['mobileCheckout', 'mobile-checkout']);
  });
});
