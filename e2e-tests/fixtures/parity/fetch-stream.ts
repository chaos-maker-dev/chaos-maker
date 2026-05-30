import type { Scenario } from './types';
import { click, waitForText, expectText } from './steps';
import { hasApplied } from './assertions';

/**
 * Cross-adapter parity scenarios for fetch-stream chaos.
 *
 * Drives the `/chat` chunked-response fixture (port 8084) through the four
 * adapter interpreters. The fixture emits 5 chunks by default; each scenario
 * waits for `#chat-status` to settle on `done` before asserting on the
 * observed chunk count and the chaos event log.
 *
 * Scenarios exercise the `ai` shorthand surface (rather than the lower-level
 * `fetchStream` slice) so both the compiler and the interceptor are covered
 * end-to-end in every browser.
 */
export const fetchStreamScenarios: Scenario[] = [
  {
    id: 'fetch-stream-first-chunk-delay',
    title: 'fetch-stream firstChunkDelayMs delays the first chunk',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: { firstChunkDelayMs: 400, transport: 'fetch-stream' },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // All 5 chunks should still arrive after the delay clears.
      expectText('#chat-chunk-count', '5'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:chunk-delayed'),
        'expected an applied fetch-stream:chunk-delayed event',
      ),
  },
  {
    id: 'fetch-stream-truncate-after-chunk',
    title: 'fetch-stream truncateAfterChunk closes the response early',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: { truncateAfterChunk: 2, transport: 'fetch-stream' },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // afterChunk: 2 fires when chunk index 2 arrives; chunks 0 + 1 reach
      // the consumer, chunk 2 is dropped and the stream is terminated.
      expectText('#chat-chunk-count', '2'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:truncated'),
        'expected an applied fetch-stream:truncated event',
      ),
  },
  {
    id: 'fetch-stream-duplicate-chunk',
    title: 'fetch-stream duplicateChunkProbability re-enqueues every chunk',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: { duplicateChunkProbability: 1, transport: 'fetch-stream' },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // 5 upstream chunks * 2 = 10 observed chunks on the consumer side.
      expectText('#chat-chunk-count', '10'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:chunk-duplicated'),
        'expected an applied fetch-stream:chunk-duplicated event',
      ),
  },
];
