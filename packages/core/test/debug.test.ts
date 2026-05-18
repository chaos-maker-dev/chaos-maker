import { describe, it, expect, vi } from 'vitest';
import {
  Logger,
  normalizeDebugOption,
  formatDebugMessage,
  buildRuleIdMap,
} from '../src/debug';
import type { ChaosConfig } from '../src/config';

describe('normalizeDebugOption', () => {
  it('coerces undefined → disabled', () => {
    expect(normalizeDebugOption(undefined)).toEqual({ enabled: false });
  });

  it('coerces boolean true → enabled', () => {
    expect(normalizeDebugOption(true)).toEqual({ enabled: true });
  });

  it('coerces boolean false → disabled', () => {
    expect(normalizeDebugOption(false)).toEqual({ enabled: false });
  });

  it('passes through DebugOptions objects', () => {
    expect(normalizeDebugOption({ enabled: true })).toEqual({ enabled: true });
    expect(normalizeDebugOption({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('Logger', () => {
  it('isEnabled mirrors the option flag', () => {
    expect(new Logger({ enabled: false }).isEnabled()).toBe(false);
    expect(new Logger({ enabled: true }).isEnabled()).toBe(true);
  });

  it('log() returns a debug ChaosEvent with stage on detail and applied:false', () => {
    const logger = new Logger({ enabled: true });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const evt = logger.log('rule-applied', { url: '/api', method: 'GET', statusCode: 503 });

    expect(evt).not.toBeNull();
    expect(evt!.type).toBe('debug');
    expect(evt!.applied).toBe(false);
    expect(evt!.detail.stage).toBe('rule-applied');
    expect(evt!.detail.url).toBe('/api');
    expect(evt!.detail.statusCode).toBe(503);
    // formatted message must not be stored on the event payload.
    expect((evt!.detail as Record<string, unknown>).message).toBeUndefined();
    expect(debugSpy).toHaveBeenCalledTimes(1);

    debugSpy.mockRestore();
  });

  it('emits a single [Chaos] page-prefixed line for the page target', () => {
    const logger = new Logger({ enabled: true });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.log('rule-applied', { ruleId: 'failure#0', method: 'GET', url: '/api', statusCode: 503 });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toBe(
      '[Chaos] rule-applied: rule=failure#0 GET /api -> 503',
    );
    debugSpy.mockRestore();
  });

  it('emits a single [Chaos SW] SW-prefixed line for the sw target with no doubled [Chaos]', () => {
    const logger = new Logger({ enabled: true }, 'sw');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logger.log('lifecycle', { phase: 'sw:config-applied' });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    const line = debugSpy.mock.calls[0][0] as string;
    // Exact format: SW prefix + body, no doubled [Chaos] anywhere in the line.
    expect(line).toBe('[Chaos SW] lifecycle: sw:config-applied');
    expect(line).not.toContain('[Chaos] [');
    expect(line).not.toContain('[Chaos] [Chaos');
    debugSpy.mockRestore();
  });

  it('returns null and skips console.debug when constructed with enabled:false', () => {
    const logger = new Logger({ enabled: false });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const evt = logger.log('rule-applied', { url: '/api', method: 'GET', statusCode: 503 });
    expect(evt).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('returns null and skips console.debug for the sw target when enabled:false', () => {
    const logger = new Logger({ enabled: false }, 'sw');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const evt = logger.log('lifecycle', { phase: 'sw:config-applied' });
    expect(evt).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe('formatDebugMessage', () => {
  it('formats rule-applied body without prefix (prefix is owned by Logger)', () => {
    const line = formatDebugMessage('rule-applied', {
      ruleId: 'failure#0',
      method: 'GET',
      url: '/api',
      statusCode: 503,
    });
    expect(line).toBe('rule-applied: rule=failure#0 GET /api -> 503');
  });

  it('formats lifecycle with phase only', () => {
    expect(formatDebugMessage('lifecycle', { phase: 'engine:start' }))
      .toBe('lifecycle: engine:start');
  });

  it('formats rule-skip-group with group + base detail', () => {
    expect(formatDebugMessage('rule-skip-group', {
      ruleId: 'latency#1',
      method: 'POST',
      url: '/api/slow',
      delayMs: 1000,
      groupName: 'payments',
    })).toBe('rule-skip-group: rule=latency#1 POST /api/slow +1000ms group=payments');
  });

  it('falls back to bare stage when detail is empty', () => {
    expect(formatDebugMessage('rule-evaluating', {})).toBe('rule-evaluating');
  });
});

describe('buildRuleIdMap', () => {
  it('assigns positional IDs per ruleType', () => {
    const failureA = { urlPattern: '/api', statusCode: 500, probability: 1 };
    const failureB = { urlPattern: '/auth', statusCode: 401, probability: 1 };
    const latency = { urlPattern: '/api', delayMs: 100, probability: 1 };
    const cfg: ChaosConfig = {
      network: {
        failures: [failureA, failureB],
        latencies: [latency],
      },
    };

    const map = buildRuleIdMap(cfg);
    expect(map.get(failureA)).toEqual({ ruleType: 'failure', ruleId: 'failure#0' });
    expect(map.get(failureB)).toEqual({ ruleType: 'failure', ruleId: 'failure#1' });
    expect(map.get(latency)).toEqual({ ruleType: 'latency', ruleId: 'latency#0' });
  });

  it('covers every rule category', () => {
    const cfg: ChaosConfig = {
      network: {
        failures: [{ urlPattern: '*', statusCode: 500, probability: 0 }],
        latencies: [{ urlPattern: '*', delayMs: 1, probability: 0 }],
        aborts: [{ urlPattern: '*', probability: 0 }],
        corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 0 }],
        cors: [{ urlPattern: '*', probability: 0 }],
      },
      ui: { assaults: [{ selector: 'button', action: 'hide', probability: 0 }] },
      websocket: {
        drops: [{ urlPattern: '*', direction: 'both', probability: 0 }],
        delays: [{ urlPattern: '*', direction: 'both', delayMs: 1, probability: 0 }],
        corruptions: [{ urlPattern: '*', direction: 'both', strategy: 'truncate', probability: 0 }],
        closes: [{ urlPattern: '*', probability: 0 }],
      },
      sse: {
        drops: [{ urlPattern: '*', probability: 0 }],
        delays: [{ urlPattern: '*', delayMs: 1, probability: 0 }],
        corruptions: [{ urlPattern: '*', strategy: 'truncate', probability: 0 }],
        closes: [{ urlPattern: '*', probability: 0 }],
      },
    };
    const map = buildRuleIdMap(cfg);
    const expectedTypes = [
      'failure', 'latency', 'abort', 'corruption', 'cors',
      'ui-assault',
      'ws-drop', 'ws-delay', 'ws-corrupt', 'ws-close',
      'sse-drop', 'sse-delay', 'sse-corrupt', 'sse-close',
    ];
    const seen = new Set<string>();
    for (const type of expectedTypes) {
      // Pick the first rule from each array and confirm it landed in the map.
      const arr = type === 'failure' ? cfg.network!.failures
        : type === 'latency' ? cfg.network!.latencies
        : type === 'abort' ? cfg.network!.aborts
        : type === 'corruption' ? cfg.network!.corruptions
        : type === 'cors' ? cfg.network!.cors
        : type === 'ui-assault' ? cfg.ui!.assaults
        : type === 'ws-drop' ? cfg.websocket!.drops
        : type === 'ws-delay' ? cfg.websocket!.delays
        : type === 'ws-corrupt' ? cfg.websocket!.corruptions
        : type === 'ws-close' ? cfg.websocket!.closes
        : type === 'sse-drop' ? cfg.sse!.drops
        : type === 'sse-delay' ? cfg.sse!.delays
        : type === 'sse-corrupt' ? cfg.sse!.corruptions
        : cfg.sse!.closes;
      const entry = map.get(arr![0]);
      expect(entry?.ruleType).toBe(type);
      expect(entry?.ruleId).toBe(`${type}#0`);
      seen.add(type);
    }
    expect(seen.size).toBe(expectedTypes.length);
  });
});

describe('matcher attribution in debug events', () => {
  it('buildRuleIdMap surfaces matcherName for matcher-resolved rules', async () => {
    const { prepareChaosConfig } = await import('../src/validation');
    const resolved = prepareChaosConfig({
      network: {
        failures: [
          { matcher: 'customers', statusCode: 503, probability: 1 },
        ],
      },
      matchers: { customers: { urlPattern: '/api/customers' } },
    });
    const map = buildRuleIdMap(resolved);
    const failure = resolved.network!.failures![0] as object;
    const entry = map.get(failure);
    expect(entry?.matcherName).toBe('customers');
    expect(entry?.ruleId).toBe('failure#0');
  });

  it('formatDebugMessage renders matcher, matchedBy, and skippedAt', () => {
    expect(
      formatDebugMessage('rule-matched', {
        ruleId: 'failure#0',
        matcherName: 'customers',
        matchedBy: ['hostname', 'queryParams'],
        url: '/api/customers',
        method: 'GET',
      }),
    ).toContain('matcher=customers');
    expect(
      formatDebugMessage('rule-matched', {
        ruleId: 'failure#0',
        matchedBy: ['hostname', 'queryParams'],
      }),
    ).toContain('matched=hostname,queryParams');
    expect(
      formatDebugMessage('rule-skip-match', {
        ruleId: 'failure#0',
        skippedAt: 'queryParams',
      }),
    ).toContain('skippedAt=queryParams');
  });
});
