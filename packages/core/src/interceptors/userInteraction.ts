/** Human-interaction chaos for streaming UIs. Simulates the user side of
 *  streaming failures on a fixed schedule measured from install time: cancel
 *  mid-stream, retry storms, tab-visibility and focus flips, prompt edits
 *  during generation, navigate-away.
 *
 *  Determinism: every trigger fires at an exact ms offset; the PRNG is never
 *  consulted. Cleanup: `uninstall()` clears all pending timers and restores
 *  the visibility override, so nothing fires or stays patched after
 *  `ChaosMaker.stop()`.
 *
 *  DOM dependency: retry, prompt-edit, and visibility triggers need a
 *  `document`; navigate-away needs a `location`. Contexts without them
 *  (service workers, bare test targets) skip those triggers with a console
 *  warning. Cancel and blur/focus need only an event-dispatch-capable target. */

import type { UserInteractionConfig } from '../config';
import { ChaosEventEmitter } from '../events';
import type { StreamCancelRegistry } from './streamCancelRegistry';

export const DEFAULT_RETRY_SELECTOR = '[data-chaos-retry]';
export const DEFAULT_PROMPT_SELECTOR = '[data-chaos-prompt]';
export const DEFAULT_PROMPT_TEXT = ' (edited)';

export interface UserInteractionHandle {
  /** Clear pending trigger timers and restore the visibility override. */
  uninstall(): void;
}

/** Minimal shape of the chaos target the triggers need. Kept structural so
 *  unit tests can drive the interceptor with a fake window/document pair. */
export interface UserInteractionTarget {
  dispatchEvent?(event: Event): boolean;
  document?: Document;
  location?: { assign(url: string): void };
}

export interface UserInteractionDeps {
  target: UserInteractionTarget;
  emitter: ChaosEventEmitter;
  /** Present only when `cancelStreamAfterMs` is armed; shared with the
   *  transport interceptors, which register every connection they wrap. */
  cancelRegistry?: StreamCancelRegistry;
}

function warn(message: string): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
  try {
    console.warn(`[chaos-maker] ${message}`);
  } catch {
    // Console sinks are best-effort only.
  }
}

export function installUserInteraction(
  config: UserInteractionConfig,
  deps: UserInteractionDeps,
): UserInteractionHandle {
  const { target, emitter, cancelRegistry } = deps;
  let running = true;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const schedule = (afterMs: number, fn: () => void): void => {
    const handle = setTimeout(() => {
      pendingTimers.delete(handle);
      if (!running) return;
      fn();
    }, afterMs);
    pendingTimers.add(handle);
  };

  const doc = target.document;
  const requireDocument = (trigger: string): Document | null => {
    if (doc) return doc;
    warn(`userInteraction.${trigger} ignored - no DOM available in current context.`);
    return null;
  };

  // --- cancel ---------------------------------------------------------------
  if (config.cancelStreamAfterMs !== undefined) {
    schedule(config.cancelStreamAfterMs, () => {
      const cancelled = cancelRegistry?.cancelAll() ?? [];
      if (cancelled.length === 0) {
        emitter.emit({
          type: 'ui:user-cancel',
          timestamp: Date.now(),
          applied: false,
          detail: { phase: 'user:cancel', reason: 'no-active-streams' },
        });
        return;
      }
      for (const connection of cancelled) {
        emitter.emit({
          type: 'ui:user-cancel',
          timestamp: Date.now(),
          applied: true,
          detail: {
            phase: 'user:cancel',
            url: connection.url,
            connectionId: connection.connectionId,
            targetTransport: connection.transport,
          },
        });
      }
    });
  }

  // --- retry storm ----------------------------------------------------------
  if (config.retryStorm) {
    const { count, intervalMs } = config.retryStorm;
    const afterMs = config.retryStorm.afterMs ?? 0;
    const selector = config.retryStorm.selector ?? DEFAULT_RETRY_SELECTOR;
    const storm = requireDocument('retryStorm');
    if (storm) {
      let missEmitted = false;
      for (let i = 0; i < count; i++) {
        schedule(afterMs + i * intervalMs, () => {
          // Re-query per click: the app may re-render the button between
          // clicks (loading states swap disabled/enabled variants).
          const el = storm.querySelector(selector);
          if (el instanceof HTMLElement) {
            el.click();
            emitter.emit({
              type: 'ui:retry-storm',
              timestamp: Date.now(),
              applied: true,
              detail: { phase: 'user:retry', selector },
            });
          } else if (!missEmitted) {
            missEmitted = true;
            emitter.emit({
              type: 'ui:retry-storm',
              timestamp: Date.now(),
              applied: false,
              detail: { phase: 'user:retry', selector, reason: 'selector-not-found' },
            });
          }
        });
      }
    }
  }

  // --- tab visibility -------------------------------------------------------
  // Own-property accessors shadow the prototype getters, so deleting them on
  // restore hands control back to the browser. Pre-existing OWN descriptors
  // (another tool overriding visibility) are captured and reinstated.
  let visibilityOverridden = false;
  let previousVisibilityState: PropertyDescriptor | undefined;
  let previousHidden: PropertyDescriptor | undefined;

  const restoreVisibility = (emitEdge: boolean): void => {
    if (!visibilityOverridden || !doc) return;
    visibilityOverridden = false;
    try {
      delete (doc as unknown as Record<string, unknown>).visibilityState;
      delete (doc as unknown as Record<string, unknown>).hidden;
      if (previousVisibilityState) Object.defineProperty(doc, 'visibilityState', previousVisibilityState);
      if (previousHidden) Object.defineProperty(doc, 'hidden', previousHidden);
      doc.dispatchEvent(new Event('visibilitychange'));
    } catch (e) {
      warn(`userInteraction.tabHidden failed to restore visibility: ${(e as Error).message}`);
    }
    if (emitEdge) {
      emitter.emit({
        type: 'ui:visibility',
        timestamp: Date.now(),
        applied: true,
        detail: { phase: 'user:tab-visible' },
      });
    }
  };

  if (config.tabHidden) {
    const { afterMs, durationMs } = config.tabHidden;
    const hiddenDoc = requireDocument('tabHidden');
    if (hiddenDoc) {
      schedule(afterMs, () => {
        try {
          previousVisibilityState = Object.getOwnPropertyDescriptor(hiddenDoc, 'visibilityState');
          previousHidden = Object.getOwnPropertyDescriptor(hiddenDoc, 'hidden');
          Object.defineProperty(hiddenDoc, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          });
          Object.defineProperty(hiddenDoc, 'hidden', {
            configurable: true,
            get: () => true,
          });
          visibilityOverridden = true;
          hiddenDoc.dispatchEvent(new Event('visibilitychange'));
        } catch (e) {
          warn(`userInteraction.tabHidden failed to override visibility: ${(e as Error).message}`);
          return;
        }
        emitter.emit({
          type: 'ui:visibility',
          timestamp: Date.now(),
          applied: true,
          detail: { phase: 'user:tab-hidden' },
        });
        schedule(durationMs, () => restoreVisibility(true));
      });
    }
  }

  // --- window blur / focus --------------------------------------------------
  if (config.blurWindow) {
    const { afterMs, durationMs } = config.blurWindow;
    if (typeof target.dispatchEvent === 'function') {
      schedule(afterMs, () => {
        target.dispatchEvent!(new Event('blur'));
        emitter.emit({
          type: 'ui:focus',
          timestamp: Date.now(),
          applied: true,
          detail: { phase: 'user:window-blurred' },
        });
        schedule(durationMs, () => {
          target.dispatchEvent!(new Event('focus'));
          emitter.emit({
            type: 'ui:focus',
            timestamp: Date.now(),
            applied: true,
            detail: { phase: 'user:window-focused' },
          });
        });
      });
    } else {
      warn('userInteraction.blurWindow ignored - target cannot dispatch events.');
    }
  }

  // --- prompt edit during response -------------------------------------------
  if (config.promptEditDuringResponse) {
    const { afterMs, simulateTypingMs } = config.promptEditDuringResponse;
    const selector = config.promptEditDuringResponse.selector ?? DEFAULT_PROMPT_SELECTOR;
    const text = config.promptEditDuringResponse.text ?? DEFAULT_PROMPT_TEXT;
    const promptDoc = requireDocument('promptEditDuringResponse');
    if (promptDoc) {
      schedule(afterMs, () => {
        const el = promptDoc.querySelector(selector);
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
          emitter.emit({
            type: 'ui:prompt-edit',
            timestamp: Date.now(),
            applied: false,
            detail: { phase: 'user:prompt-edited', selector, reason: 'selector-not-found' },
          });
          return;
        }
        el.focus();
        emitter.emit({
          type: 'ui:prompt-edit',
          timestamp: Date.now(),
          applied: true,
          detail: { phase: 'user:prompt-edited', selector },
        });
        // Spread the keystrokes evenly across the typing window. Chars fire at
        // (i+1)/length of the window so the last char lands at simulateTypingMs.
        const chars = Array.from(text);
        chars.forEach((char, i) => {
          schedule(Math.round(((i + 1) / chars.length) * simulateTypingMs), () => {
            el.value += char;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      });
    }
  }

  // --- navigate away ----------------------------------------------------------
  if (config.navigateAway) {
    const { afterMs, target: destination } = config.navigateAway;
    const location = target.location;
    if (location && typeof location.assign === 'function') {
      schedule(afterMs, () => {
        // Emit before navigating: the navigation tears the page context down,
        // so this is the last chance for the event to reach the log.
        emitter.emit({
          type: 'ui:navigate',
          timestamp: Date.now(),
          applied: true,
          detail: { phase: 'user:navigated-away', url: destination },
        });
        location.assign(destination);
      });
    } else {
      warn('userInteraction.navigateAway ignored - no location available in current context.');
    }
  }

  return {
    uninstall(): void {
      running = false;
      for (const handle of pendingTimers) clearTimeout(handle);
      pendingTimers.clear();
      // Restore silently: the engine is stopping, so no user:tab-visible edge.
      restoreVisibility(false);
    },
  };
}
