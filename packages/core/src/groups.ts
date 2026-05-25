/**
 * Rule Groups  -  bulk runtime enable/disable for chaos rules.
 *
 * A `RuleGroupRegistry` tracks named groups (default-on) and answers
 * `isActive(name)` from interceptors before they apply chaos. Groups not
 * declared up-front are auto-registered the first time they are referenced
 * (typo surfacing  -  appears in `list()` / `getSnapshot()`).
 *
 * Toggle is runtime-only: there is no engine restart, so `requestCounters`
 * survive across `setEnabled()` calls.
 */

/** Name of the implicit group all rules without an explicit `group` belong to. */
export const DEFAULT_GROUP_NAME = 'default';

/** Public, declarative form accepted on `ChaosConfig.groups`. */
export interface RuleGroupConfig {
  name: string;
  enabled?: boolean;
}

/** Snapshot record describing a group inside the registry. */
export interface RuleGroup {
  readonly name: string;
  enabled: boolean;
  /** True when registered via `ChaosConfig.groups` or `createGroup()`. False when auto-registered from `isActive()`. */
  explicit: boolean;
}

export class RuleGroupRegistry {
  private groups = new Map<string, RuleGroup>();
  /**
   * Tracks groups that have already emitted a `rule-group:gated` event since
   * the last toggle. Cleared on every `setEnabled()` so the next toggle cycle
   * gets a fresh diagnostic event without flooding.
   */
  private gatedEmitted = new Set<string>();

  /**
   * Look up an existing group or create a new one.
   *
   * - Implicit (auto-create from `isActive`): `explicit: false`, defaults
   *   `enabled: true`.
   * - Explicit (`ChaosConfig.groups` / `createGroup()`): `explicit: true`.
   *   When called with both `explicit: true` and `enabled` set, the existing
   *   group's `enabled` is overwritten; the explicit form is the source of truth.
   */
  ensure(name: string, opts?: { enabled?: boolean; explicit?: boolean }): RuleGroup {
    const existing = this.groups.get(name);
    if (existing) {
      if (opts?.explicit) {
        existing.explicit = true;
      }
      if (opts?.enabled !== undefined) {
        existing.enabled = opts.enabled;
      }
      return existing;
    }
    const g: RuleGroup = {
      name,
      enabled: opts?.enabled ?? true,
      explicit: opts?.explicit ?? false,
    };
    this.groups.set(name, g);
    return g;
  }

  setEnabled(name: string, enabled: boolean): void {
    this.ensure(name).enabled = enabled;
    this.gatedEmitted.clear();
  }

  /**
   * Auto-creates unknown groups on first check (implicit). Rationale:
   * silently returning `true` for unknown names lets typos like
   * `group: 'paymets'` mask chaos as if no group existed; auto-registering
   * surfaces the typo via `list()` / `getSnapshot()` and keeps default-on
   * backward compat.
   */
  isActive(name: string | undefined): boolean {
    return this.ensure(name ?? DEFAULT_GROUP_NAME).enabled;
  }

  /** True when this group should emit a `rule-group:gated` event right now (first block since last toggle). */
  shouldEmitGated(name: string): boolean {
    if (this.gatedEmitted.has(name)) return false;
    this.gatedEmitted.add(name);
    return true;
  }

  has(name: string): boolean {
    return this.groups.has(name);
  }

  /**
   * Remove a group from the registry.
   * - `'default'` cannot be removed (returns `false`).
   * - By default, throws when any rule in `referencedBy` still uses the group.
   * - Pass `{ force: true }` to remove anyway. Subsequent `isActive(name)`
   *   calls auto-recreate the group (default-on).
   */
  remove(name: string, referencedBy: ReadonlySet<string>, opts?: { force?: boolean }): boolean {
    if (name === DEFAULT_GROUP_NAME) return false;
    if (!opts?.force && referencedBy.has(name)) {
      throw new Error(
        `[chaos-maker] Cannot remove group '${name}': still referenced by one or more rules. Pass { force: true } to override.`,
      );
    }
    const removed = this.groups.delete(name);
    if (removed) {
      this.gatedEmitted.delete(name);
    }
    return removed;
  }

  list(): RuleGroup[] {
    return [...this.groups.values()].map(
      g => ({ ...g })
    );
  }

  getSnapshot(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const g of this.groups.values()) out[g.name] = g.enabled;
    return out;
  }
}
