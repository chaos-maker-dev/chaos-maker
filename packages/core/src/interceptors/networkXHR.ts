import { NetworkAbortConfig, NetworkConfig, NetworkCorruptionConfig, NetworkRuleMatchers } from '../config';
import { shouldApplyChaos, corruptText, matchUrl, incrementCounter, checkCountingCondition, gateGroup } from '../utils';
import type { RuleGroupRegistry } from '../groups';
import {
  evaluateGraphQLRule,
  extractGraphQLOperation,
  GraphQLExtractResult,
  GraphQLRuleOutcome,
} from '../graphql';
import {
  createHeaderView,
  matchHeaders,
  matchHostname,
  matchQueryParams,
  matchResourceType,
  parseRequestUrl,
  ParsedRequestUrl,
  RequestHeaderView,
} from '../matchers';
import { ChaosEvent, ChaosEventEmitter, ChaosEventType } from '../events';

/** Per-instance metadata attached to each XHR after `open()` / `send()` /
 *  `setRequestHeader()` patches run. Lives on the XHR object as
 *  non-enumerable properties to avoid polluting the public XHR surface. */
interface XhrChaosMeta {
  _chaos_url: string;
  _chaos_method: string;
  _chaos_headers?: Map<string, string>;
}

interface XhrBodyView {
  text: string | null;
  unparseable: boolean;
}

function readXhrBody(body: Document | XMLHttpRequestBodyInit | null | undefined): XhrBodyView {
  if (body === undefined || body === null) return { text: null, unparseable: false };
  if (typeof body === 'string') return { text: body, unparseable: false };
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return { text: body.toString(), unparseable: false };
  }
  // Blob, FormData, ArrayBuffer, TypedArray, Document  -  synchronous reads
  // aren't possible. Treat as unparseable so rules with graphqlOperation can
  // emit a diagnostic.
  return { text: null, unparseable: true };
}

function ruleHasGraphQLConstraint(rule: NetworkRuleMatchers): boolean {
  return rule.graphqlOperation !== undefined;
}

function ruleNeedsParsedUrl(rule: NetworkRuleMatchers): boolean {
  return rule.hostname !== undefined || rule.queryParams !== undefined;
}

function ruleNeedsHeaderView(rule: NetworkRuleMatchers): boolean {
  return rule.requestHeaders !== undefined;
}

function anyRuleMatches(
  config: NetworkConfig,
  predicate: (rule: NetworkRuleMatchers) => boolean,
): boolean {
  const groups = [config.failures, config.latencies, config.aborts, config.corruptions, config.cors];
  for (const group of groups) {
    if (group?.some(predicate)) return true;
  }
  return false;
}

function emitGraphQLDiagnostic(
  emitter: ChaosEventEmitter | undefined,
  type: ChaosEventType,
  url: string,
  method: string,
  detail: ChaosEvent['detail'],
): void {
  emitter?.emit({
    type,
    timestamp: Date.now(),
    applied: false,
    detail: { url, method, ...detail, reason: 'graphql-body-unparseable' },
  });
}

interface MatcherContext {
  url: string;
  method: string;
  resourceType: 'xhr';
  gqlExtract: GraphQLExtractResult;
  getParsedUrl(): ParsedRequestUrl | null;
  getHeaderView(): RequestHeaderView;
}

interface GateResult {
  proceed: boolean;
  outcome: GraphQLRuleOutcome | null;
  matchedBy?: string[];
  skippedAt?: string;
}

/**
 * Shared per-rule gate covering every matcher field. Counting runs at the
 * end so it advances only when the rule has fully matched (mirrors the
 * pre-matcher behavior). Returns `matchedBy` listing extra matcher fields
 * that fired or `skippedAt` naming the first one that failed.
 */
function gateRule(
  rule: NetworkRuleMatchers & { onNth?: number; everyNth?: number; afterN?: number },
  ctx: MatcherContext,
  counters: Map<object, number>,
): GateResult {
  if (!matchUrl(ctx.url, rule.urlPattern)) return { proceed: false, outcome: null, skippedAt: 'urlPattern' };
  if (rule.methods && !rule.methods.includes(ctx.method)) return { proceed: false, outcome: null, skippedAt: 'methods' };
  const matchedBy: string[] = [];
  if (rule.resourceTypes) {
    if (!matchResourceType(ctx.resourceType, rule.resourceTypes)) {
      return { proceed: false, outcome: null, skippedAt: 'resourceTypes' };
    }
    matchedBy.push('resourceTypes');
  }
  if (rule.hostname !== undefined) {
    const parsed = ctx.getParsedUrl();
    if (!parsed || !matchHostname(parsed.hostname, rule.hostname)) {
      return { proceed: false, outcome: null, skippedAt: 'hostname' };
    }
    matchedBy.push('hostname');
  }
  if (rule.queryParams) {
    const parsed = ctx.getParsedUrl();
    if (!parsed || !matchQueryParams(parsed.searchParams, rule.queryParams)) {
      return { proceed: false, outcome: null, skippedAt: 'queryParams' };
    }
    matchedBy.push('queryParams');
  }
  if (rule.requestHeaders) {
    if (!matchHeaders(ctx.getHeaderView(), rule.requestHeaders)) {
      return { proceed: false, outcome: null, skippedAt: 'requestHeaders' };
    }
    matchedBy.push('requestHeaders');
  }
  const outcome = evaluateGraphQLRule(rule.graphqlOperation, ctx.gqlExtract);
  // XHR's gateRule short-circuits on `unparseable` as proceed:false (caller
  // emits the GraphQL diagnostic) - intentional divergence from fetch's
  // probabilistic-emit path because XHR has no per-request body re-read.
  if (outcome.kind === 'no-match' || outcome.kind === 'unparseable') {
    return { proceed: false, outcome, skippedAt: 'graphqlOperation' };
  }
  if (rule.graphqlOperation !== undefined) matchedBy.push('graphqlOperation');
  const count = incrementCounter(rule, counters);
  if (!checkCountingCondition(rule, count)) return { proceed: false, outcome };
  return { proceed: true, outcome, matchedBy: matchedBy.length > 0 ? matchedBy : undefined };
}

function operationDetail(outcome: GraphQLRuleOutcome | null): { operationName?: string } {
  if (!outcome) return {};
  if (outcome.kind === 'match' || outcome.kind === 'skip-no-constraint') {
    return outcome.operationName ? { operationName: outcome.operationName } : {};
  }
  return {};
}

function emitAbortEvent(
  emitter: ChaosEventEmitter | undefined,
  abort: NetworkAbortConfig,
  url: string,
  method: string,
  applied: boolean,
  outcome: GraphQLRuleOutcome | null,
): void {
  emitter?.emit({
    type: 'network:abort',
    timestamp: Date.now(),
    applied,
    detail: { url, method, timeoutMs: abort.timeout, ...operationDetail(outcome) },
  });
}

function emitCorruptionEvent(
  emitter: ChaosEventEmitter | undefined,
  corruption: NetworkCorruptionConfig,
  url: string,
  method: string,
  applied: boolean,
  outcome: GraphQLRuleOutcome | null,
): void {
  emitter?.emit({
    type: 'network:corruption',
    timestamp: Date.now(),
    applied,
    detail: { url, method, strategy: corruption.strategy, ...operationDetail(outcome) },
  });
}

export function patchXHR(originalXhrSend: (body?: Document | XMLHttpRequestBodyInit) => void, config: NetworkConfig, random: () => number, emitter?: ChaosEventEmitter, counters: Map<object, number> = new Map(), groups?: RuleGroupRegistry) {
  const needsGqlExtract = anyRuleMatches(config, ruleHasGraphQLConstraint);
  const needsParsedUrl = anyRuleMatches(config, ruleNeedsParsedUrl);
  const needsHeaderView = anyRuleMatches(config, ruleNeedsHeaderView);

  return function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit) {
    const url = (this as unknown as XhrChaosMeta)._chaos_url;
    const method = (this as unknown as XhrChaosMeta)._chaos_method;

    let gqlExtract: GraphQLExtractResult = { kind: 'not-graphql' };
    if (needsGqlExtract) {
      const view = readXhrBody(body);
      gqlExtract = extractGraphQLOperation(method, url, view.text, view.unparseable);
    }

    let parsedUrlCache: ParsedRequestUrl | null | undefined;
    let headerViewCache: RequestHeaderView | undefined;
    const ctx: MatcherContext = {
      url,
      method,
      resourceType: 'xhr',
      gqlExtract,
      getParsedUrl: () => {
        if (parsedUrlCache === undefined) {
          parsedUrlCache = needsParsedUrl ? parseRequestUrl(url) : null;
        }
        return parsedUrlCache;
      },
      getHeaderView: () => {
        if (headerViewCache === undefined) {
          const tracked = (this as unknown as XhrChaosMeta)._chaos_headers;
          headerViewCache = needsHeaderView
            ? createHeaderView(tracked)
            : createHeaderView(undefined);
        }
        return headerViewCache;
      },
    };

    // 1. Check for CORS
    // CORS uses inline matcher checks (not gateRule) on purpose: CORS rules
    // emit a `graphql-body-unparseable` diagnostic without first incrementing
    // the per-rule counter, whereas gateRule increments before evaluating
    // graphqlOperation. Sharing gateRule would either double-count or skip the
    // diagnostic. The matcher checks below stay deliberately parallel to
    // gateRule's order so behavior remains consistent across both paths.
    if (config.cors) {
      for (const cors of config.cors) {
        emitter?.debug('rule-evaluating', { url, method }, cors);
        if (!matchUrl(url, cors.urlPattern)) {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: 'urlPattern' }, cors);
          continue;
        }
        if (cors.methods && !cors.methods.includes(method)) {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: 'methods' }, cors);
          continue;
        }
        if (cors.resourceTypes && !matchResourceType('xhr', cors.resourceTypes)) {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: 'resourceTypes' }, cors);
          continue;
        }
        const corsMatchedBy: string[] = [];
        if (cors.hostname !== undefined) {
          const parsed = ctx.getParsedUrl();
          if (!parsed || !matchHostname(parsed.hostname, cors.hostname)) {
            emitter?.debug('rule-skip-match', { url, method, skippedAt: 'hostname' }, cors);
            continue;
          }
          corsMatchedBy.push('hostname');
        }
        if (cors.queryParams) {
          const parsed = ctx.getParsedUrl();
          if (!parsed || !matchQueryParams(parsed.searchParams, cors.queryParams)) {
            emitter?.debug('rule-skip-match', { url, method, skippedAt: 'queryParams' }, cors);
            continue;
          }
          corsMatchedBy.push('queryParams');
        }
        if (cors.requestHeaders && !matchHeaders(ctx.getHeaderView(), cors.requestHeaders)) {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: 'requestHeaders' }, cors);
          continue;
        }
        if (cors.requestHeaders) corsMatchedBy.push('requestHeaders');
        if (cors.resourceTypes) corsMatchedBy.push('resourceTypes');
        const outcome = evaluateGraphQLRule(cors.graphqlOperation, gqlExtract);
        if (outcome.kind === 'no-match') {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: 'graphqlOperation' }, cors);
          continue;
        }
        if (outcome.kind === 'unparseable') {
          emitGraphQLDiagnostic(emitter, 'network:cors', url, method, {});
          continue;
        }
        if (cors.graphqlOperation !== undefined) corsMatchedBy.push('graphqlOperation');
        emitter?.debug('rule-matched', { url, method, matchedBy: corsMatchedBy.length > 0 ? corsMatchedBy : undefined }, cors);
        const count = incrementCounter(cors, counters);
        if (!checkCountingCondition(cors, count)) {
          emitter?.debug('rule-skip-counting', { url, method }, cors);
          continue;
        }
        if (!gateGroup(cors, groups, emitter, { url, method })) continue;
        const applied = shouldApplyChaos(cors.probability, random);
        emitter?.emit({
          type: 'network:cors',
          timestamp: Date.now(),
          applied,
          detail: { url, method, ...operationDetail(outcome) },
        });
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method }, cors);
          continue;
        }
        emitter?.debug('rule-applied', { url, method }, cors);
        // The `rule-applied` debug event above already conveys the apply
        // signal; an extra console.debug would duplicate it.
        Object.defineProperty(this, 'status', { value: 0 });
        Object.defineProperty(this, 'statusText', { value: '' });
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('loadend'));
        return;
      }
    }

    // 2. Check for Abort
    if (config.aborts) {
      for (const abort of config.aborts) {
        emitter?.debug('rule-evaluating', { url, method, timeoutMs: abort.timeout }, abort);
        const gate = gateRule(abort, ctx, counters);
        if (!gate.proceed) {
          if (gate.outcome?.kind === 'unparseable') {
            emitGraphQLDiagnostic(emitter, 'network:abort', url, method, { timeoutMs: abort.timeout });
          } else {
            emitter?.debug('rule-skip-match', { url, method, timeoutMs: abort.timeout, skippedAt: gate.skippedAt }, abort);
          }
          continue;
        }
        emitter?.debug('rule-matched', { url, method, timeoutMs: abort.timeout, matchedBy: gate.matchedBy }, abort);
        if (!gateGroup(abort, groups, emitter, { url, method, timeoutMs: abort.timeout })) continue;
        const applied = shouldApplyChaos(abort.probability, random);
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, timeoutMs: abort.timeout }, abort);
          emitAbortEvent(emitter, abort, url, method, false, gate.outcome);
          continue;
        }

        emitter?.debug('rule-applied', { url, method, timeoutMs: abort.timeout }, abort);
        console.warn(`CHAOS: Aborting ${method} ${url} after ${abort.timeout || 0}ms`);

        let abortSettled = false;
        let abortTimer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
          if (abortTimer) {
            clearTimeout(abortTimer);
            abortTimer = undefined;
          }
          if (typeof this.removeEventListener === 'function') {
            this.removeEventListener('loadend', handleLoadEnd);
          }
        };

        const finalizeAbort = (didAbort: boolean) => {
          if (abortSettled) {
            return;
          }
          abortSettled = true;
          cleanup();
          emitAbortEvent(emitter, abort, url, method, didAbort, gate.outcome);
        };

        const handleLoadEnd = () => {
          finalizeAbort(false);
        };

        const applyAbort = () => {
          if (abortSettled) {
            return;
          }
          finalizeAbort(true);
          this.abort();
        };

        if (typeof this.addEventListener === 'function') {
          this.addEventListener('loadend', handleLoadEnd);
        }

        try {
          originalXhrSend.call(this, body);
        } catch (error) {
          finalizeAbort(false);
          throw error;
        }

        if (abortSettled) {
          return;
        }

        if (abort.timeout) {
          abortTimer = setTimeout(applyAbort, abort.timeout);
        } else {
          applyAbort();
        }
        return;
      }
    }

    // 3. Check for Failures
    if (config.failures) {
      for (const failure of config.failures) {
        emitter?.debug('rule-evaluating', { url, method, statusCode: failure.statusCode }, failure);
        const gate = gateRule(failure, ctx, counters);
        if (!gate.proceed) {
          if (gate.outcome?.kind === 'unparseable') {
            emitGraphQLDiagnostic(emitter, 'network:failure', url, method, { statusCode: failure.statusCode });
          } else {
            emitter?.debug('rule-skip-match', { url, method, statusCode: failure.statusCode, skippedAt: gate.skippedAt }, failure);
          }
          continue;
        }
        emitter?.debug('rule-matched', { url, method, statusCode: failure.statusCode, matchedBy: gate.matchedBy }, failure);
        if (!gateGroup(failure, groups, emitter, { url, method, statusCode: failure.statusCode })) continue;
        const applied = shouldApplyChaos(failure.probability, random);
        emitter?.emit({
          type: 'network:failure',
          timestamp: Date.now(),
          applied,
          detail: { url, method, statusCode: failure.statusCode, ...operationDetail(gate.outcome) },
        });
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, statusCode: failure.statusCode }, failure);
          continue;
        }
        emitter?.debug('rule-applied', { url, method, statusCode: failure.statusCode }, failure);
        // The `if (!applied) continue;` above already proves applied is true,
        // so no extra `if (applied)` wrapper is needed here.
        console.warn(`CHAOS: Forcing ${failure.statusCode} for ${method} ${url}`);
        Object.defineProperty(this, 'status', { value: failure.statusCode });
        Object.defineProperty(this, 'statusText', {
          value: failure.statusText ?? 'Service Unavailable (Chaos)',
        });
        const responseBody = failure.body ?? JSON.stringify({ error: 'Chaos Maker Attack!' });
        Object.defineProperty(this, 'responseText', { value: responseBody, configurable: true });
        const responseHeaders = failure.headers ?? {};
        Object.defineProperty(this, 'getResponseHeader', {
          value: (name: string) => {
            const key = Object.keys(responseHeaders).find(
              (k) => k.toLowerCase() === name.toLowerCase()
            );
            return key ? responseHeaders[key] : null;
          },
          configurable: true
        });
        Object.defineProperty(this, 'getAllResponseHeaders', {
          value: () =>
            Object.entries(responseHeaders)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n'),
          configurable: true
        });
        // Per the XHR spec, an HTTP failure (server returned a 4xx/5xx) is
        // still a *successful* transport: the user-agent fires `load` then
        // `loadend`, never `error`. The `error` event is reserved for
        // network-level failures (DNS, connection refused, CORS)  -  that path
        // remains unchanged in the CORS-block branch above.
        this.dispatchEvent(new Event('load'));
        this.dispatchEvent(new Event('loadend'));
        return;
      }
    }

    // 4. Check for Corruption
    let selectedCorruption: NetworkCorruptionConfig | null = null;
    let selectedCorruptionOutcome: GraphQLRuleOutcome | null = null;
    if (config.corruptions) {
      for (const corruption of config.corruptions) {
        emitter?.debug('rule-evaluating', { url, method, strategy: corruption.strategy }, corruption);
        const gate = gateRule(corruption, ctx, counters);
        if (!gate.proceed) {
          if (gate.outcome?.kind === 'unparseable') {
            emitGraphQLDiagnostic(emitter, 'network:corruption', url, method, { strategy: corruption.strategy });
          } else {
            emitter?.debug('rule-skip-match', { url, method, strategy: corruption.strategy, skippedAt: gate.skippedAt }, corruption);
          }
          continue;
        }
        emitter?.debug('rule-matched', { url, method, strategy: corruption.strategy, matchedBy: gate.matchedBy }, corruption);
        if (!gateGroup(corruption, groups, emitter, { url, method, strategy: corruption.strategy })) continue;
        const applied = shouldApplyChaos(corruption.probability, random);
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, strategy: corruption.strategy }, corruption);
          emitCorruptionEvent(emitter, corruption, url, method, false, gate.outcome);
          continue;
        }
        emitter?.debug('rule-applied', { url, method, strategy: corruption.strategy }, corruption);
        selectedCorruption = corruption;
        selectedCorruptionOutcome = gate.outcome;
        break;
      }
    }

    if (selectedCorruption) {
      let settled = false;
      let corruptedText: string | null = null;

      const cleanup = () => {
        if (typeof this.removeEventListener !== 'function') return;
        this.removeEventListener('error', handleFailure);
        this.removeEventListener('abort', handleFailure);
        this.removeEventListener('loadend', handleLoadEnd);
      };

      const finalize = (applied: boolean) => {
        if (settled) return;
        settled = true;
        emitCorruptionEvent(emitter, selectedCorruption!, url, method, applied, selectedCorruptionOutcome);
        cleanup();
      };

      const applyCorruption = () => {
        if (corruptedText !== null) {
          return corruptedText;
        }

        delete (this as any).responseText;

        try {
          const originalText = this.responseText;
          if (typeof originalText !== 'string') {
            Object.defineProperty(this, 'responseText', { value: originalText, configurable: true });
            finalize(false);
            return originalText;
          }

          corruptedText = corruptText(originalText, selectedCorruption.strategy);
          Object.defineProperty(this, 'responseText', { value: corruptedText, configurable: true });
          finalize(true);
          return corruptedText;
        } catch (error) {
          finalize(false);
          throw error;
        }
      };

      const handleFailure = () => {
        finalize(false);
      };

      const handleLoadEnd = () => {
        if (settled) return;
        try {
          applyCorruption();
        } catch {
          // applyCorruption already finalizes the event and preserves the throw path for direct access
        }
      };

      if (typeof this.addEventListener === 'function') {
        this.addEventListener('error', handleFailure);
        this.addEventListener('abort', handleFailure);
        this.addEventListener('loadend', handleLoadEnd);
      }

      Object.defineProperty(this, 'responseText', {
        get() {
          return applyCorruption();
        },
        configurable: true,
      });
    }

    // 5. Check for Latency
    if (config.latencies) {
      for (const latency of config.latencies) {
        emitter?.debug('rule-evaluating', { url, method, delayMs: latency.delayMs }, latency);
        const gate = gateRule(latency, ctx, counters);
        if (!gate.proceed) {
          if (gate.outcome?.kind === 'unparseable') {
            emitGraphQLDiagnostic(emitter, 'network:latency', url, method, { delayMs: latency.delayMs });
          } else {
            emitter?.debug('rule-skip-match', { url, method, delayMs: latency.delayMs, skippedAt: gate.skippedAt }, latency);
          }
          continue;
        }
        emitter?.debug('rule-matched', { url, method, delayMs: latency.delayMs, matchedBy: gate.matchedBy }, latency);
        if (!gateGroup(latency, groups, emitter, { url, method, delayMs: latency.delayMs })) continue;
        const applied = shouldApplyChaos(latency.probability, random);
        emitter?.emit({
          type: 'network:latency',
          timestamp: Date.now(),
          applied,
          detail: { url, method, delayMs: latency.delayMs, ...operationDetail(gate.outcome) },
        });
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, delayMs: latency.delayMs }, latency);
          continue;
        }
        emitter?.debug('rule-applied', { url, method, delayMs: latency.delayMs }, latency);
        console.warn(`CHAOS: Adding ${latency.delayMs}ms latency to ${method} ${url}`);
        setTimeout(() => {
          originalXhrSend.call(this, body);
        }, latency.delayMs);
        return;
      }
    }

    // 6. If no chaos, proceed as normal
    originalXhrSend.call(this, body);
  };
}

export function patchXHROpen(originalXhrOpen: (method: string, url: string | URL) => void) {
  return function (this: XMLHttpRequest, method: string, url: string | URL) {
    const meta = this as unknown as XhrChaosMeta;
    meta._chaos_url = url.toString();
    meta._chaos_method = method.toUpperCase();
    // Reset per-request header tracker so a re-used XHR instance starts clean.
    meta._chaos_headers = new Map();
    originalXhrOpen.call(this, method, url);
  };
}

/** Patch `XMLHttpRequest.prototype.setRequestHeader` so the chaos engine can
 *  evaluate header matchers in `patchXHR` (send-time). Headers are stored in
 *  a per-instance `Map` keyed by lowercased name. Repeated calls for the same
 *  header name append per the spec (comma-joined). */
export function patchXHRSetRequestHeader(
  originalSetRequestHeader: (name: string, value: string) => void,
) {
  return function (this: XMLHttpRequest, name: string, value: string) {
    const meta = this as unknown as XhrChaosMeta;
    const headers = meta._chaos_headers ?? (meta._chaos_headers = new Map());
    const key = String(name).toLowerCase();
    const existing = headers.get(key);
    headers.set(key, existing === undefined ? String(value) : `${existing}, ${value}`);
    originalSetRequestHeader.call(this, name, value);
  };
}
