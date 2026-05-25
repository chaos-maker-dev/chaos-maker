import type { ChaosEvent } from '../events';
import type { TransportKind } from './types';

/** Classify an event by its `type` prefix. Returns `null` for `'debug'` events
 *  and for any unrecognized prefix  -  both are excluded from transport-scoped
 *  aggregates and filters. */
export function classifyTransport(event: ChaosEvent): TransportKind | null {
  const type = event.type;
  if (type === 'debug') return null;
  if (type.startsWith('network:')) return 'network';
  if (type.startsWith('websocket:')) return 'websocket';
  if (type.startsWith('sse:')) return 'sse';
  if (type.startsWith('ui:')) return 'ui';
  if (type.startsWith('rule-group:')) return 'rule-group';
  return null;
}

/** Filter an event log down to a single transport bucket. Returns a new array;
 *  the input is not mutated. Order is preserved. */
export function filterEventsByTransport(
  events: ChaosEvent[],
  transport: TransportKind,
): ChaosEvent[] {
  return events.filter((event) => classifyTransport(event) === transport);
}
