import { describe, it, expect } from 'vitest';
import { ChaosConfigBuilder } from '../src/builder';
import { presets, PresetRegistry } from '../src/presets';
import { validateConfig } from '../src/validation';

describe('ChaosConfigBuilder', () => {
  it('should build an empty config by default', () => {
    const builder = new ChaosConfigBuilder();
    const config = builder.build();
    expect(config.network).toEqual({});
    expect(config.ui).toEqual({});
  });

  it('should add failure requests', () => {
    const builder = new ChaosConfigBuilder();
    builder.failRequests('/api/', 500, 0.5, ['GET']);
    const config = builder.build();
    expect(config.network?.failures).toHaveLength(1);
    expect(config.network?.failures?.[0]).toEqual({
      urlPattern: '/api/',
      statusCode: 500,
      probability: 0.5,
      methods: ['GET'],
      body: undefined,
      headers: undefined
    });
  });

  it('should add latency', () => {
    const builder = new ChaosConfigBuilder();
    builder.addLatency('/api/', 1000, 1.0);
    const config = builder.build();
    expect(config.network?.latencies).toHaveLength(1);
    expect(config.network?.latencies?.[0].delayMs).toBe(1000);
  });

  it('should add abort requests', () => {
    const builder = new ChaosConfigBuilder();
    builder.abortRequests('/api/', 1.0, 100);
    const config = builder.build();
    expect(config.network?.aborts).toHaveLength(1);
    expect(config.network?.aborts?.[0].timeout).toBe(100);
  });

  it('should add corruptions', () => {
    const builder = new ChaosConfigBuilder();
    builder.corruptResponses('/api/', 'truncate', 1.0);
    const config = builder.build();
    expect(config.network?.corruptions).toHaveLength(1);
    expect(config.network?.corruptions?.[0].strategy).toBe('truncate');
  });

  it('should add cors simulation', () => {
    const builder = new ChaosConfigBuilder();
    builder.simulateCors('/api/', 1.0);
    const config = builder.build();
    expect(config.network?.cors).toHaveLength(1);
    expect(config.network?.cors?.[0].probability).toBe(1.0);
  });

  it('should add UI assaults', () => {
    const builder = new ChaosConfigBuilder();
    builder.assaultUi('button', 'disable', 1.0);
    const config = builder.build();
    expect(config.ui?.assaults).toHaveLength(1);
    expect(config.ui?.assaults?.[0].action).toBe('disable');
  });

  it('should chain all methods', () => {
    const config = new ChaosConfigBuilder()
      .failRequests('/api/1', 500, 1.0)
      .addLatency('/api/2', 500, 1.0)
      .abortRequests('/api/3', 1.0, 50)
      .corruptResponses('/api/4', 'truncate', 1.0)
      .simulateCors('/api/5', 1.0)
      .assaultUi('button', 'disable', 1.0)
      .build();

    expect(config.network?.failures).toHaveLength(1);
    expect(config.network?.latencies).toHaveLength(1);
    expect(config.network?.aborts).toHaveLength(1);
    expect(config.network?.corruptions).toHaveLength(1);
    expect(config.network?.cors).toHaveLength(1);
    expect(config.ui?.assaults).toHaveLength(1);
  });

  it('should set seed via withSeed()', () => {
    const config = new ChaosConfigBuilder()
      .failRequests('/api/', 500, 1.0)
      .withSeed(42)
      .build();

    expect(config.seed).toBe(42);
  });

  it('should include seed in chained builds', () => {
    const config = new ChaosConfigBuilder()
      .withSeed(12345)
      .addLatency('/api/', 1000, 1.0)
      .build();

    expect(config.seed).toBe(12345);
    expect(config.network?.latencies).toHaveLength(1);
  });

  it('should return a snapshot from build() that is unaffected by later mutations', () => {
    const builder = new ChaosConfigBuilder()
      .failRequests('/api/1', 500, 1.0);

    const firstConfig = builder.build();

    builder.addLatency('/api/2', 1000, 1.0);
    builder.abortRequests('/api/3', 1.0);
    builder.corruptResponses('/api/4', 'empty', 1.0);

    expect(firstConfig.network?.failures).toHaveLength(1);
    expect(firstConfig.network?.latencies).toBeUndefined();
    expect(firstConfig.network?.aborts).toBeUndefined();
    expect(firstConfig.network?.corruptions).toBeUndefined();
  });

  it('should add websocket drop rules', () => {
    const config = new ChaosConfigBuilder()
      .dropMessages('/ws', 'inbound', 0.5)
      .build();
    expect(config.websocket?.drops).toEqual([
      { urlPattern: '/ws', direction: 'inbound', probability: 0.5 },
    ]);
  });

  it('should add websocket delay rules with counting', () => {
    const config = new ChaosConfigBuilder()
      .delayMessages('/ws', 'outbound', 100, 1.0, { everyNth: 3 })
      .build();
    expect(config.websocket?.delays?.[0]).toMatchObject({
      urlPattern: '/ws', direction: 'outbound', delayMs: 100, probability: 1, everyNth: 3,
    });
  });

  it('should add websocket corrupt rules', () => {
    const config = new ChaosConfigBuilder()
      .corruptMessages('/ws', 'both', 'truncate', 0.2)
      .build();
    expect(config.websocket?.corruptions?.[0].strategy).toBe('truncate');
  });

  it('should add websocket close rules with code and reason', () => {
    const config = new ChaosConfigBuilder()
      .closeConnection('/ws', 1.0, { code: 4001, reason: 'kick', afterMs: 1000 })
      .build();
    expect(config.websocket?.closes?.[0]).toMatchObject({
      urlPattern: '/ws', probability: 1, code: 4001, reason: 'kick', afterMs: 1000,
    });
  });

  it('dropMessagesOnNth and delayMessagesOnNth set onNth', () => {
    const config = new ChaosConfigBuilder()
      .dropMessagesOnNth('/ws', 'outbound', 3)
      .delayMessagesOnNth('/ws', 'inbound', 200, 2)
      .build();
    expect(config.websocket?.drops?.[0]).toMatchObject({ onNth: 3, probability: 1 });
    expect(config.websocket?.delays?.[0]).toMatchObject({ onNth: 2, probability: 1 });
  });

  it('failGraphQLOperation pushes a failure rule with graphqlOperation set', () => {
    const config = new ChaosConfigBuilder()
      .failGraphQLOperation('GetUser', 503, 0.5)
      .build();
    expect(config.network?.failures?.[0]).toMatchObject({
      urlPattern: '*',
      statusCode: 503,
      probability: 0.5,
      graphqlOperation: 'GetUser',
    });
  });

  it('failGraphQLOperation accepts an explicit urlPattern', () => {
    const config = new ChaosConfigBuilder()
      .failGraphQLOperation('GetUser', 500, 1.0, '/graphql')
      .build();
    expect(config.network?.failures?.[0]).toMatchObject({
      urlPattern: '/graphql',
      graphqlOperation: 'GetUser',
    });
  });

  it('delayGraphQLOperation pushes a latency rule with graphqlOperation set', () => {
    const config = new ChaosConfigBuilder()
      .delayGraphQLOperation('SearchProducts', 2000, 1.0)
      .build();
    expect(config.network?.latencies?.[0]).toMatchObject({
      urlPattern: '*',
      delayMs: 2000,
      probability: 1.0,
      graphqlOperation: 'SearchProducts',
    });
  });

  it('preserves a RegExp graphqlOperation through build()', () => {
    const re = /^Get/;
    const config = new ChaosConfigBuilder()
      .failGraphQLOperation(re, 500, 1.0, '/graphql')
      .build();
    const matcher = config.network?.failures?.[0].graphqlOperation;
    expect(matcher).toBeInstanceOf(RegExp);
    // Cloned RegExp must have the same pattern + flags as the source.
    expect((matcher as RegExp).source).toBe(re.source);
    expect((matcher as RegExp).flags).toBe(re.flags);
    // And must be a fresh instance  -  mutating original flags shouldn't leak.
    expect(matcher).not.toBe(re);
  });

  it('clones nested RegExp matchers across rule arrays independently per build()', () => {
    const builder = new ChaosConfigBuilder()
      .failGraphQLOperation(/^Get/i, 500, 1.0)
      .delayGraphQLOperation(/Search/, 1000, 1.0);
    const first = builder.build();
    const second = builder.build();
    expect(first.network?.failures?.[0].graphqlOperation).not.toBe(second.network?.failures?.[0].graphqlOperation);
    expect((first.network?.failures?.[0].graphqlOperation as RegExp).flags).toBe('i');
  });
});

describe('Presets', () => {
  it('should have predefined presets', () => {
    expect(presets.unstableApi).toBeDefined();
    expect(presets.slowNetwork).toBeDefined();
    expect(presets.offlineMode).toBeDefined();
    expect(presets.flakyConnection).toBeDefined();
    expect(presets.degradedUi).toBeDefined();
    expect(presets.unreliableWebSocket).toBeDefined();
  });

  it('unreliableWebSocket has drop/delay/corrupt rules', () => {
    const cfg = presets.unreliableWebSocket;
    expect(cfg.websocket?.drops?.length).toBeGreaterThan(0);
    expect(cfg.websocket?.delays?.length).toBeGreaterThan(0);
    expect(cfg.websocket?.corruptions?.length).toBeGreaterThan(0);
  });

  it('unstableApi should have failures and latencies', () => {
    const config = presets.unstableApi;
    expect(config.network?.failures).toBeDefined();
    expect(config.network?.latencies).toBeDefined();
  });

  it('all presets should pass config validation', () => {
    for (const config of Object.values(presets)) {
      expect(() => validateConfig(config)).not.toThrow();
    }
  });

  it('legacy presets record exposes only camelCase keys', () => {
    expect((presets as Record<string, unknown>)['slow-api']).toBeUndefined();
    expect((presets as Record<string, unknown>)['flaky-api']).toBeUndefined();
    expect((presets as Record<string, unknown>)['offline-mode']).toBeUndefined();
    expect((presets as Record<string, unknown>)['high-latency']).toBeUndefined();
  });

  it('legacy presets entries share identity with their kebab alias on the registry', () => {
    const registry = new PresetRegistry();
    expect(presets.slowNetwork).toBe(registry.get('slow-api'));
    expect(presets.flakyConnection).toBe(registry.get('flaky-api'));
    expect(presets.offlineMode).toBe(registry.get('offline-mode'));
    expect(presets.unstableApi).toBe(registry.get('high-latency'));
  });
});

describe('ChaosConfigBuilder.usePreset', () => {
  it('queues a single preset and emits it on build()', () => {
    const config = new ChaosConfigBuilder().usePreset('slow-api').build();
    expect(config.presets).toEqual(['slow-api']);
  });

  it('dedupes repeated names while preserving order', () => {
    const config = new ChaosConfigBuilder()
      .usePreset('slow-api')
      .usePreset('flaky-api')
      .usePreset('slow-api')
      .build();
    expect(config.presets).toEqual(['slow-api', 'flaky-api']);
  });

  it('omits the presets field when no preset was queued', () => {
    const config = new ChaosConfigBuilder().failRequests('/api', 500, 1).build();
    expect(config.presets).toBeUndefined();
  });

  it('rejects empty / whitespace-only preset names', () => {
    const builder = new ChaosConfigBuilder();
    expect(() => builder.usePreset('')).toThrow(/preset name cannot be empty/);
    expect(() => builder.usePreset('   ')).toThrow(/preset name cannot be empty/);
  });

  it('trims surrounding whitespace before queueing', () => {
    const config = new ChaosConfigBuilder().usePreset(' slow-api ').build();
    expect(config.presets).toEqual(['slow-api']);
  });

  it('merges presets from the initial config with usePreset() additions, deduping', () => {
    const config = new ChaosConfigBuilder({ presets: ['flaky-api', 'slow-api'] })
      .usePreset('slow-api')
      .usePreset('offline-mode')
      .build();
    expect(config.presets).toEqual(['flaky-api', 'slow-api', 'offline-mode']);
  });

  it('preserves initial-config presets when usePreset() is never called', () => {
    const config = new ChaosConfigBuilder({ presets: ['flaky-api'] }).build();
    expect(config.presets).toEqual(['flaky-api']);
  });

  it('queues mobile-3g and checkout-degraded together and round-trips through validation', () => {
    const config = new ChaosConfigBuilder()
      .usePreset('mobile-3g')
      .usePreset('checkout-degraded')
      .withSeed(1234)
      .build();
    expect(config.presets).toEqual(['mobile-3g', 'checkout-degraded']);
    expect(config.seed).toBe(1234);
    expect(() => validateConfig(config)).not.toThrow();
  });
});
