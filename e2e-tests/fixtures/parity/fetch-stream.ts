import type { Scenario } from './types';
import { click, waitForText, expectText } from './steps';
import { hasApplied } from './assertions';

/**
 * Cross-adapter parity scenarios for fetch-stream chaos.
 *
 * Drives the `/chat` chunked-response fixture (port 8084) through the four
 * adapter interpreters. The fixture emits 5 newline-terminated messages by
 * default; each scenario waits for `#chat-status` to settle on `done` before
 * asserting on `#chat-message-count` and the chaos event log.
 *
 * Assertions count complete messages (newline-delimited lines in the
 * accumulated text), never raw ReadableStream chunks: when a chaos delay
 * stalls the consumer, Firefox and WebKit coalesce the buffered network
 * writes into a single stream chunk while Chromium keeps them separate, so
 * chunk counts are browser-dependent but message counts are not.
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
      // All 5 messages still arrive after the delay clears.
      expectText('#chat-message-count', '5'),
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
      // afterChunk: 2 fires when chunk index 2 arrives; messages 0 + 1 reach
      // the consumer, the rest are cut off with the stream.
      expectText('#chat-message-count', '2'),
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
      // Every chunk is enqueued twice, so every message line appears twice:
      // 5 upstream messages * 2 = 10. Holds even if a browser coalesces
      // writes, because whatever text a chunk carries is duplicated whole.
      expectText('#chat-message-count', '10'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:chunk-duplicated'),
        'expected an applied fetch-stream:chunk-duplicated event',
      ),
  },
];
