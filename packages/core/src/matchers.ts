import type { HostnameMatcher, RequestKvMatcher, RequestResourceType } from './config';

/** Extracted view of a request URL relevant to advanced matchers. Computed
 *  once per request inside the interceptor so hostname + query-param checks
 *  share a single `URL` parse. */
export interface ParsedRequestUrl {
  hostname: string;
  searchParams: URLSearchParams;
}

const URL_FALLBACK_BASE = 'http://localhost';

/** Parse a fetch/XHR URL string into the subset needed by matchers. Returns
 *  `null` for unparseable inputs (caller treats as no-match). Uses the page's
 *  `location.href` as base when available so relative URLs like `/api/users`
 *  resolve consistently with what the browser actually requests. */
export function parseRequestUrl(url: string): ParsedRequestUrl | null {
  try {
    const base =
      typeof location !== 'undefined' && location && typeof location.href === 'string'
        ? location.href
        : URL_FALLBACK_BASE;
    const parsed = new URL(url, base);
    return { hostname: parsed.hostname, searchParams: parsed.searchParams };
  } catch {
    return null;
  }
}

function resetRegexState(re: RegExp): void {
  if (re.global || re.sticky) re.lastIndex = 0;
}

export function matchHostname(hostname: string, matcher: HostnameMatcher): boolean {
  if (typeof matcher === 'string') {
    return hostname.toLowerCase() === matcher.toLowerCase();
  }
  resetRegexState(matcher);
  return matcher.test(hostname);
}

export function matchKvEntry(value: string | undefined, matcher: RequestKvMatcher): boolean {
  if (matcher === true) return value !== undefined;
  if (matcher === false) return value === undefined;
  if (typeof matcher === 'string') return value === matcher;
  if (value === undefined) return false;
  resetRegexState(matcher);
  return matcher.test(value);
}

export function matchQueryParams(
  searchParams: URLSearchParams,
  requirements: Record<string, RequestKvMatcher>,
): boolean {
  for (const [key, matcher] of Object.entries(requirements)) {
    const present = searchParams.has(key);
    const value = present ? searchParams.get(key) ?? '' : undefined;
    if (!matchKvEntry(value, matcher)) return false;
  }
  return true;
}

/** Case-insensitive header view abstraction. Both fetch and XHR interceptors
 *  build one of these per request and pass it to `matchHeaders`. */
export interface RequestHeaderView {
  has(name: string): boolean;
  get(name: string): string | undefined;
}

export function matchHeaders(
  view: RequestHeaderView,
  requirements: Record<string, RequestKvMatcher>,
): boolean {
  for (const [name, matcher] of Object.entries(requirements)) {
    const value = view.has(name) ? view.get(name) : undefined;
    if (!matchKvEntry(value, matcher)) return false;
  }
  return true;
}

/** Build a case-insensitive `RequestHeaderView` over any common header shape.
 *  Used by both interceptors so the matcher path sees a uniform interface. */
export function createHeaderView(
  source: HeadersInit | Map<string, string> | Record<string, string> | undefined | null,
): RequestHeaderView {
  const lower = new Map<string, string>();
  if (source) {
    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      source.forEach((value, name) => {
        lower.set(name.toLowerCase(), value);
      });
    } else if (source instanceof Map) {
      for (const [name, value] of source.entries()) {
        lower.set(name.toLowerCase(), value);
      }
    } else if (Array.isArray(source)) {
      for (const entry of source) {
        if (Array.isArray(entry) && entry.length === 2) {
          lower.set(String(entry[0]).toLowerCase(), String(entry[1]));
        }
      }
    } else if (typeof source === 'object') {
      for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        lower.set(name.toLowerCase(), String(value));
      }
    }
  }
  return {
    has: (name) => lower.has(name.toLowerCase()),
    get: (name) => lower.get(name.toLowerCase()),
  };
}

export function matchResourceType(
  actual: RequestResourceType,
  allowed: readonly RequestResourceType[] | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(actual);
}
