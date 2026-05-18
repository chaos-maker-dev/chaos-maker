import type { ChaosConfig } from './config';
import { cloneValue } from './utils';

/** ChaosConfig slice a scenario profile is allowed to carry. Auto-includes any
 *  new top-level field added to ChaosConfig EXCEPT the keys explicitly forbidden
 *  inside a profile: `customPresets`, `customProfiles`, `profile`,
 *  `profileOverrides`, `schemaVersion`.
 *
 *  A profile MAY carry `presets: string[]`, `seed`, `debug`, `groups`, and the
 *  four rule categories. Profiles compose with presets via their own
 *  `presets[]` field; recursive profile inheritance is intentionally
 *  out-of-scope. */
export type ProfileConfigSlice = Omit<
  ChaosConfig,
  'customPresets' | 'customProfiles' | 'profile' | 'profileOverrides' | 'schemaVersion'
>;

/** Runtime override slice applied at inject-time. Identical shape to a profile
 *  slice — same fields allowed, same fields forbidden. The override block is
 *  the LAST writer in the resolution pipeline: its scalars (`seed`, `debug`)
 *  win over both the profile and the top-level config, and its rule arrays
 *  append after every other layer. */
export type ProfileOverrideSlice = ProfileConfigSlice;

/** A named profile packaged for registry registration. Wraps the config slice
 *  with its registration name. */
export interface Profile {
  readonly name: string;
  readonly config: ProfileConfigSlice;
}

// Hard-coded shared config so reading the file shows exactly what the demo
// profile does and which kebab name resolves to which config. The alias below
// registers the SAME object identity, so
// `registry.get('mobile-checkout') === registry.get('mobileCheckout')`.
const MOBILE_CHECKOUT: ProfileConfigSlice = {
  presets: ['mobile-3g', 'checkout-degraded'],
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// Built-in slice is immutable. Mutating
// `registry.get('mobile-checkout').presets!.push('x')` is a no-op in sloppy
// mode and throws in strict mode. Custom profiles passed via `customProfiles`
// are NOT frozen — users keep ownership of their literals.
[MOBILE_CHECKOUT].forEach(deepFreeze);

/** Built-in scenario profile registrations.
 *
 *  v0.7.0 ships **exactly one** built-in profile, `mobileCheckout`, plus its
 *  kebab alias `mobile-checkout`. Both entries point at the SAME frozen config
 *  object identity, mirroring the `PresetRegistry` alias contract.
 *
 *  This list is intentionally NOT an open catalog. Profiles are deliberately
 *  user-owned; `mobileCheckout` exists as a wiring demo so the registry,
 *  resolution pipeline, and adapter surfaces have one concrete name to
 *  exercise end-to-end. Define your own scenarios via `customProfiles` or
 *  inline `defineProfile()` on the builder. */
export const BUILT_IN_PROFILES: ReadonlyArray<Profile> = Object.freeze(
  ([
    { name: 'mobileCheckout',  config: MOBILE_CHECKOUT },
    { name: 'mobile-checkout', config: MOBILE_CHECKOUT },
  ] as Profile[]).map((p) => Object.freeze(p)),
);

function normalizeProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('[chaos-maker] profile name cannot be empty');
  return trimmed;
}

/** Per-instance registry of scenario profiles. Constructor seeds the built-in
 *  demo entries by default; pass an empty iterable to start from scratch. The
 *  slice shape is type-enforced for built-ins and Zod-validated for
 *  `customProfiles`, so `register` does not re-check structure. */
export class ProfileRegistry {
  private map = new Map<string, ProfileConfigSlice>();

  constructor(initial: Iterable<Profile> = BUILT_IN_PROFILES) {
    for (const p of initial) this.register(p);
  }

  register(profile: Profile): void {
    const name = normalizeProfileName(profile.name);
    if (this.map.has(name)) {
      throw new Error(`[chaos-maker] profile '${name}' already registered`);
    }
    this.map.set(name, profile.config);
  }

  registerAll(entries: Record<string, ProfileConfigSlice> | undefined): void {
    if (!entries) return;
    for (const [name, config] of Object.entries(entries)) {
      this.register({ name, config });
    }
  }

  has(name: string): boolean {
    return this.map.has(normalizeProfileName(name));
  }

  get(name: string): ProfileConfigSlice {
    const norm = normalizeProfileName(name);
    const cfg = this.map.get(norm);
    if (!cfg) {
      throw new Error(`[chaos-maker] profile '${norm}' is not registered. Known: ${this.list().join(', ')}`);
    }
    return cfg;
  }

  list(): string[] {
    return [...this.map.keys()];
  }
}

const PROFILE_CHAIN_FORBIDDEN = [
  'profile',
  'profileOverrides',
  'customProfiles',
  'customPresets',
  'schemaVersion',
] as const;

function ensureNoProfileChain(slice: object, source: string): void {
  for (const k of PROFILE_CHAIN_FORBIDDEN) {
    if (k in (slice as Record<string, unknown>)) {
      throw new Error(
        `[chaos-maker] profile slice '${source}' may not contain '${k}' (recursive profile inheritance is out of scope)`,
      );
    }
  }
}

/** Append rule arrays + groups from `slice` onto `target`. Walks the four
 *  rule-bearing categories reflectively so any new sub-key under one of them
 *  flows through without per-array code. Top-level `groups` is concatenated
 *  separately.
 *
 *  IF a future ChaosConfig category is NOT a `Record<string, ruleArray[]>`,
 *  the `cat` tuple below MUST be updated AND the new category needs explicit
 *  handling. */
function appendProfileSlice(target: ChaosConfig, slice: ProfileConfigSlice): void {
  for (const cat of ['network', 'ui', 'websocket', 'sse'] as const) {
    const src = slice[cat] as Record<string, unknown> | undefined;
    if (!src) continue;
    const dst = (target[cat] ??= {}) as Record<string, unknown[]>;
    for (const [k, arr] of Object.entries(src)) {
      if (!Array.isArray(arr)) {
        throw new Error(
          `[chaos-maker] internal: profile slice category '${cat}.${k}' must be an array. Update appendProfileSlice when adding non-array category fields.`,
        );
      }
      (dst[k] ??= []).push(...arr);
    }
  }
  if (slice.groups?.length) {
    (target.groups ??= []).push(...slice.groups);
  }
}

function mergePresetLists(
  ...lists: Array<readonly string[] | undefined>
): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const norm = raw.trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  }
  return out.length ? out : undefined;
}

/** Resolve `config.profile` + `config.profileOverrides` into a flat
 *  `ChaosConfig`. Identity + ordering contract:
 *
 *  - ALWAYS returns a fresh `ChaosConfig`. Callers own the returned object
 *    and may mutate it without affecting the input or any registry slice.
 *    The registered profile slice is deep-cloned before any append.
 *  - The output ALWAYS has `profile`, `profileOverrides`, and `customProfiles`
 *    stripped, even when the inputs were undefined. `customPresets` and
 *    `schemaVersion` are carried through unchanged so `expandPresets` and
 *    schema validation downstream still see them.
 *  - Rule append order: profile rules first, then top-level rules, then
 *    `profileOverrides` rules. Same rule for `groups`.
 *  - `presets[]` merge order: profile-presets first, then top-level-presets,
 *    then override-presets. Deduplicated by trimmed name, first occurrence
 *    preserved.
 *  - Scalar (`seed`, `debug`) precedence: `profileOverrides` > top-level >
 *    profile (the highest layer whose value is `!== undefined` wins).
 *  - Throws when `config.profile` is set but the name is not registered
 *    (plain `Error` — `prepareChaosConfig` wraps to `unknown_profile`).
 *  - Throws when a resolved profile or override slice carries a forbidden
 *    profile-chain field (plain `Error` — wrapped to `profile_chain`). */
export function applyProfile(
  config: ChaosConfig,
  registry: ProfileRegistry,
): ChaosConfig {
  const profileName = config.profile;
  const overrides = config.profileOverrides;

  const inputCopy = cloneValue(config);
  delete inputCopy.profile;
  delete inputCopy.profileOverrides;
  delete inputCopy.customProfiles;

  if (profileName === undefined && overrides === undefined) {
    return inputCopy;
  }

  let profileSlice: ProfileConfigSlice | undefined;
  if (profileName !== undefined) {
    profileSlice = cloneValue(registry.get(profileName));
    ensureNoProfileChain(profileSlice, profileName);
  }

  const overridesSlice = overrides ? cloneValue(overrides) : undefined;
  if (overridesSlice) {
    ensureNoProfileChain(overridesSlice, 'profileOverrides');
  }

  const out: ChaosConfig = {};

  if (profileSlice) {
    appendProfileSlice(out, profileSlice);
  }

  const topSlice: ProfileConfigSlice = { ...inputCopy };
  delete (topSlice as ChaosConfig).presets;
  delete (topSlice as ChaosConfig).customPresets;
  delete (topSlice as ChaosConfig).seed;
  delete (topSlice as ChaosConfig).debug;
  delete (topSlice as ChaosConfig).schemaVersion;
  appendProfileSlice(out, topSlice);

  if (overridesSlice) {
    appendProfileSlice(out, overridesSlice);
  }

  const mergedPresets = mergePresetLists(
    profileSlice?.presets,
    inputCopy.presets,
    overridesSlice?.presets,
  );
  if (mergedPresets) out.presets = mergedPresets;

  if (inputCopy.customPresets) out.customPresets = inputCopy.customPresets;

  const seed = overridesSlice?.seed ?? inputCopy.seed ?? profileSlice?.seed;
  if (seed !== undefined) out.seed = seed;

  const debug = overridesSlice?.debug ?? inputCopy.debug ?? profileSlice?.debug;
  if (debug !== undefined) out.debug = debug;

  if (inputCopy.schemaVersion !== undefined) out.schemaVersion = inputCopy.schemaVersion;

  return out;
}
