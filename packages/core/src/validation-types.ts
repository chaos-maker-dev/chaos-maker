/** Public types for the structured validation surface.
 *  Pure types — no runtime. Imported by `errors.ts`, `validation.ts`, and the
 *  format / strip / deprecation helpers. */

export type RuleType =
  | 'network.failure'
  | 'network.latency'
  | 'network.abort'
  | 'network.corruption'
  | 'network.cors'
  | 'ui.assault'
  | 'websocket.drop'
  | 'websocket.delay'
  | 'websocket.corrupt'
  | 'websocket.close'
  | 'sse.drop'
  | 'sse.delay'
  | 'sse.corrupt'
  | 'sse.close'
  | 'group'
  | 'preset'
  | 'profile'
  | 'top-level';

export type ValidationIssueCode =
  | 'unknown_field'
  | 'missing_field'
  | 'invalid_type'
  | 'value_too_small'
  | 'value_too_large'
  | 'invalid_enum'
  | 'invalid_string'
  | 'invalid_regex'
  | 'mutually_exclusive'
  | 'duplicate'
  | 'unknown_preset'
  | 'preset_chain'
  | 'preset_collision'
  | 'unknown_profile'
  | 'profile_chain'
  | 'profile_collision'
  | 'unknown_schema_version'
  | 'deprecated'
  | 'custom'
  | 'legacy';

export interface ValidationIssue {
  /** Dot-notation path: 'network.failures[0].statusCode'. Empty string for top-level. */
  path: string;
  code: ValidationIssueCode;
  ruleType: RuleType;
  message: string;
  /** JSON-stringifiable. e.g. 'number 0..1', "'truncate'|'malformed-json'|...". */
  expected?: string;
  /** Received value via JSON.stringify (clipped to 80 chars). */
  received?: string;
}

/** Custom validator hook. Rule passed by reference as `unknown`; callers
 *  narrow via type guards. Concrete `Readonly<NetworkFailureConfig>`-style
 *  typings per rule type are deferred post-v0.5.0.
 *
 *  Mutation of the rule arg is undefined behavior. The engine deep-clones
 *  the canonical config at expansion time, so mutations made here may be
 *  observable on the validator's input but not by the running engine. */
export type CustomRuleValidator = (
  rule: unknown,
  ctx: Readonly<{ ruleType: RuleType; path: string }>,
) => ValidationIssue[] | void;

export type CustomValidatorMap = Readonly<Partial<Record<RuleType, CustomRuleValidator>>>;

export interface DeprecationEntry {
  since: string;
  replacement?: string;
  removeIn?: string;
  message: string;
}
