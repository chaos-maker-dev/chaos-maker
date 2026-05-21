import type { ChaosConfig, HostnameMatcher, NamedMatcher, RequestKvMatcher, RequestResourceType } from './config';
import { cloneValue } from './utils';

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

/** Evaluate a single query param requirement against every occurrence of that
 *  key. Query strings can carry repeated keys (e.g. `?role=admin&role=user`);
 *  `URLSearchParams.get()` only returns the first value, so we explicitly
 *  iterate `getAll()` and treat the requirement as satisfied when ANY value
 *  matches.
 *
 *  Semantics per matcher type:
 *  - `true`  - key must be present at least once (any value).
 *  - `false` - key must be absent entirely (no occurrences).
 *  - string  - at least one occurrence must equal the value exactly.
 *  - RegExp  - at least one occurrence must satisfy `.test()`. */
function matchQueryParamValues(
  values: readonly string[],
  matcher: RequestKvMatcher,
): boolean {
  if (matcher === true) return values.length > 0;
  if (matcher === false) return values.length === 0;
  if (values.length === 0) return false;
  if (typeof matcher === 'string') return values.includes(matcher);
  resetRegexState(matcher);
  return values.some((v) => {
    resetRegexState(matcher);
    return matcher.test(v);
  });
}

export function matchQueryParams(
  searchParams: URLSearchParams,
  requirements: Record<string, RequestKvMatcher>,
): boolean {
  for (const [key, matcher] of Object.entries(requirements)) {
    const values = searchParams.getAll(key);
    if (!matchQueryParamValues(values, matcher)) return false;
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

/** A named matcher entry packaged for registry registration. */
export interface MatcherEntry {
  readonly name: string;
  readonly config: NamedMatcher;
}

function normalizeMatcherName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('[chaos-maker] matcher name cannot be empty');
  return trimmed;
}

/** Per-instance registry of named matchers. Constructor takes no built-ins.
 *  Mirrors the surface of `ProfileRegistry` so the public ergonomics line up. */
export class MatcherRegistry {
  private map = new Map<string, NamedMatcher>();

  constructor(initial: Iterable<MatcherEntry> = []) {
    for (const entry of initial) this.register(entry);
  }

  register(entry: MatcherEntry): void {
    const name = normalizeMatcherName(entry.name);
    if (this.map.has(name)) {
      throw new Error(`[chaos-maker] matcher '${name}' already registered`);
    }
    this.map.set(name, entry.config);
  }

  registerAll(entries: Record<string, NamedMatcher> | undefined): void {
    if (!entries) return;
    for (const [name, config] of Object.entries(entries)) {
      this.register({ name, config });
    }
  }

  has(name: string): boolean {
    return this.map.has(normalizeMatcherName(name));
  }

  get(name: string): NamedMatcher {
    const norm = normalizeMatcherName(name);
    const cfg = this.map.get(norm);
    if (!cfg) {
      throw new Error(
        `[chaos-maker] matcher '${norm}' is not registered. Known: ${this.list().join(', ')}`,
      );
    }
    return cfg;
  }

  list(): string[] {
    return [...this.map.keys()];
  }
}

/** Side-channel WeakMap keyed by rule object reference. After
 *  `resolveNamedMatchers` inlines a registered matcher's fields into a rule,
 *  the matcher's name is recorded here so debug events and `buildRuleIdMap`
 *  can surface `matcherName` without bloating the public rule type. Entries
 *  are GC'd with the rule object. */
export const ruleMatcherOrigin = new WeakMap<object, string>();

/** Pull the matcher-origin name for a rule (if any) into a spreadable detail
 *  fragment. Interceptor emit sites use this to enrich chaos events with
 *  `matcherName` without adding a rule-aware `emit()` overload to the
 *  emitter. Returns an empty object when the rule did not come from a named
 *  matcher; the spread is then a no-op. */
export function matcherDetail(rule: object): { matcherName?: string } {
  const name = ruleMatcherOrigin.get(rule);
  return name !== undefined ? { matcherName: name } : {};
}

const NETWORK_RULE_CATEGORIES = ['failures', 'latencies', 'aborts', 'corruptions', 'cors'] as const;
const WEBSOCKET_RULE_CATEGORIES = ['drops', 'delays', 'corruptions', 'closes'] as const;
const SSE_RULE_CATEGORIES = ['drops', 'delays', 'corruptions', 'closes'] as const;

function resolveRulesIn(
  group: Record<string, unknown> | undefined,
  categories: readonly string[],
  registry: MatcherRegistry,
): void {
  if (!group) return;
  for (const cat of categories) {
    const arr = group[cat] as Array<Record<string, unknown>> | undefined;
    if (!arr) continue;
    for (const rule of arr) {
      const ref = rule.matcher;
      if (typeof ref !== 'string') continue;
      if (!registry.has(ref)) {
        throw new Error(`[chaos-maker] matcher '${ref}' is not registered`);
      }
      const cfg = cloneValue(registry.get(ref)) as Record<string, unknown>;
      if (cfg.matcher !== undefined) {
        throw new Error(
          `[chaos-maker] matcher '${ref}' references another matcher (matcher composition is out of scope)`,
        );
      }
      for (const [key, value] of Object.entries(cfg)) {
        rule[key] = value;
      }
      delete rule.matcher;
      ruleMatcherOrigin.set(rule, ref);
    }
  }
}

/** Resolve every rule with `matcher: 'name'` against `registry`. Inlines the
 *  registered `NamedMatcher` fields into the rule, deletes the `matcher` key,
 *  and stamps the matcher name on `ruleMatcherOrigin` for debug attribution.
 *  Walks network, WebSocket, and SSE rule arrays so a single named matcher
 *  can target any combination of transports. Returns a fresh `ChaosConfig`
 *  (deep-cloned) with the top-level `matchers` field stripped, identical
 *  immutability contract to `applyProfile`.
 *
 *  Throws plain `Error`s that `prepareChaosConfig` maps to structured codes:
 *  - `matcher_not_found` - rule references a missing name.
 *  - `matcher_cycle` - registry entry carries its own `matcher` field
 *    (structurally impossible via the typed surface; defensive). */
export function resolveNamedMatchers(
  config: ChaosConfig,
  registry: MatcherRegistry,
): ChaosConfig {
  const out = cloneValue(config);
  delete out.matchers;
  resolveRulesIn(out.network as Record<string, unknown> | undefined, NETWORK_RULE_CATEGORIES, registry);
  resolveRulesIn(out.websocket as Record<string, unknown> | undefined, WEBSOCKET_RULE_CATEGORIES, registry);
  resolveRulesIn(out.sse as Record<string, unknown> | undefined, SSE_RULE_CATEGORIES, registry);
  return out;
}

