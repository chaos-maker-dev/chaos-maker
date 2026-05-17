import { describe, it, expect } from 'vitest';
import { BUILT_IN_PROFILES, ProfileRegistry } from '../src/profiles';

describe('ProfileRegistry', () => {
  it('seeds 2 keys (one camelCase + one kebab alias) in BUILT_IN_PROFILES order', () => {
    const registry = new ProfileRegistry();
    const keys = registry.list();
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(BUILT_IN_PROFILES.map((p) => p.name));
    expect(keys).toContain('mobileCheckout');
    expect(keys).toContain('mobile-checkout');
  });

  it('alias shares object identity with its camelCase entry', () => {
    const registry = new ProfileRegistry();
    expect(registry.get('mobile-checkout')).toBe(registry.get('mobileCheckout'));
  });

  it('built-in slice carries the composed preset list, no rule slices of its own', () => {
    const registry = new ProfileRegistry();
    const cfg = registry.get('mobileCheckout');
    expect(cfg.presets).toEqual(['mobile-3g', 'checkout-degraded']);
    expect(cfg.network).toBeUndefined();
    expect(cfg.ui).toBeUndefined();
    expect(cfg.websocket).toBeUndefined();
    expect(cfg.sse).toBeUndefined();
  });

  it('register rejects empty / whitespace-only names', () => {
    const registry = new ProfileRegistry([]);
    expect(() => registry.register({ name: '', config: {} })).toThrow(/cannot be empty/);
    expect(() => registry.register({ name: '   ', config: {} })).toThrow(/cannot be empty/);
  });

  it('register rejects duplicate names', () => {
    const registry = new ProfileRegistry([]);
    registry.register({ name: 'team-saturday-deploy', config: {} });
    expect(() => registry.register({ name: 'team-saturday-deploy', config: {} })).toThrow(/already registered/);
  });

  it('register normalizes name (trim) before duplicate check', () => {
    const registry = new ProfileRegistry([]);
    registry.register({ name: 'team-saturday-deploy', config: {} });
    expect(() => registry.register({ name: ' team-saturday-deploy ', config: {} })).toThrow(/already registered/);
  });

  it('registerAll(undefined) is a no-op', () => {
    const registry = new ProfileRegistry();
    const before = registry.list().length;
    registry.registerAll(undefined);
    expect(registry.list()).toHaveLength(before);
  });

  it('registerAll registers entries by their record key with identity preserved', () => {
    const registry = new ProfileRegistry();
    const myConfig = { presets: ['slow-api'] };
    registry.registerAll({ 'team-saturday-deploy': myConfig });
    expect(registry.has('team-saturday-deploy')).toBe(true);
    expect(registry.get('team-saturday-deploy')).toBe(myConfig);
  });

  it('register collides fail-fast against the built-in demo profile', () => {
    const registry = new ProfileRegistry();
    expect(() => registry.register({ name: 'mobileCheckout', config: {} })).toThrow(/already registered/);
    expect(() => registry.register({ name: 'mobile-checkout', config: {} })).toThrow(/already registered/);
  });

  it('get throws for unknown name and lists known names', () => {
    const registry = new ProfileRegistry();
    expect(() => registry.get('nope')).toThrow(/profile 'nope' is not registered/);
    expect(() => registry.get('nope')).toThrow(/Known: /);
  });

  it('two independently constructed registries do not share state', () => {
    const a = new ProfileRegistry();
    const b = new ProfileRegistry();
    a.registerAll({ 'team-saturday-deploy': {} });
    expect(a.has('team-saturday-deploy')).toBe(true);
    expect(b.has('team-saturday-deploy')).toBe(false);
  });

  it('built-in identity is preserved across registry constructions', () => {
    const a = new ProfileRegistry();
    const b = new ProfileRegistry();
    expect(a.get('mobile-checkout')).toBe(b.get('mobile-checkout'));
    expect(a.get('mobileCheckout')).toBe(b.get('mobileCheckout'));
  });

  it('built-in slice is deep-frozen — mutation throws in strict mode', () => {
    const registry = new ProfileRegistry();
    const slice = registry.get('mobile-checkout');
    expect(() => {
      slice.presets!.push('other-preset');
    }).toThrow(TypeError);
  });

  it('BUILT_IN_PROFILES descriptors are frozen — name swap throws', () => {
    expect(Object.isFrozen(BUILT_IN_PROFILES[0])).toBe(true);
    expect(() => {
      (BUILT_IN_PROFILES[0] as { name: string }).name = 'poisoned';
    }).toThrow(TypeError);
    expect(new ProfileRegistry().has('mobileCheckout')).toBe(true);
  });

  it('BUILT_IN_PROFILES descriptors are frozen — config swap throws', () => {
    expect(() => {
      (BUILT_IN_PROFILES[0] as { config: unknown }).config = {};
    }).toThrow(TypeError);
    expect(new ProfileRegistry().get('mobileCheckout').presets).toEqual([
      'mobile-3g',
      'checkout-degraded',
    ]);
  });

  it('camelCase + kebab alias both resolve through normalization to the same config', () => {
    const registry = new ProfileRegistry();
    expect(registry.has(' mobileCheckout ')).toBe(true);
    expect(registry.has(' mobile-checkout ')).toBe(true);
    expect(registry.get(' mobile-checkout ')).toBe(registry.get('mobileCheckout'));
  });
});
