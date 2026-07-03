import type { AiConfig, ChaosConfig } from './config';
import { compileAiToRules } from './ai';
import { cloneValue } from './utils';

/** ChaosConfig slice a preset is allowed to carry. Auto-includes any new
 *  rule category added to ChaosConfig  -  the `Omit` is bounded to fields that
 *  are explicitly forbidden inside a preset: `presets`, `customPresets`,
 *  `seed`, `debug`, `schemaVersion`, plus the v0.7.0 profile coordination
 *  fields (`profile`, `profileOverrides`, `customProfiles`). Profile-related
 *  fields are top-level only; preset slices may not chain them. */
export type PresetConfigSlice = Omit<
  ChaosConfig,
  | 'presets'
  | 'customPresets'
  | 'seed'
  | 'debug'
  | 'schemaVersion'
  | 'profile'
  | 'profileOverrides'
  | 'customProfiles'
  | 'matchers'
  // `ai` is a top-level compiler shorthand that expands into transport rules.
  // Presets carry the already-compiled transport rules directly, so the
  // mental model for composition stays "rules in, rules out". Schemas reject
  // preset slices that try to nest `ai`.
  | 'ai'
>;

/** A named preset packaged for registry registration. */
export interface Preset {
  readonly name: string;
  readonly config: PresetConfigSlice;
}

const MATCH_ALL_URLS = '*';

// Hard-coded shared configs so reading the file shows what every preset does
// and which kebab name resolves to which config. Aliases below register the
// SAME object identity, so `registry.get('slow-api') === presets.slowNetwork`.
const SLOW_NETWORK: PresetConfigSlice = {
  network: {
    latencies: [{ urlPattern: MATCH_ALL_URLS, delayMs: 2000, probability: 1.0 }],
  },
};

const FLAKY_CONNECTION: PresetConfigSlice = {
  network: {
    aborts: [{ urlPattern: MATCH_ALL_URLS, probability: 0.05 }],
    latencies: [{ urlPattern: MATCH_ALL_URLS, delayMs: 3000, probability: 0.1 }],
  },
};

const OFFLINE_MODE: PresetConfigSlice = {
  network: {
    cors: [{ urlPattern: MATCH_ALL_URLS, probability: 1.0 }],
  },
};

const UNSTABLE_API: PresetConfigSlice = {
  network: {
    failures: [{ urlPattern: '/api/', statusCode: 500, probability: 0.1 }],
    latencies: [{ urlPattern: '/api/', delayMs: 1000, probability: 0.2 }],
  },
};

const DEGRADED_UI: PresetConfigSlice = {
  ui: {
    assaults: [
      { selector: 'button', action: 'disable', probability: 0.2 },
      { selector: 'a', action: 'hide', probability: 0.1 },
    ],
  },
};

const UNRELIABLE_WEBSOCKET: PresetConfigSlice = {
  websocket: {
    drops: [{ urlPattern: MATCH_ALL_URLS, direction: 'both', probability: 0.1 }],
    delays: [{ urlPattern: MATCH_ALL_URLS, direction: 'inbound', delayMs: 500, probability: 1.0 }],
    corruptions: [{ urlPattern: MATCH_ALL_URLS, direction: 'inbound', strategy: 'truncate', probability: 0.05 }],
  },
};

const UNRELIABLE_EVENT_STREAM: PresetConfigSlice = {
  sse: {
    drops: [{ urlPattern: MATCH_ALL_URLS, probability: 0.05 }],
    delays: [{ urlPattern: MATCH_ALL_URLS, delayMs: 200, probability: 1.0 }],
    closes: [{ urlPattern: MATCH_ALL_URLS, probability: 0.02, afterMs: 2000 }],
  },
};

const MOBILE_3G: PresetConfigSlice = {
  network: {
    latencies: [{ urlPattern: MATCH_ALL_URLS, delayMs: 1500, probability: 1.0 }],
    aborts: [{ urlPattern: MATCH_ALL_URLS, probability: 0.02 }],
  },
};

const CHECKOUT_DEGRADED: PresetConfigSlice = {
  network: {
    latencies: [{ urlPattern: '/checkout', delayMs: 800, probability: 0.3 }],
    failures: [
      { urlPattern: '/checkout', statusCode: 503, probability: 0.05 },
      { urlPattern: '/api/payments', statusCode: 500, probability: 0.1 },
    ],
  },
};

/** Derive a preset slice by running an `ai` shorthand through the SAME
 *  compiler `prepareChaosConfig` uses. The returned slice carries the
 *  compiled transport rules (fetchStream + sse + websocket for the default
 *  `'auto'` transport), so a preset built here can never drift from what the
 *  equivalent top-level `ai: {...}` config produces at runtime. */
function sliceFromAiDsl(ai: AiConfig): PresetConfigSlice {
  return compileAiToRules({ ai: { ...ai } }) as PresetConfigSlice;
}

// AI streaming presets. Names read like the production incident they
// reproduce. Derived slices go through `sliceFromAiDsl`; hand-authored slices
// use primitives the `ai` shorthand cannot express yet.
const AI_SLOW_FIRST_CHUNK = sliceFromAiDsl({ firstChunkDelayMs: 3000 });

const AI_STREAM_TRUNCATED = sliceFromAiDsl({ truncateAfterChunk: 20 });

const AI_STREAM_PAUSED = sliceFromAiDsl({ pauseAfterChunk: 10, pauseDurationMs: 5000 });

// Corrupts only chunks that carry a tool/function-call wire marker (OpenAI
// `tool_calls` / legacy `function_call`, Anthropic `tool_use`), so prose
// chunks render normally while the structured payload breaks mid-stream.
const AI_TOOL_CALL_FAILS: PresetConfigSlice = {
  fetchStream: {
    corruptions: [
      {
        urlPattern: MATCH_ALL_URLS,
        chunkPattern: /"(tool_calls|tool_use|function_call)"/,
        strategy: 'malformed-json',
        probability: 1.0,
        phase: 'ai:tool-call-failed',
      },
    ],
  },
};

// 429 on the first two matching requests, success from the third onward.
// Exercises client backoff/retry paths the way provider rate limiting does.
// A single firstN rule, NOT two onNth rules: failure evaluation stops at the
// first applied rule per request, so a second onNth rule's counter would not
// advance on requests the first rule already failed.
const AI_RETRY_LOOP: PresetConfigSlice = {
  network: {
    failures: [{ urlPattern: MATCH_ALL_URLS, statusCode: 429, probability: 1.0, firstN: 2 }],
  },
};

// Cuts the stream shortly after it starts (fetch streams by chunk count, SSE
// by wall clock) so tests can assert the app reconnects or resumes cleanly.
const AI_RECONNECT_AFTER_DROP: PresetConfigSlice = {
  fetchStream: {
    closes: [{ urlPattern: MATCH_ALL_URLS, afterChunk: 5, probability: 1.0 }],
  },
  sse: {
    closes: [{ urlPattern: MATCH_ALL_URLS, afterMs: 3000, probability: 1.0 }],
  },
};

// User backgrounds the app mid-generation: the tab reports hidden for 3s
// while the connection drops shortly after (fetch streams by chunk count,
// SSE by wall clock). Tests assert the app pauses on visibilitychange and
// recovers the interrupted stream when the tab returns.
const AI_MOBILE_INTERRUPT: PresetConfigSlice = {
  userInteraction: {
    tabHidden: { afterMs: 1000, durationMs: 3000 },
  },
  fetchStream: {
    closes: [{ urlPattern: MATCH_ALL_URLS, afterChunk: 10, probability: 1.0 }],
  },
  sse: {
    closes: [{ urlPattern: MATCH_ALL_URLS, afterMs: 4000, probability: 1.0 }],
  },
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// Built-in slices are immutable. Mutating `registry.get('slow-api').network!
// .latencies![0].delayMs = 1` is a no-op in sloppy mode and throws in strict
// mode. Custom presets passed via `customPresets` are NOT frozen  -  users keep
// ownership of their literals; the engine deep-clones them at expansion time.
[
  SLOW_NETWORK,
  FLAKY_CONNECTION,
  OFFLINE_MODE,
  UNSTABLE_API,
  DEGRADED_UI,
  UNRELIABLE_WEBSOCKET,
  UNRELIABLE_EVENT_STREAM,
  MOBILE_3G,
  CHECKOUT_DEGRADED,
  AI_SLOW_FIRST_CHUNK,
  AI_STREAM_TRUNCATED,
  AI_STREAM_PAUSED,
  AI_TOOL_CALL_FAILS,
  AI_RETRY_LOOP,
  AI_RECONNECT_AFTER_DROP,
  AI_MOBILE_INTERRUPT,
].forEach(deepFreeze);

/** All built-in presets including kebab aliases.
 *  Aliases are EXTRA registry entries pointing at the SAME config object
 *  identity as the camelCase entry  -  so
 *  `registry.get('slow-api') === presets.slowNetwork`.
 *
 *  Both the array AND each `{ name, config }` descriptor are frozen so that
 *  `BUILT_IN_PRESETS[0].name = 'x'` or `BUILT_IN_PRESETS[0].config = {}` cannot
 *  poison future `PresetRegistry` constructions. Configs are already deep-
 *  frozen above, so the descriptor freeze is the missing layer. */
export const BUILT_IN_PRESETS: ReadonlyArray<Preset> = Object.freeze(
  ([
    { name: 'unstableApi',           config: UNSTABLE_API },
    { name: 'slowNetwork',           config: SLOW_NETWORK },
    { name: 'offlineMode',           config: OFFLINE_MODE },
    { name: 'flakyConnection',       config: FLAKY_CONNECTION },
    { name: 'degradedUi',            config: DEGRADED_UI },
    { name: 'unreliableWebSocket',   config: UNRELIABLE_WEBSOCKET },
    { name: 'unreliableEventStream', config: UNRELIABLE_EVENT_STREAM },
    { name: 'mobileThreeG',          config: MOBILE_3G },
    { name: 'checkoutDegraded',      config: CHECKOUT_DEGRADED },
    { name: 'aiSlowFirstChunk',      config: AI_SLOW_FIRST_CHUNK },
    { name: 'aiStreamTruncated',     config: AI_STREAM_TRUNCATED },
    { name: 'aiStreamPaused',        config: AI_STREAM_PAUSED },
    { name: 'aiToolCallFails',       config: AI_TOOL_CALL_FAILS },
    { name: 'aiRetryLoop',           config: AI_RETRY_LOOP },
    { name: 'aiReconnectAfterDrop',  config: AI_RECONNECT_AFTER_DROP },
    { name: 'aiMobileInterrupt',     config: AI_MOBILE_INTERRUPT },
    { name: 'slow-api',              config: SLOW_NETWORK },
    { name: 'flaky-api',             config: FLAKY_CONNECTION },
    { name: 'api-flaky',             config: FLAKY_CONNECTION },
    { name: 'offline-mode',          config: OFFLINE_MODE },
    { name: 'high-latency',          config: UNSTABLE_API },
    { name: 'websocket-instability', config: UNRELIABLE_WEBSOCKET },
    { name: 'realtime-lag',          config: UNRELIABLE_EVENT_STREAM },
    { name: 'mobile-3g',             config: MOBILE_3G },
    { name: 'checkout-degraded',     config: CHECKOUT_DEGRADED },
    { name: 'ai-slow-first-chunk',   config: AI_SLOW_FIRST_CHUNK },
    { name: 'ai-stream-truncated',   config: AI_STREAM_TRUNCATED },
    { name: 'ai-stream-paused',      config: AI_STREAM_PAUSED },
    { name: 'ai-tool-call-fails',    config: AI_TOOL_CALL_FAILS },
    { name: 'ai-retry-loop',         config: AI_RETRY_LOOP },
    { name: 'ai-reconnect-after-drop', config: AI_RECONNECT_AFTER_DROP },
    { name: 'ai-mobile-interrupt',   config: AI_MOBILE_INTERRUPT },
  ] as Preset[]).map((p) => Object.freeze(p)),
);

function normalizePresetName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('[chaos-maker] preset name cannot be empty');
  return trimmed;
}

/** Per-instance registry of presets. Constructor seeds the built-ins
 *  by default; pass an empty iterable to start from scratch. The slice shape
 *  is type-enforced for built-ins and Zod-validated for `customPresets`, so
 *  `register` does not re-check structure. */
export class PresetRegistry {
  private map = new Map<string, PresetConfigSlice>();

  constructor(initial: Iterable<Preset> = BUILT_IN_PRESETS) {
    for (const p of initial) this.register(p);
  }

  register(preset: Preset): void {
    const name = normalizePresetName(preset.name);
    if (this.map.has(name)) {
      throw new Error(`[chaos-maker] preset '${name}' already registered`);
    }
    this.map.set(name, preset.config);
  }

  registerAll(entries: Record<string, PresetConfigSlice> | undefined): void {
    if (!entries) return;
    for (const [name, config] of Object.entries(entries)) {
      this.register({ name, config });
    }
  }

  has(name: string): boolean {
    return this.map.has(normalizePresetName(name));
  }

  get(name: string): PresetConfigSlice {
    const norm = normalizePresetName(name);
    const cfg = this.map.get(norm);
    if (!cfg) {
      throw new Error(`[chaos-maker] preset '${norm}' is not registered. Known: ${this.list().join(', ')}`);
    }
    return cfg;
  }

  list(): string[] {
    return [...this.map.keys()];
  }
}

/** Append rule arrays from `slice` onto `target`. Walks the four rule-bearing
 *  categories reflectively so any new sub-key under one of them flows through
 *  without per-array code. Top-level `groups` is concatenated separately;
 *  duplicate names across preset+user are caught by `prepareChaosConfig`'s
 *  Zod pass 2 (`groupConfigListSchema.superRefine`).
 *
 *  Fail-fast: if any sub-key under a known category is not an array, this
 *  throws immediately rather than silently dropping rules. Catches
 *  contributor errors the moment a preset exercising the bad shape runs.
 *
 *  IF a future ChaosConfig category is NOT a `Record<string, ruleArray[]>`
 *  (e.g. a top-level config object instead of a rule bucket), the `cat`
 *  tuple below MUST be updated AND the new category needs explicit handling. */
function appendSlice(target: ChaosConfig, slice: PresetConfigSlice): void {
  for (const cat of ['network', 'ui', 'websocket', 'sse', 'fetchStream'] as const) {
    const src = slice[cat] as Record<string, unknown> | undefined;
    if (!src) continue;
    const dst = (target[cat] ??= {}) as Record<string, unknown>;
    for (const [k, arr] of Object.entries(src)) {
      // `replay` is a single directive object, not a rule array. It has no
      // meaningful concatenation, so the last writer wins (user config is
      // appended after preset slices, matching the rule-array ordering).
      if (k === 'replay') {
        dst[k] = arr;
        continue;
      }
      if (!Array.isArray(arr)) {
        let received: string;
        try {
          const ctorName = arr === null ? 'null' : (arr as object)?.constructor?.name ?? typeof arr;
          const snippet = JSON.stringify(arr)?.slice(0, 80) ?? '<unserializable>';
          received = `${ctorName} ${snippet}`;
        } catch {
          received = `${typeof arr} <unserializable>`;
        }
        throw new Error(
          `[chaos-maker] internal: preset slice category '${cat}.${k}' must be an array (got ${received}). Update appendSlice when adding non-array category fields.`,
        );
      }
      ((dst[k] ??= []) as unknown[]).push(...arr);
    }
  }
  // `userInteraction` is a bundle of scenario triggers, not a rule bucket.
  // Merge per trigger key: the later slice wins each trigger it sets. Presets
  // append before the user's config, so user-set triggers override presets.
  if (slice.userInteraction) {
    target.userInteraction = { ...target.userInteraction, ...slice.userInteraction };
  }
  if (slice.groups?.length) {
    (target.groups ??= []).push(...slice.groups);
  }
}

/** Expand `config.presets` against `registry`. Identity contract:
 *
 *   - ALWAYS returns a fresh `ChaosConfig`. Callers own the returned object
 *     and may mutate it without affecting the input. Built-in slices stay
 *     deep-frozen because each preset is deep-cloned at append time.
 *   - The output ALWAYS has `presets` and `customPresets` stripped, even if
 *     `presets[]` was empty. Prevents stale `customPresets` from leaking into
 *     the post-expansion config.
 *   - Append order: preset rules first (in the order they appear in
 *     `presets[]`), user rules last. Same rule for `groups`.
 *   - Throws when a name in `presets[]` is not registered. Plain `Error`  - 
 *     `prepareChaosConfig` wraps to `ChaosConfigError`.
 *
 *  Defensive deduplication on `presets[]` runs here as well as in the Zod
 *  transform, because `expandPresets` is exported and a contributor could
 *  call it directly on an un-validated config. */
export function expandPresets(config: ChaosConfig, registry: PresetRegistry): ChaosConfig {
  const seenNames = new Set<string>();
  const seenConfigs = new Set<PresetConfigSlice>();
  const orderedConfigs: PresetConfigSlice[] = [];
  for (const raw of config.presets ?? []) {
    const norm = raw.trim();
    if (!norm || seenNames.has(norm)) continue;
    seenNames.add(norm);
    // Dedup by resolved config identity too: kebab aliases share object
    // identity with their camelCase entries, so `['slow-api', 'slowNetwork']`
    // collapses to a single expansion preserving first-occurrence order.
    // Custom presets get distinct config objects, so this never collapses
    // distinct user intents.
    const cfg = registry.get(norm);
    if (seenConfigs.has(cfg)) continue;
    seenConfigs.add(cfg);
    orderedConfigs.push(cfg);
  }
  const out: ChaosConfig = {};
  for (const cfg of orderedConfigs) {
    appendSlice(out, cloneValue(cfg));
  }
  const userClone = cloneValue(config);
  delete userClone.presets;
  delete userClone.customPresets;
  if (userClone.seed !== undefined) out.seed = userClone.seed;
  if (userClone.debug !== undefined) out.debug = userClone.debug;
  // `matchers` is a top-level registry that survives preset expansion so
  // resolveNamedMatchers (run after this step in `prepareChaosConfig`) can
  // see entries referenced by rules added through presets.
  if (userClone.matchers !== undefined) out.matchers = userClone.matchers;
  // `ai` is a top-level compiler shorthand that runs AFTER preset expansion.
  // Preset slices reject the field at schema time, so the only legal carrier
  // is the user's top-level config. Pull it through explicitly; `appendSlice`
  // walks rule categories only and would silently drop it.
  if (userClone.ai !== undefined) out.ai = userClone.ai;
  appendSlice(out, userClone as PresetConfigSlice);
  return out;
}

/** Backward-compat: the v0.4.0 frozen-record export. **CamelCase keys ONLY.**
 *  kebab aliases (`slow-api`, `flaky-api`, `offline-mode`,
 *  `high-latency`) live exclusively on `PresetRegistry`  -  they are NOT keys
 *  on this record. By design:
 *
 *    presets['slow-api']  === undefined
 *    presets.slowNetwork  === new PresetRegistry().get('slow-api')   // same identity
 *    presets.slowNetwork  === new PresetRegistry().get('slowNetwork')
 *
 *  Use the camelCase key when reading from this record; use the registry (or
 *  the declarative `presets: ['slow-api']` config field) for kebab lookups. */
export const presets: Readonly<Record<string, PresetConfigSlice>> = Object.freeze({
  unstableApi:           UNSTABLE_API,
  slowNetwork:           SLOW_NETWORK,
  offlineMode:           OFFLINE_MODE,
  flakyConnection:       FLAKY_CONNECTION,
  degradedUi:            DEGRADED_UI,
  unreliableWebSocket:   UNRELIABLE_WEBSOCKET,
  unreliableEventStream: UNRELIABLE_EVENT_STREAM,
  mobileThreeG:          MOBILE_3G,
  checkoutDegraded:      CHECKOUT_DEGRADED,
  aiSlowFirstChunk:      AI_SLOW_FIRST_CHUNK,
  aiStreamTruncated:     AI_STREAM_TRUNCATED,
  aiStreamPaused:        AI_STREAM_PAUSED,
  aiToolCallFails:       AI_TOOL_CALL_FAILS,
  aiRetryLoop:           AI_RETRY_LOOP,
  aiReconnectAfterDrop:  AI_RECONNECT_AFTER_DROP,
  aiMobileInterrupt:     AI_MOBILE_INTERRUPT,
});
