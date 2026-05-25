import { ChaosConfig } from './config';
import { validateChaosConfig, type ValidateChaosConfigOptions } from './validation';
import { createPrng } from './prng';
import { ChaosEventEmitter, ChaosEvent, ChaosEventType, ChaosEventListener } from './events';
import { patchFetch } from './interceptors/networkFetch';
import { patchXHR, patchXHROpen, patchXHRSetRequestHeader } from './interceptors/networkXHR';
import { attachDomAssailant } from './interceptors/domAssailant';
import { patchWebSocket, WebSocketPatchHandle } from './interceptors/websocket';
import { patchEventSource, EventSourceLikeStatic, EventSourcePatchHandle } from './interceptors/eventSource';
import { DEFAULT_GROUP_NAME, RuleGroup, RuleGroupRegistry } from './groups';
import { forEachRule } from './utils';
import { Logger, buildRuleIdMap, normalizeDebugOption, RuleIdEntry } from './debug';
import {
  clearActiveRuntimeInstance,
  getActiveRuntimeInstance,
  getRuntimePatchKind,
  markRuntimePatch,
  RuntimePatchKind,
  setActiveRuntimeInstance,
} from './runtime-state';

/**
 * Global context ChaosMaker patches against. Must expose at minimum `fetch`
 * (network chaos), and optionally `XMLHttpRequest` / `WebSocket`. In a
 * browser page this is `window`; in a service worker / dedicated worker
 * this is `self`. `globalThis` resolves to the correct value in both.
 */
export type ChaosTarget = typeof globalThis;

export interface ChaosMakerOptions {
  /**
   * Explicit global to install chaos on. Defaults to `globalThis`, which
   * resolves correctly in both window and service-worker contexts. Pass
   * `window` or `self` explicitly only for cross-context testing.
   */
  target?: ChaosTarget;
  /**
   * Forwarded to `validateChaosConfig` during construction. Use to
   * relax unknown-field handling, hook deprecation events, or run custom
   * per-`RuleType` validators.
   */
  validation?: ValidateChaosConfigOptions;
}

function normalizeGroupName(name: string): string {
  const nameNorm = name.trim();
  if (!nameNorm) {
    throw new Error('[chaos-maker] Group name cannot be empty');
  }
  return nameNorm;
}

function emitCleanupWarning(reason: string, err: unknown): void {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
  try {
    console.warn(`[chaos-maker] cleanup step failed: ${reason}`, err);
  } catch {
    // Console sinks are best-effort only.
  }
}

export class ChaosMaker {
  private config: ChaosConfig;
  private emitter: ChaosEventEmitter;
  private random: () => number;
  private seed: number;
  private running = false;
  private target: ChaosTarget;
  private originalFetch?: typeof globalThis.fetch;
  private originalXhrSend?: (body?: Document | XMLHttpRequestBodyInit) => void;
  private originalXhrOpen?: (method: string, url: string | URL) => void;
  private originalXhrSetRequestHeader?: (name: string, value: string) => void;
  private domObserver?: MutationObserver;
  private originalWebSocket?: typeof WebSocket;
  private webSocketHandle?: WebSocketPatchHandle;
  private originalEventSource?: typeof EventSource;
  private eventSourceHandle?: EventSourcePatchHandle;
  /** Shared counters keyed by config rule object reference. Shared across fetch + XHR + WS. */
  private requestCounters: Map<object, number> = new Map();
  /** Rule-group registry. Default-on; default group always exists. */
  private groups: RuleGroupRegistry;
  /** Positional rule-id map shared across interceptors via emitter.
   *  Built lazily  -  only when debug mode is enabled  -  so disabled instances
   *  pay zero allocation cost. The emitter handles `undefined` ruleIds
   *  internally via `?.get(rule)`. */
  private ruleIds?: WeakMap<object, RuleIdEntry>;
  /** Logger fed into the emitter; absent ⇒ debug fast-path no-op. */
  private logger?: Logger;

  constructor(config: ChaosConfig, options: ChaosMakerOptions = {}) {
    this.config = validateChaosConfig(config, options.validation);
    this.emitter = new ChaosEventEmitter();
    const prng = createPrng(this.config.seed);
    this.random = prng.random;
    this.seed = prng.seed;
    this.target = options.target ?? globalThis;
    this.groups = new RuleGroupRegistry();
    // Pre-register groups declared in config first (explicit, may flip enabled).
    for (const g of this.config.groups ?? []) {
      this.groups.ensure(g.name, { enabled: g.enabled ?? true, explicit: true });
    }
    // Walk every rule so referenced groups are observable from `listGroups()`
    // before any request fires. Runtime auto-create still surfaces typos that
    // appear only at probe time.
    this.seedGroupsFromRules();
    // Default group is always present; ensures `getGroupsSnapshot()` includes it.
    this.groups.ensure(DEFAULT_GROUP_NAME, { enabled: true });
    // Only allocate the positional rule-id map and attach a Logger
    // when debug mode is enabled. The interceptor hot path goes through
    // `emitter.debug(...)`, which fast-paths off the absence of a Logger
    // before any rule-id lookup, so a disabled instance does no debug work.
    const debugOpts = normalizeDebugOption(this.config.debug);
    if (debugOpts.enabled) {
      this.ruleIds = buildRuleIdMap(this.config);
      this.emitter.setRuleIds(this.ruleIds);
      this.logger = new Logger(debugOpts, 'page');
      this.emitter.setLogger(this.logger);
    }
    console.log(`Chaos Maker initialized (seed: ${this.seed})`);
  }

  private seedGroupsFromRules(): void {
    forEachRule(this.config, (rule) => {
      if (rule.group) this.groups.ensure(rule.group);
    });
  }

  private emitInvariant(
    phase: 'engine:start' | 'engine:stop',
    reason: string,
    extra: ChaosEvent['detail'] = {},
  ): void {
    this.emitter.debug('lifecycle', {
      phase,
      reason,
      ...extra,
    });
  }

  // Engine `start()` already checked `getActiveRuntimeInstance` and bailed  - 
  // by the time this runs the target is owned by this instance, so the
  // active-instance probe lives at the call site and not here.
  private emitStartInvariantDiagnostics(target: ChaosTarget): void {
    this.emitPatchDiagnostic(target.fetch, 'fetch', 'target-fetch-already-patched', 'engine:start');
    if (typeof target.XMLHttpRequest === 'function') {
      this.emitPatchDiagnostic(
        target.XMLHttpRequest.prototype.open,
        'xhr-open',
        'target-xhr-open-already-patched',
        'engine:start',
      );
      this.emitPatchDiagnostic(
        target.XMLHttpRequest.prototype.send,
        'xhr-send',
        'target-xhr-send-already-patched',
        'engine:start',
      );
    }
    if (typeof target.WebSocket !== 'undefined') {
      this.emitPatchDiagnostic(target.WebSocket, 'websocket', 'target-websocket-already-patched', 'engine:start');
    }
    if (typeof target.EventSource !== 'undefined') {
      this.emitPatchDiagnostic(target.EventSource, 'eventsource', 'target-eventsource-already-patched', 'engine:start');
    }
    if (this.domObserver) {
      this.emitInvariant('engine:start', 'orphaned-dom-observer');
    }
    if (this.webSocketHandle) {
      this.emitInvariant('engine:start', 'stale-websocket-handle');
    }
    if (this.eventSourceHandle) {
      this.emitInvariant('engine:start', 'stale-eventsource-handle');
    }
  }

  private emitStopInvariantDiagnostics(target: ChaosTarget): void {
    this.emitPatchDiagnostic(target.fetch, 'fetch', 'target-fetch-still-patched', 'engine:stop');
    if (typeof target.XMLHttpRequest === 'function') {
      this.emitPatchDiagnostic(
        target.XMLHttpRequest.prototype.open,
        'xhr-open',
        'target-xhr-open-still-patched',
        'engine:stop',
      );
      this.emitPatchDiagnostic(
        target.XMLHttpRequest.prototype.send,
        'xhr-send',
        'target-xhr-send-still-patched',
        'engine:stop',
      );
    }
    if (typeof target.WebSocket !== 'undefined') {
      this.emitPatchDiagnostic(target.WebSocket, 'websocket', 'target-websocket-still-patched', 'engine:stop');
    }
    if (typeof target.EventSource !== 'undefined') {
      this.emitPatchDiagnostic(target.EventSource, 'eventsource', 'target-eventsource-still-patched', 'engine:stop');
    }
  }

  private emitPatchDiagnostic(
    value: unknown,
    expected: RuntimePatchKind,
    reason: string,
    phase: 'engine:start' | 'engine:stop',
  ): void {
    if (getRuntimePatchKind(value) === expected) {
      this.emitInvariant(phase, reason);
    }
  }

  private runCleanupStep(reason: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.emitInvariant('engine:stop', `cleanup-step-failed:${reason}`);
      emitCleanupWarning(reason, err);
    }
  }

  /** Compute the set of group names currently referenced by any rule. Used by `removeGroup`. */
  private collectReferencedGroups(): Set<string> {
    const referenced = new Set<string>();
    forEachRule(this.config, (rule) => {
      if (rule.group) referenced.add(rule.group);
    });
    return referenced;
  }

  /** Get the seed used by this instance. Log this on failure to reproduce exact chaos decisions. */
  public getSeed(): number {
    return this.seed;
  }

  public on(type: ChaosEventType | '*', listener: ChaosEventListener): void {
    this.emitter.on(type, listener);
  }

  public off(type: ChaosEventType | '*', listener: ChaosEventListener): void {
    this.emitter.off(type, listener);
  }

  public getLog(): ChaosEvent[] {
    return this.emitter.getLog();
  }

  public clearLog(): void {
    this.emitter.clearLog();
  }

  /** Enable a rule group at runtime. Auto-creates the group if unknown.
   *  Engine state and per-rule counters are preserved  -  no restart. */
  public enableGroup(name: string): void {
    const nameNorm = normalizeGroupName(name);
    this.groups.setEnabled(nameNorm, true);
    this.emitter.emit({
      type: 'rule-group:enabled',
      timestamp: Date.now(),
      applied: true,
      detail: { groupName: nameNorm },
    });
    this.emitter.debug('lifecycle', { phase: 'engine:group-toggled', groupName: nameNorm, enabled: true });
  }

  /** Disable a rule group at runtime. Subsequent matches are skipped
   *  and a single `rule-group:gated` event is emitted per cycle. */
  public disableGroup(name: string): void {
    const nameNorm = normalizeGroupName(name);
    this.groups.setEnabled(nameNorm, false);
    this.emitter.emit({
      type: 'rule-group:disabled',
      timestamp: Date.now(),
      applied: true,
      detail: { groupName: nameNorm },
    });
    this.emitter.debug('lifecycle', { phase: 'engine:group-toggled', groupName: nameNorm, enabled: false });
  }

  /** Pre-register a group (typically used to ship one as initially disabled). */
  public createGroup(name: string, opts?: { enabled?: boolean }): void {
    const nameNorm = normalizeGroupName(name);
    this.groups.ensure(nameNorm, { ...opts, explicit: true });
  }

  /** Remove a group from the registry. Throws when still referenced unless
   *  `{ force: true }`. `'default'` cannot be removed. */
  public removeGroup(name: string, opts?: { force?: boolean }): boolean {
    const nameNorm = normalizeGroupName(name);
    return this.groups.remove(nameNorm, this.collectReferencedGroups(), opts);
  }

  public hasGroup(name: string): boolean {
    const nameNorm = normalizeGroupName(name);
    return this.groups.has(nameNorm);
  }

  /** True iff the named group is currently enabled (auto-creates unknown names). */
  public getGroupState(name: string): boolean {
    const nameNorm = normalizeGroupName(name);
    return this.groups.isActive(nameNorm);
  }

  /** Snapshot of every known group as `{ name: enabled }`. */
  public getGroupsSnapshot(): Record<string, boolean> {
    return this.groups.getSnapshot();
  }

  public listGroups(): RuleGroup[] {
    return this.groups.list();
  }

  public start(): void {
    if (this.running) {
      console.warn('Chaos Maker is already running. Call stop() first.');
      return;
    }
    const target = this.target;
    const activeInstance = getActiveRuntimeInstance(target);
    if (activeInstance && activeInstance !== this) {
      this.emitInvariant('engine:start', 'active-instance-conflict');
      throw new Error('[chaos-maker] target already has an active runtime instance');
    }
    this.emitStartInvariantDiagnostics(target);
    // Reset per-run state so counting rules (onNth / everyNth / afterN)
    // restart from request 1 on every start()  -  not just on first construction.
    this.requestCounters.clear();
    this.running = true;
    console.log('🛠️ Chaos Maker ENGAGED 🛠️');
    this.emitter.debug('lifecycle', { phase: 'engine:start' });

    try {
      if (this.config.network) {
        if (typeof target.fetch === 'function') {
          this.originalFetch = target.fetch;
          target.fetch = markRuntimePatch(
            patchFetch(this.originalFetch.bind(target), this.config.network, this.random, this.emitter, this.requestCounters, this.groups),
            'fetch',
          );
        }

        if (typeof target.XMLHttpRequest === 'function') {
          this.originalXhrOpen = target.XMLHttpRequest.prototype.open;
          target.XMLHttpRequest.prototype.open = markRuntimePatch(
            patchXHROpen(this.originalXhrOpen),
            'xhr-open',
          );

          if (typeof target.XMLHttpRequest.prototype.setRequestHeader === 'function') {
            this.originalXhrSetRequestHeader = target.XMLHttpRequest.prototype.setRequestHeader;
            target.XMLHttpRequest.prototype.setRequestHeader =
              patchXHRSetRequestHeader(this.originalXhrSetRequestHeader);
          }

          this.originalXhrSend = target.XMLHttpRequest.prototype.send;
          target.XMLHttpRequest.prototype.send = markRuntimePatch(
            patchXHR(this.originalXhrSend, this.config.network, this.random, this.emitter, this.requestCounters, this.groups),
            'xhr-send',
          );
        }
      }

      if (this.config.ui) {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
          console.warn('Chaos Maker: UI config ignored - no DOM available in current context.');
        } else {
          this.domObserver = attachDomAssailant(this.config.ui, this.random, this.emitter, this.groups);
          this.domObserver.observe(document.body, {
            childList: true,
            subtree: true,
          });
          console.log('UI Assailant is now observing the DOM.');
        }
      }

      if (this.config.websocket && typeof target.WebSocket !== 'undefined') {
        this.originalWebSocket = target.WebSocket;
        this.webSocketHandle = patchWebSocket(
          this.originalWebSocket,
          this.config.websocket,
          this.emitter,
          this.random,
          this.requestCounters,
          this.groups,
        );
        target.WebSocket = markRuntimePatch(this.webSocketHandle.Wrapped, 'websocket');
      }

      if (this.config.sse && typeof target.EventSource !== 'undefined') {
        this.originalEventSource = target.EventSource;
        this.eventSourceHandle = patchEventSource(
          this.originalEventSource as unknown as EventSourceLikeStatic,
          this.config.sse,
          this.emitter,
          this.random,
          this.requestCounters,
          this.groups,
        );
        target.EventSource = markRuntimePatch(this.eventSourceHandle.Wrapped, 'eventsource');
      }

      setActiveRuntimeInstance(target, this);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  public stop(): void {
    this.running = false;
    console.log('🛑 Chaos Maker DISENGAGED 🛑');
    this.emitter.debug('lifecycle', { phase: 'engine:stop' });

    const target = this.target;

    const originalFetch = this.originalFetch;
    const originalXhrOpen = this.originalXhrOpen;
    const originalXhrSend = this.originalXhrSend;
    const originalXhrSetRequestHeader = this.originalXhrSetRequestHeader;
    const domObserver = this.domObserver;
    const originalWebSocket = this.originalWebSocket;
    const webSocketHandle = this.webSocketHandle;
    const originalEventSource = this.originalEventSource;
    const eventSourceHandle = this.eventSourceHandle;

    this.originalFetch = undefined;
    this.originalXhrOpen = undefined;
    this.originalXhrSend = undefined;
    this.originalXhrSetRequestHeader = undefined;
    this.domObserver = undefined;
    this.originalWebSocket = undefined;
    this.webSocketHandle = undefined;
    this.originalEventSource = undefined;
    this.eventSourceHandle = undefined;

    if (originalFetch) {
      this.runCleanupStep('restore-fetch', () => {
        target.fetch = originalFetch;
      });
    }
    if (originalXhrSend && typeof target.XMLHttpRequest === 'function') {
      this.runCleanupStep('restore-xhr-send', () => {
        target.XMLHttpRequest.prototype.send = originalXhrSend;
      });
    }
    if (originalXhrSetRequestHeader && typeof target.XMLHttpRequest === 'function') {
      this.runCleanupStep('restore-xhr-set-request-header', () => {
        target.XMLHttpRequest.prototype.setRequestHeader = originalXhrSetRequestHeader;
      });
    }
    if (originalXhrOpen && typeof target.XMLHttpRequest === 'function') {
      this.runCleanupStep('restore-xhr-open', () => {
        target.XMLHttpRequest.prototype.open = originalXhrOpen;
      });
    }
    if (domObserver) {
      this.runCleanupStep('disconnect-dom-observer', () => {
        domObserver.disconnect();
        console.log('UI Assailant has stopped observing.');
      });
    }
    if (webSocketHandle) {
      this.runCleanupStep('uninstall-websocket', () => {
        webSocketHandle.uninstall();
      });
    }
    if (originalWebSocket) {
      this.runCleanupStep('restore-websocket', () => {
        target.WebSocket = originalWebSocket;
      });
    }
    if (eventSourceHandle) {
      this.runCleanupStep('uninstall-eventsource', () => {
        eventSourceHandle.uninstall();
      });
    }
    if (originalEventSource) {
      this.runCleanupStep('restore-eventsource', () => {
        target.EventSource = originalEventSource;
      });
    }
    this.requestCounters.clear();
    clearActiveRuntimeInstance(target, this);
    this.emitStopInvariantDiagnostics(target);
  }
}
