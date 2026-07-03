import { describe, it, expect } from 'vitest';
import { BUILT_IN_PRESETS, PresetRegistry, presets } from '../src/presets';

describe('PresetRegistry', () => {
  it('seeds 32 keys (16 camelCase + 16 kebab) in BUILT_IN_PRESETS order', () => {
    const registry = new PresetRegistry();
    const keys = registry.list();
    expect(keys).toHaveLength(32);
    expect(keys).toEqual(BUILT_IN_PRESETS.map((p) => p.name));
    expect(keys).toContain('ai-slow-first-chunk');
    expect(keys).toContain('ai-stream-truncated');
    expect(keys).toContain('ai-stream-paused');
    expect(keys).toContain('ai-tool-call-fails');
    expect(keys).toContain('ai-retry-loop');
    expect(keys).toContain('ai-reconnect-after-drop');
    expect(keys).toContain('ai-mobile-interrupt');
    expect(keys).toContain('slow-api');
    expect(keys).toContain('flaky-api');
    expect(keys).toContain('api-flaky');
    expect(keys).toContain('offline-mode');
    expect(keys).toContain('high-latency');
    expect(keys).toContain('websocket-instability');
    expect(keys).toContain('realtime-lag');
    expect(keys).toContain('mobile-3g');
    expect(keys).toContain('checkout-degraded');
  });

  it('aliases share object identity with their camelCase entry', () => {
    const registry = new PresetRegistry();
    expect(registry.get('slow-api')).toBe(registry.get('slowNetwork'));
    expect(registry.get('flaky-api')).toBe(registry.get('flakyConnection'));
    expect(registry.get('offline-mode')).toBe(registry.get('offlineMode'));
    expect(registry.get('high-latency')).toBe(registry.get('unstableApi'));
    expect(registry.get('mobile-3g')).toBe(registry.get('mobileThreeG'));
    expect(registry.get('checkout-degraded')).toBe(registry.get('checkoutDegraded'));
  });

  it('aliases for existing slices share identity with their camelCase entry', () => {
    const registry = new PresetRegistry();
    expect(registry.get('api-flaky')).toBe(registry.get('flakyConnection'));
    expect(registry.get('api-flaky')).toBe(registry.get('flaky-api'));
    expect(registry.get('websocket-instability')).toBe(registry.get('unreliableWebSocket'));
    expect(registry.get('realtime-lag')).toBe(registry.get('unreliableEventStream'));
  });

  it('legacy presets record matches registry identity for camelCase entries', () => {
    const registry = new PresetRegistry();
    expect(presets.slowNetwork).toBe(registry.get('slow-api'));
    expect(presets.unstableApi).toBe(registry.get('high-latency'));
    expect(presets.flakyConnection).toBe(registry.get('flaky-api'));
    expect(presets.offlineMode).toBe(registry.get('offline-mode'));
    expect(presets.mobileThreeG).toBe(registry.get('mobile-3g'));
    expect(presets.checkoutDegraded).toBe(registry.get('checkout-degraded'));
  });

  it('legacy presets record exposes only the 16 camelCase keys', () => {
    expect(Object.keys(presets)).toEqual([
      'unstableApi',
      'slowNetwork',
      'offlineMode',
      'flakyConnection',
      'degradedUi',
      'unreliableWebSocket',
      'unreliableEventStream',
      'mobileThreeG',
      'checkoutDegraded',
      'aiSlowFirstChunk',
      'aiStreamTruncated',
      'aiStreamPaused',
      'aiToolCallFails',
      'aiRetryLoop',
      'aiReconnectAfterDrop',
      'aiMobileInterrupt',
    ]);
    expect((presets as Record<string, unknown>)['slow-api']).toBeUndefined();
    expect((presets as Record<string, unknown>)['flaky-api']).toBeUndefined();
    expect((presets as Record<string, unknown>)['offline-mode']).toBeUndefined();
    expect((presets as Record<string, unknown>)['high-latency']).toBeUndefined();
    expect((presets as Record<string, unknown>)['mobile-3g']).toBeUndefined();
    expect((presets as Record<string, unknown>)['checkout-degraded']).toBeUndefined();
  });

  it('register rejects empty / whitespace-only names', () => {
    const registry = new PresetRegistry([]);
    expect(() => registry.register({ name: '', config: {} })).toThrow(/cannot be empty/);
    expect(() => registry.register({ name: '   ', config: {} })).toThrow(/cannot be empty/);
  });

  it('register rejects duplicate names', () => {
    const registry = new PresetRegistry([]);
    registry.register({ name: 'team-flow', config: {} });
    expect(() => registry.register({ name: 'team-flow', config: {} })).toThrow(/already registered/);
  });

  it('register normalizes name (trim) before duplicate check', () => {
    const registry = new PresetRegistry([]);
    registry.register({ name: 'team-flow', config: {} });
    expect(() => registry.register({ name: ' team-flow ', config: {} })).toThrow(/already registered/);
  });

  it('registerAll(undefined) is a no-op', () => {
    const registry = new PresetRegistry();
    const before = registry.list().length;
    registry.registerAll(undefined);
    expect(registry.list()).toHaveLength(before);
  });

  it('registerAll registers entries by their record key with identity preserved', () => {
    const registry = new PresetRegistry();
    const myConfig = { network: { latencies: [{ urlPattern: '/x', delayMs: 50, probability: 1 }] } };
    registry.registerAll({ 'team-flow': myConfig });
    expect(registry.has('team-flow')).toBe(true);
    expect(registry.get('team-flow')).toBe(myConfig);
  });

  it('register collides fail-fast against built-ins', () => {
    const registry = new PresetRegistry();
    expect(() => registry.register({ name: 'slowNetwork', config: {} })).toThrow(/already registered/);
    expect(() => registry.register({ name: 'slow-api', config: {} })).toThrow(/already registered/);
  });

  it('get throws for unknown name and lists known names', () => {
    const registry = new PresetRegistry();
    expect(() => registry.get('nope')).toThrow(/preset 'nope' is not registered/);
    expect(() => registry.get('nope')).toThrow(/Known: /);
  });

  it('two independently constructed registries do not share state', () => {
    const a = new PresetRegistry();
    const b = new PresetRegistry();
    a.registerAll({ 'team-flow': {} });
    expect(a.has('team-flow')).toBe(true);
    expect(b.has('team-flow')).toBe(false);
  });

  it('built-in identity is preserved across registry constructions', () => {
    const a = new PresetRegistry();
    const b = new PresetRegistry();
    expect(a.get('slow-api')).toBe(b.get('slow-api'));
    expect(a.get('slowNetwork')).toBe(b.get('slowNetwork'));
  });

  it('built-in slices are deep-frozen  -  mutation throws in strict mode', () => {
    const registry = new PresetRegistry();
    const slow = registry.get('slow-api') as { network?: { latencies?: { delayMs: number }[] } };
    expect(() => {
      slow.network!.latencies![0].delayMs = 1;
    }).toThrow(TypeError);
  });

  it('built-in slices via legacy presets record are deep-frozen too', () => {
    const slow = presets.slowNetwork as { network?: { latencies?: { delayMs: number }[] } };
    expect(() => {
      slow.network!.latencies![0].delayMs = 1;
    }).toThrow(TypeError);
  });

  it('BUILT_IN_PRESETS descriptors are frozen  -  name swap throws', () => {
    expect(Object.isFrozen(BUILT_IN_PRESETS[0])).toBe(true);
    expect(() => {
      (BUILT_IN_PRESETS[0] as { name: string }).name = 'poisoned';
    }).toThrow(TypeError);
    // Sanity: a fresh registry still resolves the original name.
    expect(new PresetRegistry().has('unstableApi')).toBe(true);
  });

  it('BUILT_IN_PRESETS descriptors are frozen  -  config swap throws', () => {
    expect(() => {
      (BUILT_IN_PRESETS[0] as { config: unknown }).config = {};
    }).toThrow(TypeError);
    // Identity guarantee survives the attempted poisoning.
    expect(new PresetRegistry().get('unstableApi')).toBe(presets.unstableApi);
  });
});
