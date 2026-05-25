import type { GraphQLOperationMatcher } from './config';

/** Result of attempting to extract a GraphQL operation from a request. */
export type GraphQLExtractResult =
  | { kind: 'not-graphql' }
  | { kind: 'extracted'; operationName: string | null }
  | { kind: 'unparseable' };

/**
 * Pull the operation name out of a GraphQL `query` string without bringing in
 * a full GraphQL parser. Matches the first `query|mutation|subscription`
 * keyword followed by an identifier  -  the spec form for named operations.
 * Anonymous operations (`query { … }`) return `null`.
 */
export function parseOperationFromQueryString(query: string): string | null {
  // Strip GraphQL line comments (`# ...` to end-of-line) before matching so
  // commented-out operation-like text doesn't false-match, and named
  // operations split across comment lines (`query # note\nGetUser`) still do.
  const withoutComments = query.replace(/#[^\r\n]*/g, ' ');
  const match = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(withoutComments);
  return match?.[1] ?? null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function operationNameFromJsonShape(parsed: unknown): { isGraphQL: boolean; operationName: string | null } {
  if (!parsed || typeof parsed !== 'object') return { isGraphQL: false, operationName: null };
  // GraphQL-over-HTTP also accepts a JSON array (batched requests). Treat the
  // first entry as the operation for matcher purposes  -  chaos applies to the
  // whole HTTP request anyway.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { isGraphQL: false, operationName: null };
    return operationNameFromJsonShape(parsed[0]);
  }
  const obj = parsed as { query?: unknown; operationName?: unknown };
  const hasQuery = typeof obj.query === 'string';
  const hasOpName = typeof obj.operationName === 'string';
  if (!hasQuery && !hasOpName) return { isGraphQL: false, operationName: null };
  if (hasOpName && (obj.operationName as string).length > 0) {
    return { isGraphQL: true, operationName: obj.operationName as string };
  }
  if (hasQuery) {
    return { isGraphQL: true, operationName: parseOperationFromQueryString(obj.query as string) };
  }
  return { isGraphQL: true, operationName: null };
}

function extractFromUrl(url: string): GraphQLExtractResult {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://_chaos-maker.invalid');
  } catch {
    return { kind: 'not-graphql' };
  }
  const opName = parsed.searchParams.get('operationName');
  const query = parsed.searchParams.get('query');
  if (opName && opName.length > 0) {
    return { kind: 'extracted', operationName: opName };
  }
  if (query && query.length > 0) {
    return { kind: 'extracted', operationName: parseOperationFromQueryString(query) };
  }
  return { kind: 'not-graphql' };
}

/**
 * Identify a request as GraphQL and extract its operation name.
 *
 * - `kind: 'extracted'`  -  request is GraphQL; `operationName` may be `null`
 *   for anonymous operations.
 * - `kind: 'not-graphql'`  -  not a GraphQL request (no body, wrong shape).
 * - `kind: 'unparseable'`  -  looks like it could be GraphQL but the body is in
 *   a form we can't read (multipart upload, ReadableStream, binary). Callers
 *   that have a `graphqlOperation` matcher must skip the rule and emit a
 *   diagnostic event so the user can debug why their rule isn't firing.
 */
export function extractGraphQLOperation(
  method: string,
  url: string,
  bodyText: string | null,
  bodyUnparseable: boolean,
): GraphQLExtractResult {
  const upper = method.toUpperCase();
  if (upper === 'POST') {
    if (bodyText !== null) {
      const parsed = tryParseJson(bodyText);
      if (parsed === undefined) return { kind: 'not-graphql' };
      const { isGraphQL, operationName } = operationNameFromJsonShape(parsed);
      return isGraphQL ? { kind: 'extracted', operationName } : { kind: 'not-graphql' };
    }
    if (bodyUnparseable) return { kind: 'unparseable' };
    return { kind: 'not-graphql' };
  }
  if (upper === 'GET') {
    return extractFromUrl(url);
  }
  return { kind: 'not-graphql' };
}

/** Decide whether a rule's `graphqlOperation` matcher accepts the extracted name.
 *
 *  Defensive `lastIndex` reset: validation rejects `/g` and `/y` flags up-front,
 *  but matchers can also be constructed dynamically (in-page, after deserialization),
 *  so reset here too  -  `RegExp.test()` mutates `lastIndex` for stateful flags
 *  and would flap match outcomes across consecutive calls with the same instance.
 */
export function operationNameMatches(matcher: GraphQLOperationMatcher, operationName: string | null): boolean {
  if (operationName === null) return false;
  if (typeof matcher === 'string') return matcher === operationName;
  if (matcher.global || matcher.sticky) {
    matcher.lastIndex = 0;
  }
  return matcher.test(operationName);
}

/** Outcome of evaluating a rule's `graphqlOperation` matcher against a request. */
export type GraphQLRuleOutcome =
  | { kind: 'skip-no-constraint'; operationName: string | null } // no matcher; pass through, surface op name if known
  | { kind: 'match'; operationName: string | null }              // matcher passed
  | { kind: 'no-match' }                                          // matcher failed silently
  | { kind: 'unparseable' };                                      // diagnostic-worthy: body unreadable

/**
 * Evaluate a rule's `graphqlOperation` matcher against the cached extraction.
 * `extract` is computed once per request and reused across all rules.
 */
export function evaluateGraphQLRule(
  matcher: GraphQLOperationMatcher | undefined,
  extract: GraphQLExtractResult,
): GraphQLRuleOutcome {
  if (!matcher) {
    if (extract.kind === 'extracted') return { kind: 'skip-no-constraint', operationName: extract.operationName };
    return { kind: 'skip-no-constraint', operationName: null };
  }
  if (extract.kind === 'not-graphql') return { kind: 'no-match' };
  if (extract.kind === 'unparseable') return { kind: 'unparseable' };
  if (operationNameMatches(matcher, extract.operationName)) {
    return { kind: 'match', operationName: extract.operationName };
  }
  return { kind: 'no-match' };
}
