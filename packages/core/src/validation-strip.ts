/** Known-key projection for `unknownFields: 'warn' | 'ignore'`. The walker is
 *  a small recursive helper, NOT a third Zod schema. Returns a fresh object
 *  detached from the passthrough parse result so subsequent stages cannot leak
 *  unknown fields back through aliasing. */

import type { ChaosConfig } from './config';

type KnownKeyMap = {
  readonly [K: string]: ReadonlySet<string> | undefined;
};

const SHARED_RULE_FIELDS = [
  'urlPattern',
  'methods',
  'graphqlOperation',
  'probability',
  'onNth',
  'everyNth',
  'afterN',
  'group',
];

const NETWORK_FAILURE_KEYS = new Set([...SHARED_RULE_FIELDS, 'statusCode', 'body', 'statusText', 'headers']);
const NETWORK_LATENCY_KEYS = new Set([...SHARED_RULE_FIELDS, 'delayMs']);
const NETWORK_ABORT_KEYS = new Set([...SHARED_RULE_FIELDS, 'timeout']);
const NETWORK_CORRUPTION_KEYS = new Set([...SHARED_RULE_FIELDS, 'strategy']);
const NETWORK_CORS_KEYS = new Set(SHARED_RULE_FIELDS);

const UI_ASSAULT_KEYS = new Set(['selector', 'action', 'probability', 'group']);

const WS_DROP_KEYS = new Set(['urlPattern', 'direction', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const WS_DELAY_KEYS = new Set(['urlPattern', 'direction', 'delayMs', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const WS_CORRUPT_KEYS = new Set(['urlPattern', 'direction', 'strategy', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const WS_CLOSE_KEYS = new Set(['urlPattern', 'code', 'reason', 'afterMs', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);

const SSE_DROP_KEYS = new Set(['urlPattern', 'eventType', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const SSE_DELAY_KEYS = new Set(['urlPattern', 'eventType', 'delayMs', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const SSE_CORRUPT_KEYS = new Set(['urlPattern', 'eventType', 'strategy', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);
const SSE_CLOSE_KEYS = new Set(['urlPattern', 'afterMs', 'probability', 'onNth', 'everyNth', 'afterN', 'group']);

const GROUP_KEYS = new Set(['name', 'enabled']);

const NETWORK_KEYS: KnownKeyMap = {
  failures: NETWORK_FAILURE_KEYS,
  latencies: NETWORK_LATENCY_KEYS,
  aborts: NETWORK_ABORT_KEYS,
  corruptions: NETWORK_CORRUPTION_KEYS,
  cors: NETWORK_CORS_KEYS,
};

const UI_KEYS: KnownKeyMap = {
  assaults: UI_ASSAULT_KEYS,
};

const WS_KEYS: KnownKeyMap = {
  drops: WS_DROP_KEYS,
  delays: WS_DELAY_KEYS,
  corruptions: WS_CORRUPT_KEYS,
  closes: WS_CLOSE_KEYS,
};

const SSE_KEYS: KnownKeyMap = {
  drops: SSE_DROP_KEYS,
  delays: SSE_DELAY_KEYS,
  corruptions: SSE_CORRUPT_KEYS,
  closes: SSE_CLOSE_KEYS,
};

const TOP_LEVEL_KEYS = new Set([
  'network',
  'ui',
  'websocket',
  'sse',
  'groups',
  'presets',
  'customPresets',
  'seed',
  'debug',
  'schemaVersion',
  'profile',
  'profileOverrides',
  'customProfiles',
]);

const CATEGORY_KEYS: Record<string, ReadonlySet<string>> = {
  network: new Set(Object.keys(NETWORK_KEYS)),
  ui: new Set(Object.keys(UI_KEYS)),
  websocket: new Set(Object.keys(WS_KEYS)),
  sse: new Set(Object.keys(SSE_KEYS)),
};

const CATEGORY_RULE_KEYS: Record<string, KnownKeyMap> = {
  network: NETWORK_KEYS,
  ui: UI_KEYS,
  websocket: WS_KEYS,
  sse: SSE_KEYS,
};

function projectObject(input: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (keys.has(k)) out[k] = src[k];
  }
  return out;
}

function projectRuleArray(input: unknown, ruleKeys: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.map((rule) => projectObject(rule, ruleKeys));
}

function projectCategory(input: unknown, ruleMap: KnownKeyMap, allowed: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!allowed.has(k)) continue;
    const ruleKeys = ruleMap[k];
    if (!ruleKeys) continue;
    out[k] = projectRuleArray(src[k], ruleKeys);
  }
  return out;
}

function projectGroups(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.map((g) => projectObject(g, GROUP_KEYS));
}

function projectPresetSlice(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  for (const cat of Object.keys(CATEGORY_RULE_KEYS)) {
    if (src[cat] !== undefined) {
      out[cat] = projectCategory(src[cat], CATEGORY_RULE_KEYS[cat], CATEGORY_KEYS[cat]);
    }
  }
  if (src.groups !== undefined) out.groups = projectGroups(src.groups);
  return out;
}

/** ProfileConfigSlice differs from PresetConfigSlice by carrying `presets`,
 *  `seed`, and `debug` on top of the four rule categories + `groups`. Mirrors
 *  `projectPresetSlice` plus those three extras; same strict-key projection
 *  semantics. `debug` is reduced to the schema's known shape
 *  (`boolean | { enabled: boolean }`) so unknown nested keys never bypass the
 *  strict pass-2 reject under `unknownFields: 'warn' | 'ignore'`. */
function projectProfileSlice(input: unknown): Record<string, unknown> {
  const out = projectPresetSlice(input);
  if (!input || typeof input !== 'object') return out;
  const src = input as Record<string, unknown>;
  if (Array.isArray(src.presets)) {
    out.presets = (src.presets as unknown[]).filter((s) => typeof s === 'string');
  }
  if (typeof src.seed === 'number') out.seed = src.seed;
  if (src.debug !== undefined) {
    const debugSrc = src.debug;
    if (typeof debugSrc === 'boolean') {
      out.debug = debugSrc;
    } else if (debugSrc && typeof debugSrc === 'object') {
      const enabled = (debugSrc as Record<string, unknown>).enabled;
      if (typeof enabled === 'boolean') out.debug = { enabled };
    }
  }
  return out;
}

/** Project `input` to a fresh object containing only the keys recognized by
 *  the strict schema. Never mutates the input. */
export function stripUnknownKeys(input: unknown): ChaosConfig {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out as ChaosConfig;
  const src = input as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!TOP_LEVEL_KEYS.has(k)) continue;
    if (k in CATEGORY_RULE_KEYS) {
      out[k] = projectCategory(src[k], CATEGORY_RULE_KEYS[k], CATEGORY_KEYS[k]);
    } else if (k === 'groups') {
      out[k] = projectGroups(src[k]);
    } else if (k === 'customPresets') {
      const cp = src[k];
      if (cp && typeof cp === 'object') {
        const projected: Record<string, unknown> = {};
        for (const [name, slice] of Object.entries(cp as Record<string, unknown>)) {
          projected[name] = projectPresetSlice(slice);
        }
        out[k] = projected;
      }
    } else if (k === 'profileOverrides') {
      out[k] = projectProfileSlice(src[k]);
    } else if (k === 'customProfiles') {
      const cp = src[k];
      if (cp && typeof cp === 'object') {
        const projected: Record<string, unknown> = {};
        for (const [name, slice] of Object.entries(cp as Record<string, unknown>)) {
          projected[name] = projectProfileSlice(slice);
        }
        out[k] = projected;
      }
    } else {
      out[k] = src[k];
    }
  }
  return out as ChaosConfig;
}

/** Collect dot-notation paths of unknown keys. Deterministic sorted output.
 *  Does not mutate the input. */
export function collectUnknownPaths(input: unknown): string[] {
  const paths: string[] = [];
  walk(input, '', paths);
  return paths.sort();
}

function walk(value: unknown, prefix: string, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (prefix === '') {
    const src = value as Record<string, unknown>;
    for (const k of Object.keys(src)) {
      if (!TOP_LEVEL_KEYS.has(k)) {
        out.push(k);
        continue;
      }
      if (k in CATEGORY_RULE_KEYS) {
        walkCategory(src[k], k, CATEGORY_RULE_KEYS[k], CATEGORY_KEYS[k], out);
      } else if (k === 'groups') {
        walkGroups(src[k], 'groups', out);
      } else if (k === 'customPresets') {
        walkCustomPresets(src[k], out);
      } else if (k === 'profileOverrides') {
        walkProfileSlice(src[k], 'profileOverrides', out);
      } else if (k === 'customProfiles') {
        walkCustomProfiles(src[k], out);
      }
    }
  }
}

function walkCategory(
  value: unknown,
  catPath: string,
  ruleMap: KnownKeyMap,
  allowed: ReadonlySet<string>,
  out: string[],
): void {
  if (!value || typeof value !== 'object') return;
  const src = value as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    const sub = `${catPath}.${k}`;
    if (!allowed.has(k)) {
      out.push(sub);
      continue;
    }
    const ruleKeys = ruleMap[k];
    if (!ruleKeys) continue;
    if (!Array.isArray(src[k])) continue;
    (src[k] as unknown[]).forEach((rule, idx) => {
      if (!rule || typeof rule !== 'object') return;
      const r = rule as Record<string, unknown>;
      for (const rk of Object.keys(r)) {
        if (!ruleKeys.has(rk)) out.push(`${sub}[${idx}].${rk}`);
      }
    });
  }
}

function walkGroups(value: unknown, prefix: string, out: string[]): void {
  if (!Array.isArray(value)) return;
  value.forEach((g, idx) => {
    if (!g || typeof g !== 'object') return;
    const r = g as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (!GROUP_KEYS.has(k)) out.push(`${prefix}[${idx}].${k}`);
    }
  });
}

function walkCustomPresets(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [name, slice] of Object.entries(value as Record<string, unknown>)) {
    if (!slice || typeof slice !== 'object') continue;
    const src = slice as Record<string, unknown>;
    for (const k of Object.keys(src)) {
      if (k === 'groups') {
        walkGroups(src[k], `customPresets.${name}.groups`, out);
        continue;
      }
      if (!(k in CATEGORY_RULE_KEYS)) {
        out.push(`customPresets.${name}.${k}`);
        continue;
      }
      walkCategory(src[k], `customPresets.${name}.${k}`, CATEGORY_RULE_KEYS[k], CATEGORY_KEYS[k], out);
    }
  }
}

const PROFILE_SLICE_ALLOWED_TOP = new Set([
  ...Object.keys(CATEGORY_RULE_KEYS),
  'groups',
  'presets',
  'seed',
  'debug',
]);

function walkProfileSlice(value: unknown, prefix: string, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  const src = value as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!PROFILE_SLICE_ALLOWED_TOP.has(k)) {
      out.push(`${prefix}.${k}`);
      continue;
    }
    if (k === 'groups') {
      walkGroups(src[k], `${prefix}.groups`, out);
      continue;
    }
    if (k in CATEGORY_RULE_KEYS) {
      walkCategory(src[k], `${prefix}.${k}`, CATEGORY_RULE_KEYS[k], CATEGORY_KEYS[k], out);
    }
  }
}

function walkCustomProfiles(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [name, slice] of Object.entries(value as Record<string, unknown>)) {
    walkProfileSlice(slice, `customProfiles.${name}`, out);
  }
}
