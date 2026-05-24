import type { ResourceKind, Step } from './types';

/** Click an element by CSS selector. */
export const click = (selector: string): Step => ({ kind: 'click', selector });

/** Wait until the element's text content equals `text`. */
export const waitForText = (selector: string, text: string): Step => ({
  kind: 'waitForText',
  selector,
  text,
});

/** Wait until the element's numeric text content is at least `min`. */
export const waitForCount = (selector: string, min: number): Step => ({
  kind: 'waitForCount',
  selector,
  min,
});

/** Assert the element's text content equals `text` at the current moment. */
export const expectText = (selector: string, text: string): Step => ({
  kind: 'expectText',
  selector,
  text,
});

/** Pause for `ms` milliseconds. Used to give chaos a deterministic window
 *  to act (or not act) before a negative-side observation. */
export const settle = (ms: number): Step => ({ kind: 'settle', ms });

/** Issue an in-page request and record the resulting status under `capture`. */
export const request = (
  as: ResourceKind,
  url: string,
  capture: string,
  headers?: Record<string, string>,
): Step => ({ kind: 'request', as, url, capture, headers });
