import { browser, $ } from '@wdio/globals';
import type { ChaosEvent } from '@chaos-maker/core';

const API_PATTERN = '/api/data.json';

async function visitAndInject(config: Parameters<WebdriverIO.Browser['injectChaos']>[0]): Promise<void> {
  await browser.url('/');
  await browser.injectChaos(config);
}

/** Read every `[Chaos] ` line emitted to console.debug since the page loaded.
 *  WDIO has no first-class console-message stream, so we install a tap that
 *  records `console.debug` calls and stash the lines on a DOM `<script>` holder.
 *  We read the holder via `browser.execute` because Firefox/geckodriver runs
 *  executeScript bodies inside a sandbox whose globals don't share state with
 *  the real page-realm `window`  -  so the DOM is the only reliable cross-realm
 *  channel. */
async function readChaosDebugLines(): Promise<string[]> {
  return browser.execute(() => {
    const holder = document.getElementById('__chaos_debug_holder');
    if (!holder || !holder.textContent) return [] as string[];
    try {
      return JSON.parse(holder.textContent) as string[];
    } catch {
      return [] as string[];
    }
  });
}

/** Install the page-realm `console.debug` interceptor. Done via an inline
 *  `<script>` tag so the override runs in the page realm; assigning to
 *  `window.console.debug` from `browser.execute`'s sandbox does not reach the
 *  real `console` on Firefox/geckodriver. */
async function installDebugTap(): Promise<void> {
  await browser.execute(() => {
    if (document.querySelector('script[data-chaos-debug-tap]')) return;
    const tap = document.createElement('script');
    tap.setAttribute('data-chaos-debug-tap', '1');
    tap.textContent =
      '(function(){' +
      '  if (window.__chaosDebugLines) return;' +
      '  window.__chaosDebugLines = [];' +
      '  var original = console.debug.bind(console);' +
      '  console.debug = function() {' +
      '    try {' +
      '      if (arguments.length && typeof arguments[0] === "string" && arguments[0].indexOf("[Chaos] ") === 0) {' +
      '        window.__chaosDebugLines.push(arguments[0]);' +
      '        var holder = document.getElementById("__chaos_debug_holder");' +
      '        if (!holder) {' +
      '          holder = document.createElement("script");' +
      '          holder.type = "application/json";' +
      '          holder.id = "__chaos_debug_holder";' +
      '          (document.head || document.documentElement).appendChild(holder);' +
      '        }' +
      '        holder.textContent = JSON.stringify(window.__chaosDebugLines);' +
      '      }' +
      '    } catch (e) {}' +
      '    return original.apply(console, arguments);' +
      '  };' +
      '})();';
    (document.head || document.documentElement).appendChild(tap);
    tap.remove();
  });
}

describe('Debug Mode', () => {
  it('mirrors a [Chaos] line to console.debug when debug:true', async () => {
    await browser.url('/');
    await installDebugTap();
    await browser.injectChaos({
      debug: true,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    await $('#fetch-data').click();
    await expect($('#result')).toHaveTextContaining('503');

    const lines = await readChaosDebugLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith('[Chaos] rule-applied'))).toBe(true);
  });

  it('emits structured rule-applied debug event with ruleType + ruleId', async () => {
    await visitAndInject({
      debug: true,
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    await $('#fetch-data').click();
    await expect($('#result')).toHaveTextContaining('503');

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    const applied = log.find((e) => e.type === 'debug' && e.detail.stage === 'rule-applied');
    expect(applied).toBeDefined();
    expect(applied!.detail.ruleType).toBe('failure');
    expect(applied!.detail.ruleId).toBe('failure#0');
  });

  it('emits no debug events when debug is omitted', async () => {
    await browser.url('/');
    await installDebugTap();
    await browser.injectChaos({
      network: { failures: [{ urlPattern: API_PATTERN, statusCode: 503, probability: 1.0 }] },
    });
    await $('#fetch-data').click();
    await expect($('#result')).toHaveTextContaining('503');

    const log = (await browser.getChaosLog()) as ChaosEvent[];
    expect(log.some((e) => e.type === 'debug')).toBe(false);
    const lines = await readChaosDebugLines();
    expect(lines).toHaveLength(0);
  });
});
