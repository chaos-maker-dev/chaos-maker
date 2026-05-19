import { describe, expect, it } from 'vitest';
import type { ChaosEvent } from '../src/events';
import {
  classifyTransport,
  filterEventsByTransport,
} from '../src/reporting/transport';

function evt(type: ChaosEvent['type'], applied = false): ChaosEvent {
  return { type, timestamp: 0, applied, detail: {} };
}

describe('classifyTransport', () => {
  it('maps every network:* subtype to "network"', () => {
    expect(classifyTransport(evt('network:failure'))).toBe('network');
    expect(classifyTransport(evt('network:latency'))).toBe('network');
    expect(classifyTransport(evt('network:abort'))).toBe('network');
    expect(classifyTransport(evt('network:corruption'))).toBe('network');
    expect(classifyTransport(evt('network:cors'))).toBe('network');
  });

  it('maps websocket:*, sse:*, ui:*, rule-group:* to their own buckets', () => {
    expect(classifyTransport(evt('websocket:drop'))).toBe('websocket');
    expect(classifyTransport(evt('websocket:delay'))).toBe('websocket');
    expect(classifyTransport(evt('sse:drop'))).toBe('sse');
    expect(classifyTransport(evt('sse:close'))).toBe('sse');
    expect(classifyTransport(evt('ui:assault'))).toBe('ui');
    expect(classifyTransport(evt('rule-group:enabled'))).toBe('rule-group');
    expect(classifyTransport(evt('rule-group:gated'))).toBe('rule-group');
  });

  it('returns null for debug events', () => {
    expect(classifyTransport(evt('debug'))).toBeNull();
  });
});

describe('filterEventsByTransport', () => {
  const events: ChaosEvent[] = [
    evt('network:failure', true),
    evt('debug'),
    evt('websocket:drop', true),
    evt('network:latency'),
    evt('sse:delay', true),
    evt('rule-group:enabled', true),
  ];

  it('returns only events for the requested transport in input order', () => {
    expect(filterEventsByTransport(events, 'network').map((e) => e.type)).toEqual([
      'network:failure',
      'network:latency',
    ]);
    expect(filterEventsByTransport(events, 'websocket').map((e) => e.type)).toEqual([
      'websocket:drop',
    ]);
    expect(filterEventsByTransport(events, 'sse').map((e) => e.type)).toEqual([
      'sse:delay',
    ]);
    expect(filterEventsByTransport(events, 'rule-group').map((e) => e.type)).toEqual([
      'rule-group:enabled',
    ]);
  });

  it('returns an empty array when no events match', () => {
    expect(filterEventsByTransport(events, 'ui')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const before = events.slice();
    filterEventsByTransport(events, 'network');
    expect(events).toEqual(before);
  });
});
