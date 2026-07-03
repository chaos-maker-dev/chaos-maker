import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChaosEventEmitter, type ChaosEvent } from '../src/events';
import {
  installUserInteraction,
  type UserInteractionHandle,
  type UserInteractionTarget,
  DEFAULT_RETRY_SELECTOR,
  DEFAULT_PROMPT_SELECTOR,
} from '../src/interceptors/userInteraction';
import {
  StreamCancelRegistry,
  type CancelableStreamConnection,
} from '../src/interceptors/streamCancelRegistry';
import type { UserInteractionConfig } from '../src/config';

let emitter: ChaosEventEmitter;
let handle: UserInteractionHandle | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  emitter = new ChaosEventEmitter();
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.uninstall();
  handle = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function install(
  config: UserInteractionConfig,
  overrides: Partial<UserInteractionTarget> = {},
  cancelRegistry?: StreamCancelRegistry,
): UserInteractionHandle {
  const target: UserInteractionTarget = {
    dispatchEvent: window.dispatchEvent.bind(window),
    document,
    location: { assign: vi.fn() },
    ...overrides,
  };
  handle = installUserInteraction(config, { target, emitter, cancelRegistry });
  return handle;
}

function eventsOfType(type: ChaosEvent['type']): ChaosEvent[] {
  return emitter.getLog().filter((e) => e.type === type);
}

describe('StreamCancelRegistry', () => {
  it('cancels everything registered, returns applied connections, and clears', () => {
    const registry = new StreamCancelRegistry();
    const live: CancelableStreamConnection = {
      transport: 'fetch-stream',
      url: '/a',
      cancel: vi.fn(() => true),
    };
    const dead: CancelableStreamConnection = {
      transport: 'sse',
      url: '/b',
      cancel: vi.fn(() => false),
    };
    registry.register(live);
    registry.register(dead);

    const cancelled = registry.cancelAll();
    expect(cancelled).toEqual([live]);
    expect(live.cancel).toHaveBeenCalledTimes(1);
    expect(dead.cancel).toHaveBeenCalledTimes(1);
    // Registry cleared: a second sweep cancels nothing.
    expect(registry.cancelAll()).toEqual([]);
    expect(live.cancel).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing cancel hook', () => {
    const registry = new StreamCancelRegistry();
    registry.register({ transport: 'websocket', url: '/boom', cancel: () => { throw new Error('boom'); } });
    const ok: CancelableStreamConnection = { transport: 'sse', url: '/ok', cancel: () => true };
    registry.register(ok);
    expect(registry.cancelAll()).toEqual([ok]);
  });
});

describe('userInteraction: cancelStreamAfterMs', () => {
  it('fires at the exact scheduled offset', () => {
    const registry = new StreamCancelRegistry();
    install({ cancelStreamAfterMs: 4000 }, {}, registry);
    vi.advanceTimersByTime(3999);
    expect(eventsOfType('ui:user-cancel')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(eventsOfType('ui:user-cancel')).toHaveLength(1);
  });

  it('emits one applied event per cancelled connection with attribution', () => {
    const registry = new StreamCancelRegistry();
    registry.register({ transport: 'fetch-stream', url: '/chat', connectionId: 'c1', cancel: () => true });
    registry.register({ transport: 'sse', url: '/events', connectionId: 'c2', cancel: () => true });
    registry.register({ transport: 'websocket', url: '/ws', connectionId: 'c3', cancel: () => false });
    install({ cancelStreamAfterMs: 100 }, {}, registry);
    vi.advanceTimersByTime(100);

    const events = eventsOfType('ui:user-cancel');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.applied && e.detail.phase === 'user:cancel')).toBe(true);
    expect(events.map((e) => e.detail.targetTransport)).toEqual(['fetch-stream', 'sse']);
    expect(events.map((e) => e.detail.connectionId)).toEqual(['c1', 'c2']);
    expect(events.map((e) => e.detail.url)).toEqual(['/chat', '/events']);
  });

  it('emits a single diagnostic when nothing is in flight', () => {
    install({ cancelStreamAfterMs: 100 }, {}, new StreamCancelRegistry());
    vi.advanceTimersByTime(100);
    const events = eventsOfType('ui:user-cancel');
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(false);
    expect(events[0].detail.reason).toBe('no-active-streams');
  });
});

describe('userInteraction: retryStorm', () => {
  it('clicks the default selector on schedule and emits per click', () => {
    const button = document.createElement('button');
    button.setAttribute('data-chaos-retry', '');
    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    document.body.appendChild(button);

    install({ retryStorm: { count: 3, intervalMs: 100, afterMs: 50 } });
    vi.advanceTimersByTime(49);
    expect(clicks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(clicks).toBe(1);
    vi.advanceTimersByTime(200);
    expect(clicks).toBe(3);

    const events = eventsOfType('ui:retry-storm');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.applied && e.detail.phase === 'user:retry')).toBe(true);
    expect(events[0].detail.selector).toBe(DEFAULT_RETRY_SELECTOR);
  });

  it('emits the selector miss diagnostic once per storm', () => {
    install({ retryStorm: { count: 3, intervalMs: 50 } });
    vi.advanceTimersByTime(200);
    const events = eventsOfType('ui:retry-storm');
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(false);
    expect(events[0].detail.reason).toBe('selector-not-found');
  });
});

describe('userInteraction: tabHidden', () => {
  it('overrides visibility, dispatches both edges, and restores', () => {
    const flips: string[] = [];
    const listener = () => flips.push(document.visibilityState);
    document.addEventListener('visibilitychange', listener);
    try {
      install({ tabHidden: { afterMs: 100, durationMs: 200 } });
      expect(document.visibilityState).toBe('visible');
      vi.advanceTimersByTime(100);
      expect(document.visibilityState).toBe('hidden');
      expect(document.hidden).toBe(true);
      vi.advanceTimersByTime(200);
      expect(document.visibilityState).toBe('visible');
      expect(document.hidden).toBe(false);
      expect(flips).toEqual(['hidden', 'visible']);

      const events = eventsOfType('ui:visibility');
      expect(events.map((e) => e.detail.phase)).toEqual(['user:tab-hidden', 'user:tab-visible']);
    } finally {
      document.removeEventListener('visibilitychange', listener);
    }
  });

  it('restores silently on uninstall mid-window', () => {
    install({ tabHidden: { afterMs: 100, durationMs: 200 } });
    vi.advanceTimersByTime(150);
    expect(document.visibilityState).toBe('hidden');
    handle!.uninstall();
    expect(document.visibilityState).toBe('visible');
    vi.advanceTimersByTime(1000);
    const events = eventsOfType('ui:visibility');
    expect(events.map((e) => e.detail.phase)).toEqual(['user:tab-hidden']);
  });
});

describe('userInteraction: blurWindow', () => {
  it('dispatches blur then focus on schedule', () => {
    const dispatched: string[] = [];
    install({ blurWindow: { afterMs: 100, durationMs: 200 } }, {
      dispatchEvent: (event: Event) => { dispatched.push(event.type); return true; },
    });
    vi.advanceTimersByTime(100);
    expect(dispatched).toEqual(['blur']);
    vi.advanceTimersByTime(200);
    expect(dispatched).toEqual(['blur', 'focus']);

    const events = eventsOfType('ui:focus');
    expect(events.map((e) => e.detail.phase)).toEqual(['user:window-blurred', 'user:window-focused']);
  });
});

describe('userInteraction: promptEditDuringResponse', () => {
  it('focuses the input and types the text across the window', () => {
    const input = document.createElement('input');
    input.setAttribute('data-chaos-prompt', '');
    input.value = 'hi';
    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    document.body.appendChild(input);

    install({ promptEditDuringResponse: { afterMs: 50, simulateTypingMs: 90, text: 'abc' } });
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('hi');
    vi.advanceTimersByTime(90);
    expect(input.value).toBe('hiabc');
    expect(inputEvents).toBe(3);

    const events = eventsOfType('ui:prompt-edit');
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(true);
    expect(events[0].detail.selector).toBe(DEFAULT_PROMPT_SELECTOR);
    expect(events[0].detail.phase).toBe('user:prompt-edited');
  });

  it('emits a miss diagnostic when the selector matches nothing', () => {
    install({ promptEditDuringResponse: { afterMs: 10, simulateTypingMs: 50 } });
    vi.advanceTimersByTime(100);
    const events = eventsOfType('ui:prompt-edit');
    expect(events).toHaveLength(1);
    expect(events[0].applied).toBe(false);
    expect(events[0].detail.reason).toBe('selector-not-found');
  });
});

describe('userInteraction: navigateAway', () => {
  it('emits the event before calling location.assign', () => {
    const assign = vi.fn(() => {
      // By the time navigation fires, the event must already be logged.
      expect(eventsOfType('ui:navigate')).toHaveLength(1);
    });
    install({ navigateAway: { afterMs: 100, target: '/home' } }, { location: { assign } });
    vi.advanceTimersByTime(100);
    expect(assign).toHaveBeenCalledWith('/home');
    const events = eventsOfType('ui:navigate');
    expect(events[0].detail.url).toBe('/home');
    expect(events[0].detail.phase).toBe('user:navigated-away');
  });
});

describe('userInteraction: uninstall', () => {
  it('cancels every pending trigger', () => {
    const registry = new StreamCancelRegistry();
    registry.register({ transport: 'sse', url: '/x', cancel: () => true });
    install({ cancelStreamAfterMs: 100, retryStorm: { count: 2, intervalMs: 50 } }, {}, registry);
    handle!.uninstall();
    vi.advanceTimersByTime(1000);
    expect(emitter.getLog()).toHaveLength(0);
  });
});
