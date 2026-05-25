import { describe, it, expect, vi } from 'vitest';
import { serializeForTransport, deserializeForTransport } from '../src/transport';

describe('serializeForTransport', () => {
  it('passes through primitives unchanged', () => {
    expect(serializeForTransport(42)).toBe(42);
    expect(serializeForTransport('hi')).toBe('hi');
    expect(serializeForTransport(null)).toBe(null);
    expect(serializeForTransport(true)).toBe(true);
  });

  it('replaces a top-level RegExp with a JSON-safe marker', () => {
    const out = serializeForTransport(/^Get/i) as Record<string, unknown>;
    expect(out).toEqual({ __chaosMakerRegExp: { source: '^Get', flags: 'i' } });
    // Must round-trip through JSON without loss.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('walks nested arrays and objects', () => {
    const input = {
      network: {
        failures: [
          { urlPattern: '/graphql', graphqlOperation: /^Get/, statusCode: 500 },
          { urlPattern: '/graphql', graphqlOperation: 'CreatePost', statusCode: 401 },
        ],
      },
    };
    const out = serializeForTransport(input);
    const json = JSON.parse(JSON.stringify(out));
    expect(json.network.failures[0].graphqlOperation).toEqual({ __chaosMakerRegExp: { source: '^Get', flags: '' } });
    expect(json.network.failures[1].graphqlOperation).toBe('CreatePost');
  });
});

describe('deserializeForTransport', () => {
  it('reconstructs RegExp from a marker', () => {
    const out = deserializeForTransport({ __chaosMakerRegExp: { source: '^Get', flags: 'i' } });
    expect(out).toBeInstanceOf(RegExp);
    expect((out as RegExp).source).toBe('^Get');
    expect((out as RegExp).flags).toBe('i');
  });

  it('is idempotent on already-real RegExp instances', () => {
    const re = /^Get/;
    expect(deserializeForTransport(re)).toBe(re);
  });

  it('passes through primitives + non-marker objects unchanged', () => {
    expect(deserializeForTransport({ a: 1, b: 'two' })).toEqual({ a: 1, b: 'two' });
    expect(deserializeForTransport([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('does not coerce an object that has __chaosMakerRegExp alongside sibling keys', () => {
    // Outer object isn't an exclusive marker  -  siblings would be silently dropped
    // if isRegExpMarker treated it as one. Preserve the whole shape instead.
    const input = { __chaosMakerRegExp: { source: '^x', flags: '' }, sibling: 42 };
    const out = deserializeForTransport(input) as Record<string, unknown>;
    expect(out.sibling).toBe(42);
    expect(out.__chaosMakerRegExp).toEqual({ source: '^x', flags: '' });
    expect(out).not.toBeInstanceOf(RegExp);
  });

  it('returns the marker unchanged and warns when RegExp construction throws', () => {
    // Malformed pattern (unterminated group). Must not crash bootstrap  -  pass
    // the original marker through and emit a warning so downstream validation
    // can reject with a clearer message.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = { __chaosMakerRegExp: { source: '(', flags: '' } };
    const out = deserializeForTransport(input);
    expect(out).toBe(input);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/invalid RegExp/);
    warn.mockRestore();
  });

  it('returns the marker unchanged when flags are invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = { __chaosMakerRegExp: { source: '^x', flags: 'zzz' } };
    const out = deserializeForTransport(input);
    expect(out).toBe(input);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not coerce when the inner marker has unexpected keys', () => {
    // Inner shape must be exactly { source, flags }. Extra keys mean it's not
    // ours  -  leave it alone.
    const input = { __chaosMakerRegExp: { source: '^x', flags: '', evil: true } };
    const out = deserializeForTransport(input);
    expect(out).not.toBeInstanceOf(RegExp);
    expect(out).toEqual(input);
  });

  it('round-trips a full ChaosConfig with mixed matchers', () => {
    const input = {
      network: {
        failures: [{ urlPattern: '/graphql', graphqlOperation: /^Get/i, statusCode: 503, probability: 1 }],
        latencies: [{ urlPattern: '/graphql', graphqlOperation: 'SearchProducts', delayMs: 100, probability: 1 }],
      },
    };
    const restored = deserializeForTransport(JSON.parse(JSON.stringify(serializeForTransport(input)))) as typeof input;
    expect(restored.network.failures[0].graphqlOperation).toBeInstanceOf(RegExp);
    expect((restored.network.failures[0].graphqlOperation as RegExp).source).toBe('^Get');
    expect((restored.network.failures[0].graphqlOperation as RegExp).flags).toBe('i');
    expect(restored.network.latencies[0].graphqlOperation).toBe('SearchProducts');
  });
});
