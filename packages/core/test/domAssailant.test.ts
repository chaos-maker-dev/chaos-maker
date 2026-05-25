import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { attachDomAssailant } from '../src/interceptors/domAssailant';
import { UiConfig } from '../src/config';
import { ChaosEventEmitter } from '../src/events';

describe('domAssailant', () => {
  let emitter: ChaosEventEmitter;
  let observer: MutationObserver;
  const deterministicRandom = () => 0;

  beforeEach(() => {
    emitter = new ChaosEventEmitter();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    if (observer) {
      observer.disconnect();
    }
    document.body.innerHTML = '';
  });

  function startObserver(config: UiConfig): MutationObserver {
    observer = attachDomAssailant(config, deterministicRandom, emitter);
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  // --- Initial scan tests ---

  it('should disable existing buttons on initial scan', () => {
    document.body.innerHTML = '<button id="btn">Click</button>';

    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
    };
    startObserver(config);

    const btn = document.getElementById('btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should hide existing elements on initial scan', () => {
    document.body.innerHTML = '<div class="sidebar">Sidebar</div>';

    const config: UiConfig = {
      assaults: [{ selector: '.sidebar', action: 'hide', probability: 1.0 }],
    };
    startObserver(config);

    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    expect(sidebar.style.display).toBe('none');
  });

  it('should remove existing elements on initial scan', () => {
    document.body.innerHTML = '<span class="ad">Ad content</span>';

    const config: UiConfig = {
      assaults: [{ selector: '.ad', action: 'remove', probability: 1.0 }],
    };
    startObserver(config);

    expect(document.querySelector('.ad')).toBeNull();
  });

  it('should not apply assault when probability is 0', () => {
    document.body.innerHTML = '<button id="btn">Click</button>';

    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 0 }],
    };
    startObserver(config);

    const btn = document.getElementById('btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('should handle multiple assaults on different selectors', () => {
    document.body.innerHTML = `
      <button id="btn">Click</button>
      <div class="sidebar">Side</div>
    `;

    const config: UiConfig = {
      assaults: [
        { selector: 'button', action: 'disable', probability: 1.0 },
        { selector: '.sidebar', action: 'hide', probability: 1.0 },
      ],
    };
    startObserver(config);

    expect((document.getElementById('btn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.sidebar') as HTMLElement).style.display).toBe('none');
  });

  it('should handle nested matching elements in initial scan', () => {
    document.body.innerHTML = `
      <div class="container">
        <button class="inner">Inner</button>
      </div>
    `;

    const config: UiConfig = {
      assaults: [{ selector: 'button.inner', action: 'disable', probability: 1.0 }],
    };
    startObserver(config);

    const btn = document.querySelector('button.inner') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // --- MutationObserver tests ---

  it('should assault dynamically added elements', async () => {
    const config: UiConfig = {
      assaults: [{ selector: '.dynamic', action: 'hide', probability: 1.0 }],
    };
    startObserver(config);

    const el = document.createElement('div');
    el.className = 'dynamic';
    el.textContent = 'Dynamic content';
    document.body.appendChild(el);

    // MutationObserver fires asynchronously  -  wait for callback to execute
    await new Promise((r) => setTimeout(r, 0));

    expect(el.style.display).toBe('none');
  });

  it('should assault children of dynamically added parent nodes', async () => {
    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
    };
    startObserver(config);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<button id="dynamic-btn">New</button>';
    document.body.appendChild(wrapper);

    await new Promise((r) => setTimeout(r, 0));

    const btn = document.getElementById('dynamic-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // --- Event emission tests ---

  it('should emit ui:assault event with applied: true', () => {
    document.body.innerHTML = '<button>Click</button>';

    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
    };
    startObserver(config);

    const log = emitter.getLog();
    expect(log.length).toBeGreaterThanOrEqual(1);

    const event = log.find((e) => e.type === 'ui:assault' && e.applied);
    expect(event).toBeDefined();
    expect(event!.detail.selector).toBe('button');
    expect(event!.detail.action).toBe('disable');
  });

  it('should emit ui:assault event with applied: false when skipped', () => {
    document.body.innerHTML = '<button>Click</button>';

    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 0 }],
    };
    startObserver(config);

    const log = emitter.getLog();
    const event = log.find((e) => e.type === 'ui:assault' && !e.applied);
    expect(event).toBeDefined();
  });

  // --- Edge cases ---

  it('should handle empty assaults array gracefully', () => {
    document.body.innerHTML = '<button>Click</button>';

    const config: UiConfig = { assaults: [] };
    startObserver(config);

    expect(emitter.getLog()).toHaveLength(0);
    expect((document.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('should handle no assaults key gracefully', () => {
    document.body.innerHTML = '<button>Click</button>';

    const config: UiConfig = {};
    startObserver(config);

    expect(emitter.getLog()).toHaveLength(0);
  });

  it('should not crash on invalid CSS selector', () => {
    document.body.innerHTML = '<button>Click</button>';

    const config: UiConfig = {
      assaults: [{ selector: '[[[invalid', action: 'disable', probability: 1.0 }],
    };

    // Should not throw
    expect(() => startObserver(config)).not.toThrow();
  });

  it('should handle disconnect correctly', async () => {
    const config: UiConfig = {
      assaults: [{ selector: 'button', action: 'disable', probability: 1.0 }],
    };
    startObserver(config);
    observer.disconnect();

    // Add element after disconnect  -  should NOT be assaulted
    const btn = document.createElement('button');
    btn.textContent = 'After disconnect';
    document.body.appendChild(btn);

    // Wait to confirm no deferred callback fires
    await new Promise((r) => setTimeout(r, 0));

    expect(btn.disabled).toBe(false);
  });
});
