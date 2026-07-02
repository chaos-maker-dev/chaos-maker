import type { Scenario } from './types';
import { click, waitForText, waitForCount, expectText } from './steps';
import { appliedCount, hasApplied } from './assertions';

/**
 * Cross-adapter parity scenarios for the human-interaction triggers.
 *
 * Trigger schedules are measured from chaos start (injection), not from the
 * first step, so every offset below leaves generous headroom for the runner
 * to navigate and click before the trigger fires. Assertions read monotonic
 * fixture counters (`#visibility-hidden-count`, `#retry-click-count`) rather
 * than transient states, so a slow-polling runner can never miss an edge.
 */
export const userInteractionScenarios: Scenario[] = [
  {
    id: 'user-cancel-mid-stream',
    title: 'cancelStreamAfterMs aborts an in-flight chat stream and the UI shows the stopped state',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      userInteraction: { cancelStreamAfterMs: 3000 },
    },
    steps: [
      // Slow variant: 8 messages, 1200ms apart, so the stream is still live
      // when the cancel fires at 3000ms and for several seconds after.
      click('#chat-start-slow'),
      waitForText('#chat-status', 'open'),
      // AbortError reaches the reader and the page renders its cleanup state.
      waitForText('#chat-status', 'stopped'),
    ],
    check: (ctx, assert) => {
      const cancels = ctx.log.filter((e) => e.type === 'ui:user-cancel' && e.applied);
      assert.ok(cancels.length >= 1, 'expected at least one applied user-cancel event');
      const fetchCancel = cancels.find((e) => e.detail.targetTransport === 'fetch-stream');
      assert.ok(fetchCancel, 'expected the cancel to hit a fetch-stream connection');
      assert.ok(
        String(fetchCancel!.detail.url).includes('/chat'),
        'expected the cancelled connection to be the chat stream',
      );
      assert.equal(fetchCancel!.detail.phase, 'user:cancel', 'expected the user:cancel phase tag');
    },
  },
  {
    id: 'user-retry-storm-with-slow-first-chunk',
    title: 'retryStorm clicks the retry button while the first chunk is delayed',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      ai: { firstChunkDelayMs: 2500 },
      userInteraction: { retryStorm: { count: 3, intervalMs: 300, afterMs: 500 } },
    },
    steps: [
      click('#chat-start'),
      // The storm lands while the first chunk is still held back.
      waitForCount('#retry-click-count', 3),
      // The stream still completes once the delay elapses.
      waitForText('#chat-status', 'done'),
      expectText('#chat-message-count', '5'),
    ],
    check: (ctx, assert) => {
      assert.equal(
        appliedCount(ctx.log, 'ui:retry-storm'),
        3,
        'expected exactly three applied retry clicks',
      );
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:chunk-delayed'),
        'expected the first chunk to have been delayed while the storm ran',
      );
    },
  },
  {
    id: 'user-tab-hidden',
    title: 'tabHidden flips document visibility and the page visibility handler engages',
    transport: 'ui',
    config: {
      seed: 42,
      userInteraction: { tabHidden: { afterMs: 500, durationMs: 1000 } },
    },
    steps: [
      waitForCount('#visibility-hidden-count', 1),
      waitForText('#visibility-state', 'visible'),
    ],
    check: (ctx, assert) => {
      const phases = ctx.log
        .filter((e) => e.type === 'ui:visibility' && e.applied)
        .map((e) => e.detail.phase);
      assert.equal(phases.length, 2, 'expected both visibility edges to emit');
      assert.equal(phases[0], 'user:tab-hidden', 'expected the hidden edge first');
      assert.equal(phases[1], 'user:tab-visible', 'expected the visible edge second');
    },
  },
  {
    id: 'user-prompt-edit',
    title: 'promptEditDuringResponse types into the prompt input and fires input events',
    transport: 'ui',
    config: {
      seed: 42,
      userInteraction: { promptEditDuringResponse: { afterMs: 500, simulateTypingMs: 400 } },
    },
    steps: [
      // Default text ` (edited)` lands character by character across 400ms.
      waitForText('#prompt-value', 'Tell me a story (edited)'),
    ],
    check: (ctx, assert) => {
      assert.equal(
        appliedCount(ctx.log, 'ui:prompt-edit'),
        1,
        'expected one applied prompt-edit trigger',
      );
    },
  },
  {
    id: 'preset-ai-mobile-interrupt',
    title: 'aiMobileInterrupt preset hides the tab and drops the stream mid-generation',
    transport: 'fetch-stream',
    config: {
      seed: 42,
      presets: ['ai-mobile-interrupt'],
    },
    steps: [
      // Long variant: 12 messages, 300ms apart, so the preset's close rule
      // (afterChunk 10) truncates the stream mid-generation.
      click('#chat-start-long'),
      waitForCount('#visibility-hidden-count', 1),
      waitForText('#chat-status', 'done'),
      waitForCount('#chat-message-count', 9),
    ],
    check: (ctx, assert) => {
      assert.ok(
        hasApplied(ctx.log, 'fetch-stream:truncated'),
        'expected the preset to truncate the stream',
      );
      assert.ok(
        ctx.log.some(
          (e) => e.type === 'ui:visibility' && e.applied && e.detail.phase === 'user:tab-hidden',
        ),
        'expected the preset to hide the tab',
      );
    },
  },
];
