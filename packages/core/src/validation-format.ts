import type { ZodIssue } from 'zod';
import { z } from 'zod';
import type { RuleType, ValidationIssue, ValidationIssueCode } from './validation-types';

const RULE_TYPE_BY_CATEGORY_KEY: Record<string, Partial<Record<string, RuleType>>> = {
  network: {
    failures: 'network.failure',
    latencies: 'network.latency',
    aborts: 'network.abort',
    corruptions: 'network.corruption',
    cors: 'network.cors',
  },
  ui: {
    assaults: 'ui.assault',
  },
  websocket: {
    drops: 'websocket.drop',
    delays: 'websocket.delay',
    corruptions: 'websocket.corrupt',
    closes: 'websocket.close',
  },
  sse: {
    drops: 'sse.drop',
    delays: 'sse.delay',
    corruptions: 'sse.corrupt',
    closes: 'sse.close',
  },
  fetchStream: {
    drops: 'fetch-stream.drop',
    delays: 'fetch-stream.delay',
    corruptions: 'fetch-stream.corrupt',
    closes: 'fetch-stream.close',
  },
};

const PROFILE_PATH_PREFIXES = new Set(['profile', 'profileOverrides', 'customProfiles']);

function deriveRuleType(path: ReadonlyArray<string | number>): RuleType {
  if (path.length === 0) return 'top-level';
  const first = path[0];
  if (first === 'groups') return 'group';
  if (first === 'presets' || first === 'customPresets') return 'preset';
  if (first === 'matchers') return 'matcher';
  if (first === 'ai') return 'ai';
  if (first === 'userInteraction') return 'user-interaction';

  // Issues under a profile-related top-level field. Walk past the slice
  // anchor and derive the inner rule type so a `network.failures[0]` under
  // `profileOverrides` or `customProfiles.<name>` still surfaces as
  // `network.failure` rather than collapsing to `top-level`.
  if (typeof first === 'string' && PROFILE_PATH_PREFIXES.has(first)) {
    if (first === 'profile') return 'profile';
    const sliceStart = first === 'customProfiles' ? 2 : 1;
    if (path.length <= sliceStart) return 'profile';
    const sliceFirst = path[sliceStart];
    if (sliceFirst === 'groups') return 'group';
    if (sliceFirst === 'presets') return 'preset';
    if (typeof sliceFirst === 'string') {
      const sub = RULE_TYPE_BY_CATEGORY_KEY[sliceFirst];
      if (sub && typeof path[sliceStart + 1] === 'string') {
        const mapped = sub[path[sliceStart + 1] as string];
        if (mapped) return mapped;
      }
    }
    return 'profile';
  }

  if (typeof first === 'string') {
    const sub = RULE_TYPE_BY_CATEGORY_KEY[first];
    if (sub && typeof path[1] === 'string') {
      const mapped = sub[path[1] as string];
      if (mapped) return mapped;
    }
  }
  return 'top-level';
}

function pathToDotNotation(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += out.length === 0 ? seg : `.${seg}`;
    }
  }
  return out;
}

function clip(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    if (value === undefined) return 'undefined';
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
}

function mapZodCode(issue: ZodIssue): ValidationIssueCode {
  switch (issue.code) {
    case z.ZodIssueCode.unrecognized_keys:
      return 'unknown_field';
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return 'missing_field';
      return 'invalid_type';
    case z.ZodIssueCode.too_small:
      return 'value_too_small';
    case z.ZodIssueCode.too_big:
      return 'value_too_large';
    case z.ZodIssueCode.invalid_enum_value:
      return 'invalid_enum';
    case z.ZodIssueCode.invalid_string:
      return 'invalid_string';
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return 'invalid_type';
    case z.ZodIssueCode.custom: {
      const msg = issue.message.toLowerCase();
      if (msg.includes('mutually exclusive') || msg.includes('only one of')) return 'mutually_exclusive';
      if (msg.includes('duplicate')) return 'duplicate';
      if (msg.includes('regexp') || msg.includes('flag')) return 'invalid_regex';
      if (msg.includes('nested profile chaining')) return 'profile_chain';
      if (
        msg.includes('matcher reference cannot be combined') ||
        msg.includes('matcher and inline fields') ||
        msg.includes('rule must set either matcher reference')
      ) return 'matcher_inline_conflict';
      if (msg.includes('references another matcher')) return 'matcher_cycle';
      return 'custom';
    }
    default:
      return 'custom';
  }
}

function extractExpected(issue: ZodIssue): string | undefined {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.expected;
    case z.ZodIssueCode.too_small:
      if (issue.type === 'number') return `>= ${issue.minimum}`;
      if (issue.type === 'string') return `length >= ${issue.minimum}`;
      if (issue.type === 'array') return `length >= ${issue.minimum}`;
      return `>= ${issue.minimum}`;
    case z.ZodIssueCode.too_big:
      if (issue.type === 'number') return `<= ${issue.maximum}`;
      if (issue.type === 'string') return `length <= ${issue.maximum}`;
      if (issue.type === 'array') return `length <= ${issue.maximum}`;
      return `<= ${issue.maximum}`;
    case z.ZodIssueCode.invalid_enum_value:
      return issue.options.map((o) => JSON.stringify(o)).join('|');
    case z.ZodIssueCode.unrecognized_keys:
      return 'no extra keys';
    default:
      return undefined;
  }
}

function extractReceived(issue: ZodIssue): string | undefined {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    return issue.received;
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return clip(safeStringify(issue.received));
  }
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return clip(issue.keys.map((k) => JSON.stringify(k)).join(', '));
  }
  return undefined;
}

export function formatZodIssue(issue: ZodIssue): ValidationIssue {
  return {
    path: pathToDotNotation(issue.path),
    code: mapZodCode(issue),
    ruleType: deriveRuleType(issue.path),
    message: issue.message,
    expected: extractExpected(issue),
    received: extractReceived(issue),
  };
}

export interface RenderOptions {
  maxIssues?: number;
}

/** Deterministic sort: lex on path, then lex on code. Pure (returns a new
 *  array). Modern `Array#sort` is stable so equal pairs preserve input order. */
export function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    return 0;
  });
}

export function renderValidationIssues(
  issues: ValidationIssue[],
  opts: RenderOptions = {},
): string {
  const cap = opts.maxIssues ?? 50;
  const visible = issues.slice(0, cap);
  const overflow = Math.max(0, issues.length - cap);
  const lines = visible.map((i) => {
    let line = `[${i.ruleType}] ${i.path || '<root>'} (${i.code}): ${i.message}`;
    if (i.expected !== undefined) line += `, expected ${i.expected}`;
    if (i.received !== undefined) line += `, received ${i.received}`;
    return line;
  });
  if (overflow > 0) lines.push(`... and ${overflow} more`);
  return `Invalid ChaosConfig:\n${lines.map((l) => `  - ${l}`).join('\n')}`;
}
