/**
 * Recognize errors thrown when a browser session, page, or websocket
 * transport is gone  -  i.e. cases where adapter cleanup has nothing left to
 * act on and should swallow the failure rather than surface it as a real
 * teardown bug.
 *
 * The list intentionally covers patterns from Playwright, Puppeteer,
 * WebdriverIO, Selenium, and Chrome DevTools Protocol. It is conservative:
 * unknown errors still propagate. Extend only when a real teardown path
 * surfaces a new shape.
 */
export const SESSION_TEARDOWN_PATTERNS: readonly RegExp[] = [
  /invalid session id/i,
  /no such window/i,
  /session closed/i,
  /session not created/i,
  /browser has disconnected/i,
  /browser is closed/i,
  /target closed/i,
  /connection closed/i,
  /browsing context has been discarded/i,
];

/**
 * Returns true when `err` looks like a session/page-teardown failure rather
 * than a genuine runtime error. Adapters use this to make `removeChaos`
 * best-effort during framework teardown without masking real cleanup bugs.
 */
export function isSessionTeardownError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return SESSION_TEARDOWN_PATTERNS.some((pattern) => pattern.test(text));
}
