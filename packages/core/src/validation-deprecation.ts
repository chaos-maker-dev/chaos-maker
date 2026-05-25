import type { ChaosConfig } from './config';
import type { DeprecationEntry, ValidationIssue } from './validation-types';

/** Empty for v0.5.0  -  rails only. First real deprecation lands in v0.5.x by
 *  adding an entry here keyed by a dot-notation path the walker can detect.
 *  Top-level paths only for now (e.g. `'someTopLevelField'`). */
export const DEPRECATED_FIELDS: Map<string, DeprecationEntry> = new Map();

export function checkDeprecations(
  config: ChaosConfig,
  onDeprecation?: (issue: ValidationIssue) => void,
): void {
  if (DEPRECATED_FIELDS.size === 0) return;
  const cfg = config as Record<string, unknown>;
  for (const [path, entry] of DEPRECATED_FIELDS) {
    if (cfg[path] === undefined) continue;
    const issue: ValidationIssue = {
      path,
      code: 'deprecated',
      ruleType: 'top-level',
      message: entry.message,
    };
    if (onDeprecation) onDeprecation(issue);
    try {
      console.warn(`[chaos-maker] deprecated: ${path}  -  ${entry.message}`);
    } catch {
      /* console may be unavailable in some sandboxes */
    }
  }
}
