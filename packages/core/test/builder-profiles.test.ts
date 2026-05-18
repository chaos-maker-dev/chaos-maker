import { describe, it, expect } from 'vitest';
import { ChaosConfigBuilder } from '../src/builder';
import { prepareChaosConfig } from '../src/validation';

describe('ChaosConfigBuilder profile API', () => {
  describe('useProfile', () => {
    it('sets config.profile on the built output', () => {
      const out = new ChaosConfigBuilder().useProfile('mobile-checkout').build();
      expect(out.profile).toBe('mobile-checkout');
    });

    it('replaces an earlier profile on second call (singular semantics)', () => {
      const out = new ChaosConfigBuilder()
        .useProfile('first-profile')
        .useProfile('mobile-checkout')
        .build();
      expect(out.profile).toBe('mobile-checkout');
    });

    it('rejects empty / whitespace-only names', () => {
      expect(() => new ChaosConfigBuilder().useProfile('')).toThrow(/cannot be empty/);
      expect(() => new ChaosConfigBuilder().useProfile('   ')).toThrow(/cannot be empty/);
    });

    it('trims surrounding whitespace', () => {
      const out = new ChaosConfigBuilder().useProfile('  mobile-checkout  ').build();
      expect(out.profile).toBe('mobile-checkout');
    });
  });

  describe('defineProfile', () => {
    it('adds an inline profile to customProfiles on the built output', () => {
      const out = new ChaosConfigBuilder()
        .defineProfile('team-saturday', {
          presets: ['flaky-api'],
        })
        .build();
      expect(out.customProfiles!['team-saturday'].presets).toEqual(['flaky-api']);
    });

    it('deep-clones the slice so post-call mutation does not leak', () => {
      const slice = { network: { latencies: [{ urlPattern: '/x', delayMs: 10, probability: 1 }] } };
      const builder = new ChaosConfigBuilder().defineProfile('team-saturday', slice);
      slice.network.latencies[0].delayMs = 999;
      const out = builder.build();
      expect(out.customProfiles!['team-saturday'].network!.latencies![0].delayMs).toBe(10);
    });

    it('rejects duplicate names within the same builder', () => {
      const builder = new ChaosConfigBuilder().defineProfile('team-saturday', {});
      expect(() => builder.defineProfile('team-saturday', {})).toThrow(/already defined/);
    });

    it('rejects empty / whitespace-only names', () => {
      expect(() => new ChaosConfigBuilder().defineProfile('', {})).toThrow(/cannot be empty/);
      expect(() => new ChaosConfigBuilder().defineProfile('   ', {})).toThrow(/cannot be empty/);
    });

    it('built config + defineProfile + useProfile is end-to-end resolvable', () => {
      const built = new ChaosConfigBuilder()
        .defineProfile('checkout-blast', { presets: ['mobile-3g'] })
        .useProfile('checkout-blast')
        .build();
      const out = prepareChaosConfig(built);
      expect(out.network!.latencies!.length).toBeGreaterThan(0);
    });
  });

  describe('overrideProfile', () => {
    it('sets profileOverrides on the built output', () => {
      const out = new ChaosConfigBuilder()
        .useProfile('mobile-checkout')
        .overrideProfile({ network: { latencies: [{ urlPattern: '/x', delayMs: 1, probability: 1 }] } })
        .build();
      expect(out.profileOverrides!.network!.latencies).toHaveLength(1);
    });

    it('accumulates across calls — rule arrays append', () => {
      const out = new ChaosConfigBuilder()
        .overrideProfile({ network: { latencies: [{ urlPattern: '/a', delayMs: 1, probability: 1 }] } })
        .overrideProfile({ network: { latencies: [{ urlPattern: '/b', delayMs: 2, probability: 1 }] } })
        .build();
      expect(out.profileOverrides!.network!.latencies!.map((l) => l.urlPattern)).toEqual(['/a', '/b']);
    });

    it('accumulates across calls — scalars (seed, debug) use last-write-wins', () => {
      const out = new ChaosConfigBuilder()
        .overrideProfile({ seed: 1, debug: false })
        .overrideProfile({ seed: 2 })
        .overrideProfile({ debug: true })
        .build();
      expect(out.profileOverrides!.seed).toBe(2);
      expect(out.profileOverrides!.debug).toBe(true);
    });

    it('groups also append across calls', () => {
      const out = new ChaosConfigBuilder()
        .overrideProfile({ groups: [{ name: 'first' }] })
        .overrideProfile({ groups: [{ name: 'second', enabled: false }] })
        .build();
      expect(out.profileOverrides!.groups!.map((g) => g.name)).toEqual(['first', 'second']);
    });

    it('overrideProfile works without useProfile (overrides standalone)', () => {
      const built = new ChaosConfigBuilder()
        .addLatency('/api', 50, 1)
        .overrideProfile({ network: { latencies: [{ urlPattern: '/extra', delayMs: 200, probability: 1 }] } })
        .build();
      const out = prepareChaosConfig(built);
      expect(out.network!.latencies!.map((l) => l.urlPattern)).toEqual(['/api', '/extra']);
    });
  });

  describe('full builder chain', () => {
    it('useProfile + defineProfile + overrideProfile produce a resolvable config', () => {
      const built = new ChaosConfigBuilder()
        .defineProfile('team-checkout', { presets: ['mobile-3g'] })
        .useProfile('team-checkout')
        .overrideProfile({ network: { latencies: [{ urlPattern: '/special', delayMs: 5, probability: 1 }] } })
        .withSeed(42)
        .build();
      const out = prepareChaosConfig(built);
      expect(out.seed).toBe(42);
      expect(out.network!.latencies!.some((l) => l.urlPattern === '/special')).toBe(true);
    });
  });
});
