import { describe, it, expect } from 'vitest';
import type { ChaosConfig } from '../src/config';
import { applyProfile, ProfileRegistry } from '../src/profiles';

describe('applyProfile', () => {
  it('returns a fresh ChaosConfig — caller owns the result', () => {
    const input: ChaosConfig = { profile: 'mobileCheckout' };
    const out = applyProfile(input, new ProfileRegistry());
    expect(out).not.toBe(input);
  });

  it('strips profile, profileOverrides, customProfiles from output', () => {
    const input: ChaosConfig = {
      profile: 'mobileCheckout',
      profileOverrides: { network: { latencies: [{ urlPattern: '/x', delayMs: 10, probability: 1 }] } },
      customProfiles: { 'team-flow': {} },
    };
    const out = applyProfile(input, new ProfileRegistry());
    expect(out.profile).toBeUndefined();
    expect(out.profileOverrides).toBeUndefined();
    expect(out.customProfiles).toBeUndefined();
  });

  it('returns a near-pass-through when neither profile nor overrides are set', () => {
    const input: ChaosConfig = {
      network: { latencies: [{ urlPattern: '/api', delayMs: 50, probability: 1 }] },
      seed: 42,
    };
    const out = applyProfile(input, new ProfileRegistry());
    expect(out).not.toBe(input);
    expect(out.network).toEqual(input.network);
    expect(out.seed).toBe(42);
    expect(out.profile).toBeUndefined();
    expect(out.profileOverrides).toBeUndefined();
    expect(out.customProfiles).toBeUndefined();
  });

  it('strips customProfiles from output even when profile is unset', () => {
    const input: ChaosConfig = {
      customProfiles: { 'team-flow': { network: { latencies: [{ urlPattern: '/a', delayMs: 10, probability: 1 }] } } },
    };
    const out = applyProfile(input, new ProfileRegistry());
    expect(out.customProfiles).toBeUndefined();
  });

  it('expands a built-in profile via the registry — mobileCheckout folds its presets into the output', () => {
    const out = applyProfile({ profile: 'mobileCheckout' }, new ProfileRegistry());
    expect(out.presets).toEqual(['mobile-3g', 'checkout-degraded']);
  });

  it('camelCase + kebab alias resolve to identical output', () => {
    const a = applyProfile({ profile: 'mobileCheckout' }, new ProfileRegistry());
    const b = applyProfile({ profile: 'mobile-checkout' }, new ProfileRegistry());
    expect(a).toEqual(b);
  });

  it('throws when profile name is unknown', () => {
    expect(() => applyProfile({ profile: 'nope' }, new ProfileRegistry()))
      .toThrow(/profile 'nope' is not registered/);
  });

  it('appends rule arrays in order: profile -> top-level -> overrides', () => {
    const registry = new ProfileRegistry([{
      name: 'p',
      config: { network: { latencies: [{ urlPattern: '/from-profile', delayMs: 100, probability: 1 }] } },
    }]);
    const input: ChaosConfig = {
      profile: 'p',
      network: { latencies: [{ urlPattern: '/from-top', delayMs: 200, probability: 1 }] },
      profileOverrides: { network: { latencies: [{ urlPattern: '/from-overrides', delayMs: 300, probability: 1 }] } },
    };
    const out = applyProfile(input, registry);
    expect(out.network!.latencies!.map((l) => l.urlPattern)).toEqual([
      '/from-profile',
      '/from-top',
      '/from-overrides',
    ]);
  });

  it('appends groups in order: profile -> top-level -> overrides', () => {
    const registry = new ProfileRegistry([{
      name: 'p',
      config: { groups: [{ name: 'from-profile', enabled: true }] },
    }]);
    const input: ChaosConfig = {
      profile: 'p',
      groups: [{ name: 'from-top' }],
      profileOverrides: { groups: [{ name: 'from-overrides', enabled: false }] },
    };
    const out = applyProfile(input, registry);
    expect(out.groups!.map((g) => g.name)).toEqual(['from-profile', 'from-top', 'from-overrides']);
  });

  it('merges presets[] in order: profile -> top-level -> overrides, deduplicating', () => {
    const registry = new ProfileRegistry([{
      name: 'p',
      config: { presets: ['slow-api', 'flaky-api'] },
    }]);
    const input: ChaosConfig = {
      profile: 'p',
      presets: ['flaky-api', 'offline-mode'],
      profileOverrides: { presets: ['offline-mode', 'high-latency'] },
    };
    const out = applyProfile(input, registry);
    expect(out.presets).toEqual(['slow-api', 'flaky-api', 'offline-mode', 'high-latency']);
  });

  it('seed precedence: overrides > top-level > profile', () => {
    const registry = new ProfileRegistry([{ name: 'p', config: { seed: 1 } }]);

    const onlyProfile = applyProfile({ profile: 'p' }, registry);
    expect(onlyProfile.seed).toBe(1);

    const topBeatsProfile = applyProfile({ profile: 'p', seed: 2 }, registry);
    expect(topBeatsProfile.seed).toBe(2);

    const overrideBeatsAll = applyProfile(
      { profile: 'p', seed: 2, profileOverrides: { seed: 3 } },
      registry,
    );
    expect(overrideBeatsAll.seed).toBe(3);
  });

  it('debug precedence: overrides > top-level > profile', () => {
    const registry = new ProfileRegistry([{ name: 'p', config: { debug: false } }]);

    const overrideWins = applyProfile(
      { profile: 'p', debug: false, profileOverrides: { debug: true } },
      registry,
    );
    expect(overrideWins.debug).toBe(true);

    const topBeatsProfile = applyProfile({ profile: 'p', debug: true }, registry);
    expect(topBeatsProfile.debug).toBe(true);

    const onlyProfile = applyProfile({ profile: 'p' }, registry);
    expect(onlyProfile.debug).toBe(false);
  });

  it('throws profile_chain when profile slice carries nested profile', () => {
    const registry = new ProfileRegistry([{
      name: 'p',
      config: { profile: 'mobileCheckout' } as never,
    }]);
    expect(() => applyProfile({ profile: 'p' }, registry))
      .toThrow(/may not contain 'profile'/);
  });

  it('throws profile_chain when profile slice carries customProfiles', () => {
    const registry = new ProfileRegistry([{
      name: 'p',
      config: { customProfiles: {} } as never,
    }]);
    expect(() => applyProfile({ profile: 'p' }, registry))
      .toThrow(/may not contain 'customProfiles'/);
  });

  it('throws profile_chain when profileOverrides carries customPresets', () => {
    expect(() => applyProfile(
      { profileOverrides: { customPresets: {} } as never },
      new ProfileRegistry(),
    )).toThrow(/may not contain 'customPresets'/);
  });

  it('applies overrides even when no profile is named', () => {
    const out = applyProfile(
      {
        network: { latencies: [{ urlPattern: '/api', delayMs: 100, probability: 1 }] },
        profileOverrides: { network: { latencies: [{ urlPattern: '/extra', delayMs: 200, probability: 1 }] } },
      },
      new ProfileRegistry(),
    );
    expect(out.network!.latencies).toHaveLength(2);
    expect(out.network!.latencies!.map((l) => l.urlPattern)).toEqual(['/api', '/extra']);
  });

  it('does not mutate the input config', () => {
    const input: ChaosConfig = {
      profile: 'mobileCheckout',
      network: { latencies: [{ urlPattern: '/u', delayMs: 50, probability: 1 }] },
    };
    const snapshot = JSON.stringify(input);
    applyProfile(input, new ProfileRegistry());
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('does not mutate the registered profile slice', () => {
    const registry = new ProfileRegistry();
    const sliceBefore = JSON.stringify(registry.get('mobileCheckout'));
    applyProfile({ profile: 'mobileCheckout' }, registry);
    expect(JSON.stringify(registry.get('mobileCheckout'))).toBe(sliceBefore);
  });

  it('passes customPresets through unchanged for downstream preset expansion', () => {
    const customPresets = { 'team-flow': { network: { latencies: [{ urlPattern: '/t', delayMs: 10, probability: 1 }] } } };
    const out = applyProfile(
      { profile: 'mobileCheckout', customPresets },
      new ProfileRegistry(),
    );
    expect(out.customPresets).toEqual(customPresets);
  });

  it('carries schemaVersion through from the top-level input', () => {
    const out = applyProfile({ profile: 'mobileCheckout', schemaVersion: 1 }, new ProfileRegistry());
    expect(out.schemaVersion).toBe(1);
  });

  it('preserves first-occurrence dedup of presets across overlapping layers', () => {
    const registry = new ProfileRegistry([{ name: 'p', config: { presets: ['slow-api'] } }]);
    const out = applyProfile(
      { profile: 'p', presets: ['slow-api'], profileOverrides: { presets: ['slow-api'] } },
      registry,
    );
    expect(out.presets).toEqual(['slow-api']);
  });
});
