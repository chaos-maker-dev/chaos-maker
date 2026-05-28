import type { Scenario } from './types';

/**
 * Cross-adapter parity scenarios for fetch-stream chaos.
 *
 * Empty placeholder for the v0.9.0 release: the fetch-stream interceptor is
 * covered exhaustively by `packages/core/test/networkFetchStream.test.ts` and
 * `packages/core/test/streaming-phase.test.ts` at the unit level. Adding
 * scenarios here requires a chunked-response server fixture and a chat-app
 * page that reads `fetch(...).body.getReader()`; those are tracked as a
 * follow-up so the streaming primitives release is not blocked.
 *
 * When the chat-app fixture lands, populate this array following the SSE /
 * WebSocket scenario shapes; the four adapter interpreters already accept
 * `'fetch-stream'` as a valid `Scenario.transport` value.
 */
export const fetchStreamScenarios: Scenario[] = [];
