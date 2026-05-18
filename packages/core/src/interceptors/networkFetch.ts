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
  RequestHeaderView,
  ParsedRequestUrl,
} from '../matchers';
import { ChaosEvent, ChaosEventEmitter, ChaosEventType } from '../events';

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

function getFetchUrl(input: RequestInfo | URL): string {
  return isRequest(input) ? input.url : input.toString();
}

function getFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (isRequest(input)) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function getFetchSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal) {
    return init.signal;
  }
  if (isRequest(input)) {
    return input.signal;
  }
  return undefined;
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The user aborted a request.', 'AbortError');
  }

  const error = new Error('The user aborted a request.');
  error.name = 'AbortError';
  return error;
}

function mergeAbortSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) {
    return primary;
  }

  const controller = new AbortController();

  const abortFrom = (signal: AbortSignal) => {
    cleanup();
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  const onPrimaryAbort = () => abortFrom(primary);
  const onSecondaryAbort = () => abortFrom(secondary);

  const cleanup = () => {
    primary.removeEventListener('abort', onPrimaryAbort);
    secondary.removeEventListener('abort', onSecondaryAbort);
  };

  if (primary.aborted) {
    abortFrom(primary);
    return controller.signal;
  }

  if (secondary.aborted) {
    abortFrom(secondary);
    return controller.signal;
  }

  primary.addEventListener('abort', onPrimaryAbort, { once: true });
  secondary.addEventListener('abort', onSecondaryAbort, { once: true });
  return controller.signal;
}

function withSignal(init: RequestInit | undefined, signal: AbortSignal | undefined): RequestInit | undefined {
  if (!signal) {
    return init;
  }

  return {
    ...(init ?? {}),
    signal,
  };
}

interface FetchBodyView {
  text: string | null;
  unparseable: boolean;
}

async function readFetchBody(input: RequestInfo | URL, init?: RequestInit): Promise<FetchBodyView> {
  const initBody = init?.body;
  if (initBody !== undefined && initBody !== null) {
    if (typeof initBody === 'string') return { text: initBody, unparseable: false };
    if (typeof URLSearchParams !== 'undefined' && initBody instanceof URLSearchParams) {
      return { text: initBody.toString(), unparseable: false };
    }
    if (typeof Blob !== 'undefined' && initBody instanceof Blob) {
      const looksTextual = initBody.type === '' || /json|text|graphql/i.test(initBody.type);
      if (!looksTextual) return { text: null, unparseable: true };
      try {
        return { text: await initBody.text(), unparseable: false };
      } catch {
        return { text: null, unparseable: true };
      }
    }
    return { text: null, unparseable: true };
  }

  if (isRequest(input)) {
    if (input.body === null) return { text: null, unparseable: false };
    try {
      return { text: await input.clone().text(), unparseable: false };
    } catch {
      return { text: null, unparseable: true };
    }
  }

  return { text: null, unparseable: false };
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
  resourceType: 'fetch';
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
 * Run the shared per-rule gate covering every matcher field. Order:
 * urlPattern -> methods -> resourceTypes -> hostname -> queryParams ->
 * requestHeaders -> graphqlOperation. Returns the list of non-URL matcher
 * fields that fired in `matchedBy`, or the first field that failed in
 * `skippedAt`, for downstream debug events.
 */
function gateRule(rule: NetworkRuleMatchers, ctx: MatcherContext): GateResult {
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
  if (outcome.kind === 'no-match') {
    return { proceed: false, outcome, skippedAt: 'graphqlOperation' };
  }
  if (rule.graphqlOperation !== undefined) matchedBy.push('graphqlOperation');

  return { proceed: true, outcome, matchedBy: matchedBy.length > 0 ? matchedBy : undefined };
}

function ruleNeedsParsedUrl(rule: NetworkRuleMatchers): boolean {
  return rule.hostname !== undefined || rule.queryParams !== undefined;
}

function ruleNeedsHeaderView(rule: NetworkRuleMatchers): boolean {
  return rule.requestHeaders !== undefined;
}

function extractFetchHeaders(input: RequestInfo | URL, init?: RequestInit): RequestHeaderView {
  const initHeaders = init?.headers;
  if (initHeaders !== undefined) {
    return createHeaderView(initHeaders);
  }
  if (isRequest(input)) {
    return createHeaderView(input.headers);
  }
  return createHeaderView(undefined);
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

function ruleHasGraphQLConstraint(rule: NetworkRuleMatchers): boolean {
  return rule.graphqlOperation !== undefined;
}

export function patchFetch(originalFetch: typeof globalThis.fetch, config: NetworkConfig, random: () => number, emitter?: ChaosEventEmitter, counters: Map<object, number> = new Map(), groups?: RuleGroupRegistry) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = getFetchUrl(input);
    const method = getFetchMethod(input, init);
    const existingSignal = getFetchSignal(input, init);

    const ruleGroups = [config.failures, config.latencies, config.aborts, config.corruptions, config.cors];
    const anyRulePasses = (predicate: (r: NetworkRuleMatchers) => boolean): boolean => {
      for (const group of ruleGroups) {
        if (group?.some(predicate)) return true;
      }
      return false;
    };

    // Body extraction: only when at least one rule wants GraphQL matching to
    // avoid paying the .clone()/.text() cost on every request.
    const needsGqlExtract = anyRulePasses(ruleHasGraphQLConstraint);
    const needsParsedUrl = anyRulePasses(ruleNeedsParsedUrl);
    const needsHeaderView = anyRulePasses(ruleNeedsHeaderView);

    let gqlExtract: GraphQLExtractResult = { kind: 'not-graphql' };
    if (needsGqlExtract) {
      const body = await readFetchBody(input, init);
      gqlExtract = extractGraphQLOperation(method, url, body.text, body.unparseable);
    }

    let parsedUrlCache: ParsedRequestUrl | null | undefined;
    let headerViewCache: RequestHeaderView | undefined;
    const ctx: MatcherContext = {
      url,
      method,
      resourceType: 'fetch',
      gqlExtract,
      getParsedUrl: () => {
        if (parsedUrlCache === undefined) {
          parsedUrlCache = needsParsedUrl ? parseRequestUrl(url) : null;
        }
        return parsedUrlCache;
      },
      getHeaderView: () => {
        if (headerViewCache === undefined) {
          headerViewCache = needsHeaderView
            ? extractFetchHeaders(input, init)
            : createHeaderView(undefined);
        }
        return headerViewCache;
      },
    };

    // 1. Check for CORS
    if (config.cors) {
      for (const cors of config.cors) {
        emitter?.debug('rule-evaluating', { url, method }, cors);
        const gate = gateRule(cors, ctx);
        if (!gate.proceed) {
          emitter?.debug('rule-skip-match', { url, method, skippedAt: gate.skippedAt }, cors);
          continue;
        }
        emitter?.debug('rule-matched', { url, method, matchedBy: gate.matchedBy }, cors);
        const count = incrementCounter(cors, counters);
        if (!checkCountingCondition(cors, count)) {
          emitter?.debug('rule-skip-counting', { url, method }, cors);
          continue;
        }
        if (!gateGroup(cors, groups, emitter, { url, method })) continue;
        const applied = shouldApplyChaos(cors.probability, random);
        // The `graphql-body-unparseable` diagnostic is intentionally gated on
        // both group and probability so disabled groups / missed rolls do not
        // produce noisy diagnostics for every unparseable body — see the
        // "suppresses graphql-body-unparseable diagnostics" tests in
        // packages/core/test/networkFetch.test.ts.
        if (gate.outcome?.kind === 'unparseable') {
          if (applied) {
            emitGraphQLDiagnostic(emitter, 'network:cors', url, method, {});
          }
          continue;
        }
        emitter?.emit({
          type: 'network:cors',
          timestamp: Date.now(),
          applied,
          detail: { url, method, ...operationDetail(gate.outcome) },
        });
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method }, cors);
          continue;
        }
        emitter?.debug('rule-applied', { url, method }, cors);
        // Mimic a real browser network error with a clean stack trace. The
        // `rule-applied` debug event above already conveys the apply signal;
        // no separate console.debug needed.
        const error = new TypeError('Failed to fetch');
        error.stack = '';
        throw error;
      }
    }

    // 2. Check for Abort
    let selectedAbort: NetworkAbortConfig | null = null;
    let selectedAbortOutcome: GraphQLRuleOutcome | null = null;
    let abortSignal: AbortSignal | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let abortEventSettled = false;

    const settleAbortEvent = (applied: boolean) => {
      if (!selectedAbort || abortEventSettled) {
        return;
      }
      abortEventSettled = true;
      if (abortTimer) {
        clearTimeout(abortTimer);
        abortTimer = undefined;
      }
      emitAbortEvent(emitter, selectedAbort, url, method, applied, selectedAbortOutcome);
    };

    if (config.aborts) {
      for (const abort of config.aborts) {
        emitter?.debug('rule-evaluating', { url, method, timeoutMs: abort.timeout }, abort);
        const gate = gateRule(abort, ctx);
        if (!gate.proceed) {
          emitter?.debug('rule-skip-match', { url, method, timeoutMs: abort.timeout, skippedAt: gate.skippedAt }, abort);
          continue;
        }
        emitter?.debug('rule-matched', { url, method, timeoutMs: abort.timeout, matchedBy: gate.matchedBy }, abort);
        const count = incrementCounter(abort, counters);
        if (!checkCountingCondition(abort, count)) {
          emitter?.debug('rule-skip-counting', { url, method, timeoutMs: abort.timeout }, abort);
          continue;
        }
        if (!gateGroup(abort, groups, emitter, { url, method, timeoutMs: abort.timeout })) continue;
        const applied = shouldApplyChaos(abort.probability, random);
        if (gate.outcome?.kind === 'unparseable') {
          if (applied) {
            emitGraphQLDiagnostic(emitter, 'network:abort', url, method, { timeoutMs: abort.timeout });
          }
          continue;
        }
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, timeoutMs: abort.timeout }, abort);
          emitAbortEvent(emitter, abort, url, method, false, gate.outcome);
          continue;
        }

        emitter?.debug('rule-applied', { url, method, timeoutMs: abort.timeout }, abort);
        console.warn(`CHAOS: Aborting ${method} ${url} after ${abort.timeout || 0}ms`);
        selectedAbort = abort;
        selectedAbortOutcome = gate.outcome;

        const chaosController = new AbortController();
        abortSignal = mergeAbortSignals(chaosController.signal, existingSignal);

        const applyAbort = () => {
          if (abortEventSettled) {
            return;
          }
          settleAbortEvent(true);
          chaosController.abort(createAbortError());
        };

        if (abort.timeout) {
          abortTimer = setTimeout(applyAbort, abort.timeout);
        } else {
          applyAbort();
        }
        break;
      }
    }

    if (selectedAbort) {
      try {
        const response = await originalFetch(input, withSignal(init, abortSignal));
        settleAbortEvent(false);
        return response;
      } catch (error) {
        settleAbortEvent(false);
        throw error;
      }
    }

    // 3. Check for Failures
    if (config.failures) {
      for (const failure of config.failures) {
        emitter?.debug('rule-evaluating', { url, method, statusCode: failure.statusCode }, failure);
        const gate = gateRule(failure, ctx);
        if (!gate.proceed) {
          emitter?.debug('rule-skip-match', { url, method, statusCode: failure.statusCode, skippedAt: gate.skippedAt }, failure);
          continue;
        }
        emitter?.debug('rule-matched', { url, method, statusCode: failure.statusCode, matchedBy: gate.matchedBy }, failure);
        const count = incrementCounter(failure, counters);
        if (!checkCountingCondition(failure, count)) {
          emitter?.debug('rule-skip-counting', { url, method, statusCode: failure.statusCode }, failure);
          continue;
        }
        if (!gateGroup(failure, groups, emitter, { url, method, statusCode: failure.statusCode })) continue;
        const applied = shouldApplyChaos(failure.probability, random);
        if (gate.outcome?.kind === 'unparseable') {
          if (applied) {
            emitGraphQLDiagnostic(emitter, 'network:failure', url, method, { statusCode: failure.statusCode });
          }
          continue;
        }
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
        console.warn(`CHAOS: Forcing ${failure.statusCode} for ${method} ${url}`);
        const body = failure.body ?? JSON.stringify({ error: 'Chaos Maker Attack!' });
        const headers = failure.headers ?? {};
        return new Response(body, {
          status: failure.statusCode,
          statusText: failure.statusText ?? 'Service Unavailable (Chaos)',
          headers,
        });
      }
    }

    // 4. Check for Latency
    if (config.latencies) {
      for (const latency of config.latencies) {
        emitter?.debug('rule-evaluating', { url, method, delayMs: latency.delayMs }, latency);
        const gate = gateRule(latency, ctx);
        if (!gate.proceed) {
          emitter?.debug('rule-skip-match', { url, method, delayMs: latency.delayMs, skippedAt: gate.skippedAt }, latency);
          continue;
        }
        emitter?.debug('rule-matched', { url, method, delayMs: latency.delayMs, matchedBy: gate.matchedBy }, latency);
        const count = incrementCounter(latency, counters);
        if (!checkCountingCondition(latency, count)) {
          emitter?.debug('rule-skip-counting', { url, method, delayMs: latency.delayMs }, latency);
          continue;
        }
        if (!gateGroup(latency, groups, emitter, { url, method, delayMs: latency.delayMs })) continue;
        const applied = shouldApplyChaos(latency.probability, random);
        if (gate.outcome?.kind === 'unparseable') {
          if (applied) {
            emitGraphQLDiagnostic(emitter, 'network:latency', url, method, { delayMs: latency.delayMs });
          }
          continue;
        }
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
        await new Promise(res => setTimeout(res, latency.delayMs));
      }
    }

    // 5. Determine Corruption (applied after fetch)
    let selectedCorruption: NetworkCorruptionConfig | null = null;
    let selectedCorruptionOutcome: GraphQLRuleOutcome | null = null;
    if (config.corruptions) {
      for (const corruption of config.corruptions) {
        emitter?.debug('rule-evaluating', { url, method, strategy: corruption.strategy }, corruption);
        const gate = gateRule(corruption, ctx);
        if (!gate.proceed) {
          emitter?.debug('rule-skip-match', { url, method, strategy: corruption.strategy, skippedAt: gate.skippedAt }, corruption);
          continue;
        }
        emitter?.debug('rule-matched', { url, method, strategy: corruption.strategy, matchedBy: gate.matchedBy }, corruption);
        const count = incrementCounter(corruption, counters);
        if (!checkCountingCondition(corruption, count)) {
          emitter?.debug('rule-skip-counting', { url, method, strategy: corruption.strategy }, corruption);
          continue;
        }
        if (!gateGroup(corruption, groups, emitter, { url, method, strategy: corruption.strategy })) continue;
        const applied = shouldApplyChaos(corruption.probability, random);
        if (gate.outcome?.kind === 'unparseable') {
          if (applied) {
            emitGraphQLDiagnostic(emitter, 'network:corruption', url, method, { strategy: corruption.strategy });
          }
          continue;
        }
        if (!applied) {
          emitter?.debug('rule-skip-probability', { url, method, strategy: corruption.strategy }, corruption);
          emitCorruptionEvent(emitter, corruption, url, method, false, gate.outcome);
          continue;
        }
        emitter?.debug('rule-applied', { url, method, strategy: corruption.strategy }, corruption);
        selectedCorruption = corruption;
        selectedCorruptionOutcome = gate.outcome;
        break; // Apply only one corruption
      }
    }

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      if (selectedCorruption) {
        emitCorruptionEvent(emitter, selectedCorruption, url, method, false, selectedCorruptionOutcome);
      }
      throw error;
    }

    if (!selectedCorruption) {
      return response;
    }

    try {
      console.warn(`CHAOS: Corrupting response for ${method} ${url} with strategy: ${selectedCorruption.strategy}`);
      const text = await response.text();
      const corruptedText = corruptText(text, selectedCorruption.strategy);
      emitCorruptionEvent(emitter, selectedCorruption, url, method, true, selectedCorruptionOutcome);
      return new Response(corruptedText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      emitCorruptionEvent(emitter, selectedCorruption, url, method, false, selectedCorruptionOutcome);
      throw error;
    }
  };
}
