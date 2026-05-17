import { z } from 'zod';
import { ChaosConfigError } from './errors';
import type { ChaosConfig } from './config';
import { PresetRegistry, expandPresets, type PresetConfigSlice } from './presets';
import { ProfileRegistry, applyProfile, type ProfileConfigSlice } from './profiles';
import { formatZodIssue } from './validation-format';
import type {
  CustomValidatorMap,
  RuleType,
  ValidationIssue,
  ValidationIssueCode,
} from './validation-types';
import { checkDeprecations } from './validation-deprecation';
import { collectUnknownPaths, stripUnknownKeys } from './validation-strip';

type Policy = 'strict' | 'passthrough';

function withPolicy<T extends z.ZodRawShape>(
  shape: z.ZodObject<T>,
  policy: Policy,
): z.ZodObject<T> {
  return (policy === 'strict' ? shape.strict() : shape.passthrough()) as z.ZodObject<T>;
}

const probability = z.number().min(0, 'Probability must be >= 0').max(1, 'Probability must be <= 1');

const positiveInt = z.number().int().min(1);

/** Shared counting fields for network chaos rules. At most one may be set. */
const countingFields = {
  onNth: positiveInt.optional(),
  everyNth: positiveInt.optional(),
  afterN: z.number().int().min(0).optional(),
};

/** Optional `group` field shared by every rule type. */
const groupField = {
  group: z.string().trim().min(1, 'group must not be empty').optional(),
};

const mutuallyExclusiveCounting = (data: { onNth?: number; everyNth?: number; afterN?: number }) =>
  [data.onNth, data.everyNth, data.afterN].filter((v) => v !== undefined).length <= 1;

const countingRefinement = [
  mutuallyExclusiveCounting,
  { message: 'Only one of onNth, everyNth, or afterN may be set on a single rule' },
] as const;

const graphqlOperationMatcher = z.union([
  z.string().min(1, 'graphqlOperation must not be empty'),
  z.instanceof(RegExp).refine(
    (re) => !re.global && !re.sticky,
    { message: 'graphqlOperation RegExp must not use global (g) or sticky (y) flags due to lastIndex mutation' },
  ),
]);

const networkMatcherFields = {
  urlPattern: z.string().min(1, 'urlPattern must not be empty'),
  methods: z.array(z.string()).optional(),
  graphqlOperation: graphqlOperationMatcher.optional(),
};

const buildNetworkFailure = (p: Policy) =>
  withPolicy(
    z.object({
      ...networkMatcherFields,
      statusCode: z.number().int().min(100).max(599),
      probability,
      body: z.string().optional(),
      statusText: z.string().optional(),
      headers: z.record(z.string()).optional(),
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildNetworkLatency = (p: Policy) =>
  withPolicy(
    z.object({
      ...networkMatcherFields,
      delayMs: z.number().min(0, 'delayMs must be >= 0'),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildNetworkAbort = (p: Policy) =>
  withPolicy(
    z.object({
      ...networkMatcherFields,
      probability,
      timeout: z.number().min(0, 'timeout must be >= 0').optional(),
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildNetworkCorruption = (p: Policy) =>
  withPolicy(
    z.object({
      ...networkMatcherFields,
      probability,
      strategy: z.enum(['truncate', 'malformed-json', 'empty', 'wrong-type']),
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildNetworkCors = (p: Policy) =>
  withPolicy(
    z.object({
      ...networkMatcherFields,
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildNetworkConfig = (p: Policy) =>
  withPolicy(
    z.object({
      failures: z.array(buildNetworkFailure(p)).optional(),
      latencies: z.array(buildNetworkLatency(p)).optional(),
      aborts: z.array(buildNetworkAbort(p)).optional(),
      corruptions: z.array(buildNetworkCorruption(p)).optional(),
      cors: z.array(buildNetworkCors(p)).optional(),
    }),
    p,
  );

const buildUiAssault = (p: Policy) =>
  withPolicy(
    z.object({
      selector: z.string().min(1, 'selector must not be empty'),
      action: z.enum(['disable', 'hide', 'remove']),
      probability,
      ...groupField,
    }),
    p,
  );

const buildUiConfig = (p: Policy) =>
  withPolicy(
    z.object({
      assaults: z.array(buildUiAssault(p)).optional(),
    }),
    p,
  );

const webSocketDirection = z.enum(['inbound', 'outbound', 'both']);

const buildWsDrop = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      direction: webSocketDirection,
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildWsDelay = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      direction: webSocketDirection,
      delayMs: z.number().min(0, 'delayMs must be >= 0'),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildWsCorrupt = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      direction: webSocketDirection,
      strategy: z.enum(['truncate', 'malformed-json', 'empty', 'wrong-type']),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const webSocketCloseCode = z.number().int().refine(
  (code) => code === 1000 || (code >= 3000 && code <= 4999),
  { message: 'code must be 1000 or in the range 3000-4999' },
);

const webSocketCloseReason = z.string().refine(
  (reason) => new TextEncoder().encode(reason).length <= 123,
  { message: 'reason must be <= 123 UTF-8 bytes' },
);

const buildWsClose = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      code: webSocketCloseCode.optional(),
      reason: webSocketCloseReason.optional(),
      afterMs: z.number().min(0, 'afterMs must be >= 0').optional(),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildWebSocketConfig = (p: Policy) =>
  withPolicy(
    z.object({
      drops: z.array(buildWsDrop(p)).optional(),
      delays: z.array(buildWsDelay(p)).optional(),
      corruptions: z.array(buildWsCorrupt(p)).optional(),
      closes: z.array(buildWsClose(p)).optional(),
    }),
    p,
  );

const sseEventType = z.string().min(1, 'eventType must not be empty');

const buildSseDrop = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      eventType: sseEventType.optional(),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildSseDelay = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      eventType: sseEventType.optional(),
      delayMs: z.number().min(0, 'delayMs must be >= 0'),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildSseCorrupt = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      eventType: sseEventType.optional(),
      strategy: z.enum(['truncate', 'malformed-json', 'empty', 'wrong-type']),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildSseClose = (p: Policy) =>
  withPolicy(
    z.object({
      urlPattern: z.string().min(1, 'urlPattern must not be empty'),
      afterMs: z.number().min(0, 'afterMs must be >= 0').optional(),
      probability,
      ...countingFields,
      ...groupField,
    }),
    p,
  ).refine(...countingRefinement);

const buildSseConfig = (p: Policy) =>
  withPolicy(
    z.object({
      drops: z.array(buildSseDrop(p)).optional(),
      delays: z.array(buildSseDelay(p)).optional(),
      corruptions: z.array(buildSseCorrupt(p)).optional(),
      closes: z.array(buildSseClose(p)).optional(),
    }),
    p,
  );

const buildGroupConfig = (p: Policy) =>
  withPolicy(
    z.object({
      name: z.string().trim().min(1, 'group name must not be empty'),
      enabled: z.boolean().optional(),
    }),
    p,
  );

const buildGroupConfigList = (p: Policy) =>
  z.array(buildGroupConfig(p)).superRefine((groups, ctx) => {
    const seen = new Set<string>();
    for (const [index, group] of groups.entries()) {
      const norm = group.name.trim();
      if (seen.has(norm)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'duplicate group name after normalization',
          path: [index, 'name'],
        });
        continue;
      }
      seen.add(norm);
    }
  });

const buildDebugSchema = (p: Policy) =>
  z.union([
    z.boolean(),
    withPolicy(z.object({ enabled: z.boolean() }), p),
  ]);

const buildSliceSchema = (p: Policy) =>
  withPolicy(
    z.object({
      network: buildNetworkConfig(p).optional(),
      ui: buildUiConfig(p).optional(),
      websocket: buildWebSocketConfig(p).optional(),
      sse: buildSseConfig(p).optional(),
      groups: buildGroupConfigList(p).optional(),
    }),
    p,
  );

const presetNameSchema = z.string().trim().min(1, 'preset name must not be empty');

const profileNameSchema = z.string().trim().min(1, 'profile name must not be empty');

const presetsArraySchema = z.array(presetNameSchema).transform((names) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const norm = n.trim();
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
});

/** Shape of a scenario profile slice OR a runtime override slice. A profile
 *  MAY carry its own `presets[]`, `seed`, `debug`, `groups`, and the four rule
 *  categories. It MAY NOT carry `customPresets`, `customProfiles`, `profile`,
 *  `profileOverrides`, or `schemaVersion` — nested profile chaining is
 *  explicitly out-of-scope and rejected here as unknown keys under strict
 *  policy. */
const buildProfileSliceSchema = (p: Policy) =>
  withPolicy(
    buildSliceSchema(p).extend({
      presets: presetsArraySchema.optional(),
      seed: z.number().int('Seed must be an integer').optional(),
      debug: buildDebugSchema(p).optional(),
    }),
    p,
  );

const buildChaosConfigSchema = (p: Policy) =>
  withPolicy(
    buildSliceSchema(p).extend({
      presets: presetsArraySchema.optional(),
      customPresets: z.record(presetNameSchema, buildSliceSchema(p)).optional(),
      seed: z.number().int('Seed must be an integer').optional(),
      debug: buildDebugSchema(p).optional(),
      schemaVersion: z.literal(1).optional(),
      profile: profileNameSchema.optional(),
      profileOverrides: buildProfileSliceSchema(p).optional(),
      customProfiles: z.record(profileNameSchema, buildProfileSliceSchema(p)).optional(),
    }),
    p,
  );

/** Prebuilt strict variant. Default for `unknownFields: 'reject'` and for the
 *  post-preset-expansion second pass. Built once at module load. Typed as
 *  `z.ZodTypeAny` to keep DTS output tractable; runtime keeps the full
 *  schema graph. */
export const chaosConfigSchemaStrict: z.ZodTypeAny = buildChaosConfigSchema('strict');

/** Prebuilt passthrough variant. Used for `unknownFields: 'warn' | 'ignore'`
 *  before `stripUnknownKeys` projects the result to known keys only. */
export const chaosConfigSchemaPassthrough: z.ZodTypeAny = buildChaosConfigSchema('passthrough');

const chaosConfigSliceSchema = buildSliceSchema('strict');

// DRIFT GUARD — fails to compile if `PresetConfigSlice` gains a top-level
// key the schema doesn't model. SCOPE: top-level category coverage only.
type _SliceKeys = keyof Required<PresetConfigSlice>;
type _SchemaKeys = keyof typeof chaosConfigSliceSchema.shape;
type _Missing = Exclude<_SliceKeys, _SchemaKeys>;
const _sliceSchemaCovers: _Missing extends never ? true : never = true;
void _sliceSchemaCovers;

const chaosProfileSliceSchema = buildProfileSliceSchema('strict');

// DRIFT GUARD — fails to compile if `ProfileConfigSlice` gains a top-level
// key the profile-slice schema doesn't model. Same coverage scope as the
// preset slice guard above.
type _ProfileSliceKeys = keyof Required<ProfileConfigSlice>;
type _ProfileSchemaKeys = keyof typeof chaosProfileSliceSchema.shape;
type _MissingProfile = Exclude<_ProfileSliceKeys, _ProfileSchemaKeys>;
const _profileSliceSchemaCovers: _MissingProfile extends never ? true : never = true;
void _profileSliceSchemaCovers;

// RuleType drift guard (compile-time, no runtime cost). The `satisfies`
// clause enforces every `RuleType` is present; the `keyof typeof ...` lets
// the bidirectional Exclude<...> check catch a stray map key not in the
// `RuleType` union. Adding a new `RuleType` member without adding a schema
// entry (or vice versa) fails compilation in either direction.
const RULE_TYPE_TO_SCHEMA = {
  'network.failure': buildNetworkFailure('strict'),
  'network.latency': buildNetworkLatency('strict'),
  'network.abort': buildNetworkAbort('strict'),
  'network.corruption': buildNetworkCorruption('strict'),
  'network.cors': buildNetworkCors('strict'),
  'ui.assault': buildUiAssault('strict'),
  'websocket.drop': buildWsDrop('strict'),
  'websocket.delay': buildWsDelay('strict'),
  'websocket.corrupt': buildWsCorrupt('strict'),
  'websocket.close': buildWsClose('strict'),
  'sse.drop': buildSseDrop('strict'),
  'sse.delay': buildSseDelay('strict'),
  'sse.corrupt': buildSseCorrupt('strict'),
  'sse.close': buildSseClose('strict'),
  group: buildGroupConfig('strict'),
  preset: chaosConfigSliceSchema,
  profile: chaosProfileSliceSchema,
  'top-level': chaosConfigSchemaStrict,
} satisfies Record<RuleType, z.ZodTypeAny>;
type _MissingFromMap = Exclude<RuleType, keyof typeof RULE_TYPE_TO_SCHEMA>;
type _ExtraInMap = Exclude<keyof typeof RULE_TYPE_TO_SCHEMA, RuleType>;
const _ruleTypeMapCovers:
  [_MissingFromMap, _ExtraInMap] extends [never, never] ? true : never = true;
void _ruleTypeMapCovers;
void RULE_TYPE_TO_SCHEMA;

const RULE_CATEGORY_TO_TYPE: Record<string, Partial<Record<string, RuleType>>> = {
  network: {
    failures: 'network.failure',
    latencies: 'network.latency',
    aborts: 'network.abort',
    corruptions: 'network.corruption',
    cors: 'network.cors',
  },
  ui: { assaults: 'ui.assault' },
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
};

/** Symbol used to brand validated configs across bundle boundaries. */
const VALIDATED_BRAND = Symbol.for('chaos-maker.validated');

/** Bumped whenever the validator's invariants change semantically. Stale
 *  brands fail the strict-equality check inside the short-circuit and re-
 *  validate. Do NOT bump for cosmetic / refactor-only changes. */
export const VALIDATOR_BRAND_VERSION = 1;

function isBrandedAt(input: unknown, version: number): boolean {
  if (!input || typeof input !== 'object') return false;
  return (input as Record<symbol, unknown>)[VALIDATED_BRAND] === version;
}

function stampBrand<T extends object>(value: T, version: number): T {
  Object.defineProperty(value, VALIDATED_BRAND, {
    value: version,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

/** Schema-only validation. Does NOT expand presets and does NOT run the
 *  post-merge re-validation pass. Calling this in a runtime path silently
 *  bypasses preset expansion. For runtime preparation, call
 *  `prepareChaosConfig` (or `validateChaosConfig` for the full structured
 *  pipeline). */
export function validateConfig(config: unknown): ChaosConfig {
  const result = chaosConfigSchemaStrict.safeParse(config);
  if (!result.success) {
    throw new ChaosConfigError(result.error.issues.map(formatZodIssue));
  }
  return result.data as ChaosConfig;
}

export interface PrepareChaosConfigOptions {
  unknownFields?: 'reject' | 'warn' | 'ignore';
}

/** Canonical runtime preparation entry point for a `ChaosConfig`.
 *
 *  Composes:
 *    1. Zod pass 1 (strict OR passthrough+strip per `opts.unknownFields`).
 *    2. Build per-instance `ProfileRegistry`, register `customProfiles`,
 *       resolve `profile` + `profileOverrides` into a flat config (strips
 *       all three profile fields).
 *    3. Build per-instance `PresetRegistry`, register `customPresets`.
 *    4. `expandPresets` — append rule arrays + groups, strip preset fields.
 *    5. Zod pass 2 (strict, on the merged config).
 *
 *  v0.4.x callers pass no opts and get strict-by-default behavior identical
 *  to before. Configs that omit profile-related fields skip the new
 *  resolution layer entirely (single fast-path `cloneValue` no-op). */
export function prepareChaosConfig(
  input: unknown,
  opts: PrepareChaosConfigOptions = {},
): ChaosConfig {
  const policy: 'reject' | 'warn' | 'ignore' = opts.unknownFields ?? 'reject';
  const schema = policy === 'reject' ? chaosConfigSchemaStrict : chaosConfigSchemaPassthrough;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ChaosConfigError(parsed.error.issues.map(formatZodIssue));
  }
  let validated = parsed.data as ChaosConfig;

  if (policy === 'warn' || policy === 'ignore') {
    if (policy === 'warn') {
      const unknownPaths = collectUnknownPaths(input);
      if (unknownPaths.length > 0) {
        try {
          console.warn(
            `[chaos-maker] unknown config fields ignored: ${unknownPaths.join(', ')}`,
          );
        } catch {
          /* console may be unavailable */
        }
      }
    }
    validated = stripUnknownKeys(validated);
  }

  let profileResolved: ChaosConfig;
  try {
    const profileRegistry = new ProfileRegistry();
    profileRegistry.registerAll(validated.customProfiles);
    profileResolved = applyProfile(validated, profileRegistry);
  } catch (e) {
    if (e instanceof ChaosConfigError) throw e;
    const msg = (e as Error).message;
    let code: ValidationIssueCode = 'custom';
    if (msg.includes('is not registered')) code = 'unknown_profile';
    else if (msg.includes('already registered')) code = 'profile_collision';
    else if (msg.includes('may not contain')) code = 'profile_chain';
    // Registration collisions originate from ProfileRegistry.registerAll over
    // customProfiles, so the error path is the offending customProfiles entry.
    // applyProfile-origin errors (unknown_profile / profile_chain) stay
    // attributed to the field that triggered resolution.
    let path: string;
    if (code === 'profile_collision') {
      const match = msg.match(/profile '([^']+)' already registered/);
      path = match ? `customProfiles.${match[1]}` : 'customProfiles';
    } else if (validated.profile !== undefined) {
      path = 'profile';
    } else {
      path = 'profileOverrides';
    }
    throw new ChaosConfigError([{
      path,
      code,
      ruleType: 'profile',
      message: msg,
    }]);
  }

  let expanded: ChaosConfig;
  try {
    const registry = new PresetRegistry();
    registry.registerAll(profileResolved.customPresets);
    expanded = expandPresets(profileResolved, registry);
  } catch (e) {
    if (e instanceof ChaosConfigError) throw e;
    const msg = (e as Error).message;
    let code: ValidationIssueCode = 'custom';
    if (msg.includes('not registered')) code = 'unknown_preset';
    else if (msg.includes('already registered')) code = 'preset_collision';
    throw new ChaosConfigError([{
      path: 'presets',
      code,
      ruleType: 'preset',
      message: msg,
    }]);
  }

  return validateConfig(expanded);
}

export interface ValidateChaosConfigOptions {
  unknownFields?: 'reject' | 'warn' | 'ignore';
  onDeprecation?: (issue: ValidationIssue) => void;
  customValidators?: CustomValidatorMap;
}

function runCustomValidators(
  config: ChaosConfig,
  validators: CustomValidatorMap,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const callValidator = (
    ruleType: RuleType,
    rule: unknown,
    path: string,
  ) => {
    const fn = validators[ruleType];
    if (!fn) return;
    let result: ValidationIssue[] | void;
    try {
      result = fn(rule, { ruleType, path });
    } catch (e) {
      issues.push({
        path,
        code: 'custom',
        ruleType,
        message: `customValidator threw: ${(e as Error).message}`,
      });
      return;
    }
    if (Array.isArray(result)) issues.push(...result);
  };

  for (const [cat, sub] of Object.entries(RULE_CATEGORY_TO_TYPE)) {
    const catCfg = (config as Record<string, unknown>)[cat] as
      | Record<string, unknown[]>
      | undefined;
    if (!catCfg) continue;
    for (const [arrKey, ruleType] of Object.entries(sub)) {
      if (!ruleType) continue;
      const arr = catCfg[arrKey];
      if (!Array.isArray(arr)) continue;
      arr.forEach((rule, idx) => {
        callValidator(ruleType, rule, `${cat}.${arrKey}[${idx}]`);
      });
    }
  }

  if (Array.isArray(config.groups)) {
    config.groups.forEach((group, idx) => {
      callValidator('group', group, `groups[${idx}]`);
    });
  }

  if (validators['top-level']) {
    callValidator('top-level', config, '');
  }

  return issues;
}

/** Canonical validation entry point for adapters and the engine.
 *
 *  Pipeline:
 *    1. Schema-version gate (BEFORE Zod, unambiguous message).
 *    2. Brand short-circuit (only when brand-version matches AND opts empty).
 *    3-5. `prepareChaosConfig` — Zod pass 1 + preset expansion + Zod pass 2.
 *    6. Deprecation walk.
 *    7. Custom validators.
 *    8. Issue sort (inside ChaosConfigError construction).
 *    9. Brand stamp — final step only.
 *
 *  Throws `ChaosConfigError` aggregating all issues from the first failing
 *  layer. Subsequent layers are skipped on failure. */
export function validateChaosConfig(
  input: unknown,
  opts: ValidateChaosConfigOptions = {},
): ChaosConfig {
  if (typeof input === 'object' && input !== null) {
    const v = (input as { schemaVersion?: unknown }).schemaVersion;
    if (v !== undefined && v !== 1) {
      throw new ChaosConfigError([{
        path: 'schemaVersion',
        code: 'unknown_schema_version',
        ruleType: 'top-level',
        message: `unsupported schemaVersion: ${JSON.stringify(v)} (this build supports 1)`,
        expected: '1',
        received: JSON.stringify(v),
      }]);
    }
  }

  const optsEmpty =
    !opts.unknownFields && !opts.onDeprecation && !opts.customValidators;
  if (optsEmpty && isBrandedAt(input, VALIDATOR_BRAND_VERSION)) {
    return input as ChaosConfig;
  }

  const validated = prepareChaosConfig(input, { unknownFields: opts.unknownFields });

  checkDeprecations(validated, opts.onDeprecation);

  if (opts.customValidators) {
    const customIssues = runCustomValidators(validated, opts.customValidators);
    if (customIssues.length > 0) throw new ChaosConfigError(customIssues);
  }

  return stampBrand(validated, VALIDATOR_BRAND_VERSION);
}
