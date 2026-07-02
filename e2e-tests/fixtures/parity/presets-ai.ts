import type { Scenario } from './types';
import { click, waitForText, waitForCount, expectText } from './steps';
import { appliedCount, hasApplied } from './assertions';

/**
 * Cross-adapter parity scenarios for the AI streaming presets.
 *
 * Each scenario injects a preset by NAME (kebab alias), so the full pipeline
 * is exercised in-page: registry lookup, slice expansion, and, for derived
 * presets, the same compiled rules the `ai` shorthand produces. Assertions
 * count newline-delimited messages, never raw stream chunks (Firefox and
 * WebKit coalesce buffered writes; message counts are framing-invariant).
 */
export const aiPresetScenarios: Scenario[] = [
  {
    id: 'preset-ai-slow-first-chunk',
    title: 'aiSlowFirstChunk preset delays the first chat chunk',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      presets: ['ai-slow-first-chunk'],
    },
    steps: [
      click('#chat-start'),
      // The preset holds the first chunk for 3000ms; waitForCount rides the
      // 10s budget every adapter runner gives it, then all 5 messages arrive.
      waitForCount('#chat-message-count', 5),
      expectText('#chat-message-count', '5'),
    ],
    check: (ctx, assert) =>
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:chunk-delayed'),
        'expected the preset to delay the first chunk',
      ),
  },
  {
    id: 'preset-ai-tool-call-fails',
    title: 'aiToolCallFails preset corrupts only the tool-call chunk',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      presets: ['ai-tool-call-fails'],
    },
    steps: [
      click('#chat-start-toolcall'),
      waitForText('#chat-status', 'done'),
      // The malformed-json tail rides behind the tool-call line's newline, so
      // all 5 newline-terminated messages still arrive; only the structured
      // payload is broken.
      expectText('#chat-message-count', '5'),
    ],
    check: (ctx, assert) => {
      const toolCallCorruptions = ctx.log.filter(
        (e) =>
          e.type === 'fetch-stream:chunk-corrupted' &&
          e.applied &&
          e.detail.phase === 'ai:tool-call-failed' &&
          e.detail.strategy === 'malformed-json',
      );
      assert.equal(
        toolCallCorruptions.length,
        1,
        'expected exactly one tool-call chunk corruption tagged ai:tool-call-failed',
      );
      assert.equal(
        toolCallCorruptions[0]!.detail.chunkIndex,
        2,
        'expected the corruption to hit the tool-call chunk (index 2)',
      );
    },
  },
  {
    id: 'preset-ai-retry-loop',
    title: 'aiRetryLoop preset returns 429 twice then lets the stream through',
    transport: 'network',
    config: {
      seed: 42,
      presets: ['ai-retry-loop'],
    },
    steps: [
      click('#chat-start-retry'),
      waitForText('#chat-status', 'done'),
      expectText('#chat-attempts', '3'),
      expectText('#chat-message-count', '5'),
    ],
    check: (ctx, assert) =>
      assert.equal(
        appliedCount(ctx.log, 'network:failure'),
        2,
        'expected the first two attempts to fail with the preset 429s',
      ),
  },
];
