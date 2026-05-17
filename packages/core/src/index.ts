import { ChaosMaker } from './ChaosMaker';
import { ChaosConfig, CorruptionStrategy, GraphQLOperationMatcher, NetworkFailureConfig, NetworkLatencyConfig, NetworkAbortConfig, NetworkCorruptionConfig, NetworkCorsConfig, NetworkConfig, NetworkRuleMatchers, RuleGroupAssignment, UiAssaultConfig, UiConfig, WebSocketConfig, WebSocketDropConfig, WebSocketDelayConfig, WebSocketCorruptConfig, WebSocketCloseConfig, WebSocketDirection, WebSocketCorruptionStrategy, SSEConfig, SSEDropConfig, SSEDelayConfig, SSECorruptConfig, SSECloseConfig, SSECorruptionStrategy, SSEEventTypeMatcher } from './config';
import { ChaosConfigError } from './errors';
import { validateConfig, prepareChaosConfig, validateChaosConfig, VALIDATOR_BRAND_VERSION, type ValidateChaosConfigOptions, type PrepareChaosConfigOptions } from './validation';
import { ChaosEvent, ChaosEventType, ChaosEventListener, ChaosEventEmitter } from './events';
import { ChaosConfigBuilder } from './builder';
import { presets, PresetRegistry, BUILT_IN_PRESETS, expandPresets } from './presets';
import { ProfileRegistry, BUILT_IN_PROFILES, applyProfile } from './profiles';
import { createPrng, generateSeed } from './prng';
import { deserializeForTransport } from './transport';
import { formatStepTitle, shouldEmitStep } from './format-event';
import { formatSeedReproduction } from './seed-reporting';

/** `validateChaosConfig` is the canonical structured validation entry. Layers
 *  schema-version gating, brand-cache short-circuit, deprecation walk, and
 *  custom validators on top of `prepareChaosConfig` (Zod pass 1 + preset
 *  expansion + Zod pass 2). The `ChaosMaker` constructor and every adapter
 *  call through it.
 *
 *  `prepareChaosConfig` is the lower-level primitive without the brand /
 *  deprecation / customValidators layers; useful in advanced flows that
 *  manage their own re-validation cadence.
 *
 *  `validateConfig` is the schema-only primitive — does NOT expand presets.
 *  Use only for unit-test structural assertions. */
export { ChaosMaker, ChaosConfigError, validateConfig, prepareChaosConfig, validateChaosConfig, VALIDATOR_BRAND_VERSION, ChaosEventEmitter, ChaosConfigBuilder, presets, PresetRegistry, BUILT_IN_PRESETS, expandPresets, ProfileRegistry, BUILT_IN_PROFILES, applyProfile, createPrng, generateSeed, formatStepTitle, shouldEmitStep, formatSeedReproduction };
/** Internal: prebuilt Zod schema variants. Exported so the JSON-schema build
 *  script can serialize the canonical strict variant. Application code should
 *  call `validateChaosConfig` instead — the schemas are not the public
 *  validation surface and may evolve without a version bump. */
export { chaosConfigSchemaStrict, chaosConfigSchemaPassthrough } from './validation';
export type { ValidateChaosConfigOptions, PrepareChaosConfigOptions };
export type { ValidationIssue, ValidationIssueCode, RuleType, CustomRuleValidator, CustomValidatorMap, DeprecationEntry } from './validation-types';
export type { Preset, PresetConfigSlice } from './presets';
export type { Profile, ProfileConfigSlice, ProfileOverrideSlice } from './profiles';
export { SW_BRIDGE_SOURCE } from './sw-bridge-source';
export { isSessionTeardownError, SESSION_TEARDOWN_PATTERNS } from './session-errors';
export { extractGraphQLOperation, parseOperationFromQueryString, operationNameMatches } from './graphql';
export { serializeForTransport, deserializeForTransport } from './transport';
export { DEFAULT_GROUP_NAME, RuleGroupRegistry } from './groups';
export { Logger, normalizeDebugOption, formatDebugMessage, buildRuleIdMap } from './debug';
export type { RuleGroup, RuleGroupConfig } from './groups';
export type { GraphQLExtractResult, GraphQLRuleOutcome } from './graphql';
export type { DebugOptions, ChaosDebugStage, RuleIdEntry } from './debug';
export type { ChaosLifecyclePhase } from './events';
export type { ChaosConfig, CorruptionStrategy, GraphQLOperationMatcher, NetworkFailureConfig, NetworkLatencyConfig, NetworkAbortConfig, NetworkCorruptionConfig, NetworkCorsConfig, NetworkConfig, NetworkRuleMatchers, RuleGroupAssignment, UiAssaultConfig, UiConfig, WebSocketConfig, WebSocketDropConfig, WebSocketDelayConfig, WebSocketCorruptConfig, WebSocketCloseConfig, WebSocketDirection, WebSocketCorruptionStrategy, SSEConfig, SSEDropConfig, SSEDelayConfig, SSECorruptConfig, SSECloseConfig, SSECorruptionStrategy, SSEEventTypeMatcher, ChaosEvent, ChaosEventType, ChaosEventListener };

// --- NEW INTERFACE ---
interface ChaosUtilsApi {
  instance: ChaosMaker | null;
  start: (config: ChaosConfig) => { success: boolean; message: string };
  stop: () => { success: boolean; message: string };
  getLog: () => ChaosEvent[];
  getSeed: () => number | null;
  enableGroup: (name: string) => { success: boolean; message: string };
  disableGroup: (name: string) => { success: boolean; message: string };
  createGroup: (name: string, opts?: { enabled?: boolean }) => { success: boolean; message: string };
  getGroupState: (name: string) => boolean | null;
  validate: (config: unknown, opts?: ValidateChaosConfigOptions) => ChaosConfig;
}

// --- Global API & Auto-Start Logic ---
if (typeof window !== 'undefined') {
  (window as any).ChaosMaker = ChaosMaker;
  
  // Apply the interface
  const chaosUtilsApi: ChaosUtilsApi = {
    instance: null,
    
    start: (config: ChaosConfig) => {
      // Stop any prior instance first, then construct + start the next one in
      // a temporary so a throw from `deserializeForTransport`, the
      // `ChaosMaker` constructor, or `start()` doesn't leave a stale stopped
      // instance bound to `chaosUtilsApi.instance`. On failure the global
      // resets to `null` so getLog/enableGroup/stop short-circuit cleanly.
      if (chaosUtilsApi.instance) {
        chaosUtilsApi.instance.stop();
        chaosUtilsApi.instance = null;
      }
      try {
        // Reconstruct any RegExp matchers shipped via JSON-encoding adapters.
        // Idempotent for already-deserialized configs.
        const cfg = deserializeForTransport(config);
        const newInstance = new ChaosMaker(cfg);
        newInstance.start();
        chaosUtilsApi.instance = newInstance;
        return { success: true, message: "Chaos started" };
      } catch (e: any) {
        console.error("Chaos Utils Error:", e);
        return { success: false, message: e.message };
      }
    },
    
    stop: () => {
      if (chaosUtilsApi.instance) {
        chaosUtilsApi.instance.stop();
        chaosUtilsApi.instance = null;
        return { success: true, message: "Chaos stopped" };
      }
      return { success: false, message: "No chaos instance to stop" };
    },

    getLog: () => {
      if (chaosUtilsApi.instance) {
        return chaosUtilsApi.instance.getLog();
      }
      return [];
    },

    getSeed: () => {
      if (chaosUtilsApi.instance) {
        return chaosUtilsApi.instance.getSeed();
      }
      return null;
    },

    enableGroup: (name: string) => {
      if (!chaosUtilsApi.instance) return { success: false, message: 'No chaos instance' };
      try {
        chaosUtilsApi.instance.enableGroup(name);
        return { success: true, message: `Group '${name}' enabled` };
      } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
      }
    },

    disableGroup: (name: string) => {
      if (!chaosUtilsApi.instance) return { success: false, message: 'No chaos instance' };
      try {
        chaosUtilsApi.instance.disableGroup(name);
        return { success: true, message: `Group '${name}' disabled` };
      } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
      }
    },

    createGroup: (name: string, opts?: { enabled?: boolean }) => {
      if (!chaosUtilsApi.instance) return { success: false, message: 'No chaos instance' };
      try {
        chaosUtilsApi.instance.createGroup(name, opts);
        return { success: true, message: `Group '${name}' created` };
      } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
      }
    },

    getGroupState: (name: string) => {
      if (!chaosUtilsApi.instance) return null;
      try {
        return chaosUtilsApi.instance.getGroupState(name);
      } catch {
        return null;
      }
    },

    validate: (config: unknown, opts?: ValidateChaosConfigOptions) =>
      validateChaosConfig(config, opts),
  };
  
  (window as any).chaosUtils = chaosUtilsApi;
  
  if ((window as any).__CHAOS_CONFIG__) {
    try {
      const config = (window as any).__CHAOS_CONFIG__;
      chaosUtilsApi.start(config);
      delete (window as any).__CHAOS_CONFIG__;
    } catch (e) {
      console.error('ChaosMaker auto-start failed:', e);
    }
  }
}
