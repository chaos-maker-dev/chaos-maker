import type { Scenario } from './types';
import type { ReplayFixture } from '@chaos-maker/core';
import { click, waitForText, expectText } from './steps';

/**
 * Cross-adapter parity scenarios for stream replay.
 *
 * Each scenario drives the `/chat` fixture button, but the `ai.replay`
 * directive substitutes the live response with an inline fixture (block mode,
 * the default), so the message the consumer sees comes entirely from the
 * fixture rather than the chat server. Message counts are newline-delimited
 * (same framing-invariant counting the fetch-stream scenarios use) so the
 * assertions hold across Chromium, Firefox, and WebKit.
 *
 * The fixtures are inlined as `ai.replay.data`; adapter path resolution
 * (`loadStreamFixture`) is exercised separately in adapter unit tests.
 */

function fixture(lines: number): ReplayFixture {
  return {
    version: 1,
    transport: 'fetch-stream',
    url: 'http://127.0.0.1:8084/chat',
    chunks: Array.from({ length: lines }, (_unused, i) => ({ offsetMs: 0, data: `replay-${i}\n` })),
  };
}

const phasePresent = (phase: string) => (log: { detail: { phase?: string } }[]): boolean =>
  log.some((e) => e.detail.phase === phase);

export const replayScenarios: Scenario[] = [
  {
    id: 'replay-block-serves-fixture',
    title: 'replay block mode serves the fixture instead of the network',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: { transport: 'fetch-stream', replay: { urlPattern: '/chat', data: fixture(3) } },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // Three fixture chunks, each newline-terminated, reach the consumer.
      expectText('#chat-message-count', '3'),
    ],
    check: (ctx, assert) =>
      assert.ok(phasePresent('ai:stream-replayed')(ctx.log), 'expected an ai:stream-replayed lifecycle event'),
  },
  {
    id: 'replay-truncate-mutation',
    title: 'replay truncate mutation cuts the fixture short',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: {
        transport: 'fetch-stream',
        replay: { urlPattern: '/chat', data: fixture(3), mutations: [{ type: 'truncate', afterChunk: 0 }] },
      },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // afterChunk: 0 keeps only the first chunk.
      expectText('#chat-message-count', '1'),
    ],
    check: (ctx, assert) =>
      assert.ok(phasePresent('ai:stream-truncated')(ctx.log), 'expected an ai:stream-truncated event'),
  },
  {
    id: 'replay-duplicate-mutation',
    title: 'replay duplicate mutation re-emits a fixture chunk',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: {
        transport: 'fetch-stream',
        replay: { urlPattern: '/chat', data: fixture(2), mutations: [{ type: 'duplicate', chunkIndex: 0 }] },
      },
    },
    steps: [
      click('#chat-start'),
      waitForText('#chat-status', 'done'),
      // chunk 0 emitted twice + chunk 1 => 3 newline-terminated messages.
      expectText('#chat-message-count', '3'),
    ],
    check: (ctx, assert) =>
      assert.ok(phasePresent('ai:chunk-duplicated')(ctx.log), 'expected an ai:chunk-duplicated event'),
  },
];
