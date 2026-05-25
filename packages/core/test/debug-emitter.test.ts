import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChaosEventEmitter } from '../src/events';
import { Logger } from '../src/debug';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChaosEventEmitter.debug  -  fast-path no-op', () => {
  it('does nothing when no logger is attached', () => {
    const emitter = new ChaosEventEmitter();
    const emitSpy = vi.spyOn(emitter, 'emit');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    emitter.debug('rule-evaluating', { url: '/api', method: 'GET' });
    emitter.debug('rule-applied', { url: '/api', method: 'GET' });

    expect(emitSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(emitter.getLog()).toHaveLength(0);
  });
});

describe('ChaosEventEmitter.debug  -  with logger attached', () => {
  it('fires console.debug AND emits a debug event with stage on detail', () => {
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    emitter.debug('rule-applied', { url: '/api', method: 'GET', statusCode: 503 });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toMatch(/^\[Chaos\] rule-applied:/);

    const log = emitter.getLog();
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('debug');
    expect(log[0].applied).toBe(false);
    expect(log[0].detail.stage).toBe('rule-applied');
    expect(log[0].detail.url).toBe('/api');
  });

  it("delivers debug events to the '*' wildcard listener", () => {
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const wildcard = vi.fn();
    emitter.on('*', wildcard);

    emitter.debug('lifecycle', { phase: 'engine:start' });

    expect(wildcard).toHaveBeenCalledTimes(1);
    expect(wildcard.mock.calls[0][0].type).toBe('debug');
    expect(wildcard.mock.calls[0][0].detail.phase).toBe('engine:start');
  });

  it("delivers debug events to instance.on('debug', cb) listener", () => {
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const debugListener = vi.fn();
    emitter.on('debug', debugListener);

    emitter.debug('rule-evaluating', { url: '/x' });
    emitter.emit({
      type: 'network:failure',
      timestamp: Date.now(),
      applied: true,
      detail: { url: '/x', statusCode: 500 },
    });

    expect(debugListener).toHaveBeenCalledTimes(1);
    expect(debugListener.mock.calls[0][0].detail.stage).toBe('rule-evaluating');
  });

  it('does NOT emit when an externally constructed disabled Logger is wired in', () => {
    const emitter = new ChaosEventEmitter();
    // Public Logger is exported; an external consumer could wire one in with
    // enabled:false. The emitter must respect the Logger.enabled contract and
    // skip both console.debug and event emission.
    emitter.setLogger(new Logger({ enabled: false }));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    emitter.debug('rule-applied', { url: '/api', method: 'GET' });
    emitter.debug('lifecycle', { phase: 'engine:start' });

    expect(debugSpy).not.toHaveBeenCalled();
    expect(emitter.getLog()).toHaveLength(0);
  });

  it('resolves ruleType + ruleId via setRuleIds map', () => {
    const emitter = new ChaosEventEmitter();
    emitter.setLogger(new Logger({ enabled: true }));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const rule = { urlPattern: '/api', statusCode: 503, probability: 1 };
    const map = new WeakMap<object, { ruleType: string; ruleId: string }>();
    map.set(rule, { ruleType: 'failure', ruleId: 'failure#0' });
    emitter.setRuleIds(map);

    emitter.debug('rule-applied', { url: '/api', method: 'GET' }, rule);

    const log = emitter.getLog();
    expect(log[0].detail.ruleType).toBe('failure');
    expect(log[0].detail.ruleId).toBe('failure#0');
  });
});
